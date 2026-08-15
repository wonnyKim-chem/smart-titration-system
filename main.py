from __future__ import annotations

import asyncio
import csv
import importlib
import io
import os
import re
import socket
import ssl
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import quote

import numpy as np
import qrcode
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from scipy.signal import find_peaks, savgol_filter

from certificate_manager import ensure_short_lived_server_certificate
from experiment_store import ExperimentStore, normalise_title


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
MAX_STREAM_SIZE = 20_000
SYNC_TOLERANCE_MS = 1_500
MAX_RECORDING_BYTES = 1_500 * 1024 * 1024
RECORDING_NAME_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")

Channel = Literal["burette", "ph", "temperature", "color"]

CHANNEL_FIELDS: dict[Channel, tuple[str, ...]] = {
    "burette": ("volume",),
    "ph": ("ph",),
    "temperature": ("temperature",),
    "color": ("red", "green", "blue", "hue", "saturation", "lightness", "deltaColor"),
}
AVERAGING_BUCKET_MS = 500


class MeasurementHub:
    """두 측정 스트림을 수집하고 분석 결과를 배포한다."""

    def __init__(self, experiment_store: ExperimentStore) -> None:
        self.experiment_store = experiment_store
        self.active_experiment: dict[str, Any] | None = None
        self.streams: dict[Channel, deque[dict[str, Any]]] = {
            channel: deque(maxlen=MAX_STREAM_SIZE) for channel in CHANNEL_FIELDS
        }
        self.seen_ids: dict[Channel, set[str]] = {channel: set() for channel in CHANNEL_FIELDS}
        self.measurement_clients: dict[Channel, set[WebSocket]] = {
            channel: set() for channel in CHANNEL_FIELDS
        }
        self.dashboard_clients: set[WebSocket] = set()
        self.lock = asyncio.Lock()
        self.latest_analysis = self._empty_analysis()

    def select_experiment(self, experiment: dict[str, Any]) -> None:
        """활성 실험의 원본 스트림과 분석 상태를 메모리에 복원한다."""
        self.active_experiment = experiment
        self.experiment_store.active_id = str(experiment["id"])
        for channel in CHANNEL_FIELDS:
            records = list(experiment.get("streams", {}).get(channel, []))[-MAX_STREAM_SIZE:]
            self.streams[channel] = deque(records, maxlen=MAX_STREAM_SIZE)
            self.seen_ids[channel] = {str(record["id"]) for record in records}
        self.latest_analysis = analyse_streams(
            list(self.streams["burette"]),
            list(self.streams["ph"]),
            list(self.streams["temperature"]),
            list(self.streams["color"]),
        )

    def persist_active_experiment(self) -> None:
        if not self.active_experiment:
            return
        self.active_experiment["streams"] = {
            channel: list(self.streams[channel]) for channel in CHANNEL_FIELDS
        }
        self.experiment_store.save(self.active_experiment)

    @staticmethod
    def _empty_analysis() -> dict[str, Any]:
        return {
            "volume": [],
            "ph": [],
            "smoothedPh": [],
            "firstDerivative": [],
            "secondDerivative": [],
            "equivalenceVolume": None,
            "equivalencePh": None,
            "matchedCount": 0,
            "temperatureVolume": [],
            "temperature": [],
            "temperaturePeakVolume": None,
            "temperaturePeak": None,
            "colorVolume": [],
            "deltaColor": [],
            "colorEndpointVolume": None,
            "colorEndpointDelta": None,
            "clientCounts": {channel: 0 for channel in CHANNEL_FIELDS},
            "sensorWarnings": [],
        }

    @staticmethod
    def _normalise_record(channel: Channel, record: dict[str, Any]) -> dict[str, Any]:
        record_id = str(record.get("id", "")).strip()
        if not record_id:
            raise ValueError("측정값 id가 필요합니다.")

        timestamp = float(record["timestamp"])
        values = {field: float(record[field]) for field in CHANNEL_FIELDS[channel]}
        if not np.isfinite(timestamp) or not all(np.isfinite(value) for value in values.values()):
            raise ValueError("측정값은 유한한 숫자여야 합니다.")
        if channel == "ph" and not 0 <= values["ph"] <= 14.5:
            raise ValueError("pH 값이 허용 범위를 벗어났습니다.")
        if channel == "temperature" and not -100 <= values["temperature"] <= 300:
            raise ValueError("온도 값이 허용 범위를 벗어났습니다.")
        if channel == "color" and not all(0 <= values[field] <= 255 for field in ("red", "green", "blue")):
            raise ValueError("RGB 값이 허용 범위를 벗어났습니다.")

        return {
            "id": record_id,
            "clientId": str(record.get("clientId", "legacy-client"))[:120],
            "timestamp": timestamp,
            **values,
        }

    async def ingest(
        self, channel: Channel, records: list[dict[str, Any]]
    ) -> tuple[list[str], list[dict[str, str]]]:
        accepted_ids: list[str] = []
        rejected: list[dict[str, str]] = []
        normalised_records: list[dict[str, Any]] = []
        for raw_record in records:
            try:
                normalised_records.append(self._normalise_record(channel, raw_record))
            except (KeyError, TypeError, ValueError) as error:
                rejected.append(
                    {"id": str(raw_record.get("id", "")), "reason": str(error)}
                )

        recording_summaries = self.experiment_store.recording_experiments()
        if not recording_summaries:
            rejected.extend(
                {
                    "id": str(record.get("id", "")),
                    "reason": "대시보드에서 실험 데이터 입력을 시작하세요.",
                }
                for record in normalised_records
            )
            return [], rejected

        async with self.lock:
            active_updated = False
            for summary in recording_summaries:
                experiment_id = str(summary["id"])
                if self.active_experiment and self.active_experiment.get("id") == experiment_id:
                    for record in normalised_records:
                        record_id = str(record["id"])
                        if record_id in self.seen_ids[channel]:
                            continue
                        if len(self.streams[channel]) == MAX_STREAM_SIZE:
                            expired = self.streams[channel].popleft()
                            self.seen_ids[channel].discard(str(expired["id"]))
                        self.streams[channel].append(record)
                        self.seen_ids[channel].add(record_id)
                    self.persist_active_experiment()
                    active_updated = True
                    continue

                experiment = self.experiment_store.load(experiment_id)
                target = experiment["streams"][channel]
                seen = {str(item["id"]) for item in target}
                for record in normalised_records:
                    if str(record["id"]) not in seen:
                        target.append(record)
                        seen.add(str(record["id"]))
                if len(target) > MAX_STREAM_SIZE:
                    experiment["streams"][channel] = target[-MAX_STREAM_SIZE:]
                self.experiment_store.save(experiment)

            accepted_ids = [str(record["id"]) for record in normalised_records]
            if active_updated:
                self.latest_analysis = analyse_streams(
                    list(self.streams["burette"]),
                    list(self.streams["ph"]),
                    list(self.streams["temperature"]),
                    list(self.streams["color"]),
                )
            snapshot = self.snapshot()

        await self.broadcast(snapshot)
        return accepted_ids, rejected

    def snapshot(self) -> dict[str, Any]:
        experiment = None
        if self.active_experiment:
            experiment = {
                key: self.active_experiment.get(key)
                for key in (
                    "id",
                    "title",
                    "status",
                    "createdAt",
                    "updatedAt",
                    "startedAt",
                    "stoppedAt",
                )
            }
        return {
            "type": "analysis",
            "serverTimestamp": int(time.time() * 1000),
            "experiment": experiment,
            "recordingExperiments": self.experiment_store.recording_experiments(),
            "streamCounts": {
                channel: len(self.streams[channel]) for channel in CHANNEL_FIELDS
            },
            **self.latest_analysis,
        }

    async def register_dashboard(self, websocket: WebSocket) -> None:
        self.dashboard_clients.add(websocket)
        await websocket.send_json(self.snapshot())

    def unregister_dashboard(self, websocket: WebSocket) -> None:
        self.dashboard_clients.discard(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        disconnected: list[WebSocket] = []
        for websocket in tuple(self.dashboard_clients):
            try:
                await websocket.send_json(payload)
            except (RuntimeError, WebSocketDisconnect):
                disconnected.append(websocket)
        for websocket in disconnected:
            self.unregister_dashboard(websocket)

    async def broadcast_recording_status(self) -> None:
        """모든 측정 카메라에 현재 입력 중 실험 제목을 알린다."""
        payload = {
            "type": "experiment-status",
            "experiments": self.experiment_store.recording_experiments(),
        }
        disconnected: list[tuple[Channel, WebSocket]] = []
        for channel, clients in self.measurement_clients.items():
            for websocket in tuple(clients):
                try:
                    await websocket.send_json(payload)
                except (RuntimeError, WebSocketDisconnect):
                    disconnected.append((channel, websocket))
        for channel, websocket in disconnected:
            self.measurement_clients[channel].discard(websocket)


def match_by_timestamp(
    volume_records: list[dict[str, Any]], ph_records: list[dict[str, Any]]
) -> tuple[np.ndarray, np.ndarray]:
    """각 pH 시각과 가장 가까운 부피 측정값을 허용 오차 안에서 연결한다."""
    if not volume_records or not ph_records:
        return np.array([], dtype=float), np.array([], dtype=float)

    volumes_sorted = sorted(volume_records, key=lambda item: item["timestamp"])
    ph_sorted = sorted(ph_records, key=lambda item: item["timestamp"])
    volume_times = np.asarray(
        [item["timestamp"] for item in volumes_sorted], dtype=float
    )

    paired_volumes: list[float] = []
    paired_ph: list[float] = []
    for ph_record in ph_sorted:
        timestamp = ph_record["timestamp"]
        insertion = int(np.searchsorted(volume_times, timestamp))
        candidates = [index for index in (insertion - 1, insertion) if 0 <= index < len(volume_times)]
        if not candidates:
            continue
        closest = min(candidates, key=lambda index: abs(volume_times[index] - timestamp))
        if abs(volume_times[closest] - timestamp) <= SYNC_TOLERANCE_MS:
            paired_volumes.append(float(volumes_sorted[closest]["volume"]))
            paired_ph.append(float(ph_record["ph"]))

    return np.asarray(paired_volumes), np.asarray(paired_ph)


def average_clients_by_time(
    records: list[dict[str, Any]], fields: tuple[str, ...], bucket_ms: int = AVERAGING_BUCKET_MS
) -> list[dict[str, Any]]:
    """시간 구간마다 각 클라이언트를 동일 가중치로 평균한다."""
    if not records:
        return []

    client_buckets: dict[tuple[int, str], list[dict[str, Any]]] = {}
    for record in records:
        bucket = int(float(record["timestamp"]) // bucket_ms)
        client_id = str(record.get("clientId", "legacy-client"))
        client_buckets.setdefault((bucket, client_id), []).append(record)

    per_client: dict[int, list[dict[str, float]]] = {}
    for (bucket, _), items in client_buckets.items():
        averaged = {
            "timestamp": float(np.mean([float(item["timestamp"]) for item in items])),
            **{
                field: float(np.mean([float(item[field]) for item in items]))
                for field in fields
            },
        }
        per_client.setdefault(bucket, []).append(averaged)

    result: list[dict[str, Any]] = []
    for bucket in sorted(per_client):
        client_values = per_client[bucket]
        result.append(
            {
                "timestamp": float(np.mean([item["timestamp"] for item in client_values])),
                "clientCount": len(client_values),
                **{
                    field: float(np.mean([item[field] for item in client_values]))
                    for field in fields
                },
                "spread": {
                    field: float(np.ptp([item[field] for item in client_values]))
                    for field in fields
                },
            }
        )
    return result


def match_field_to_volume(
    volume_records: list[dict[str, Any]], value_records: list[dict[str, Any]], field: str
) -> tuple[np.ndarray, np.ndarray]:
    return match_by_timestamp(
        volume_records,
        [{"timestamp": record["timestamp"], "ph": record[field]} for record in value_records],
    )


def analyse_streams(
    volume_records: list[dict[str, Any]],
    ph_records: list[dict[str, Any]],
    temperature_records: list[dict[str, Any]] | None = None,
    color_records: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """클라이언트 평균 곡선에서 당량점, 온도 최고점과 색 종말점을 찾는다."""
    averaged_volume = average_clients_by_time(volume_records, ("volume",))
    averaged_ph = average_clients_by_time(ph_records, ("ph",))
    averaged_temperature = average_clients_by_time(temperature_records or [], ("temperature",))
    averaged_color = average_clients_by_time(color_records or [], CHANNEL_FIELDS["color"])
    result = MeasurementHub._empty_analysis()
    result["clientCounts"] = {
        "burette": max((record["clientCount"] for record in averaged_volume), default=0),
        "ph": max((record["clientCount"] for record in averaged_ph), default=0),
        "temperature": max((record["clientCount"] for record in averaged_temperature), default=0),
        "color": max((record["clientCount"] for record in averaged_color), default=0),
    }
    warnings: list[str] = []
    if any(record["spread"]["volume"] > 0.15 for record in averaged_volume):
        warnings.append("뷰렛 클라이언트 간 부피 차이가 0.15 mL를 넘었습니다.")
    if any(record["spread"]["ph"] > 0.15 for record in averaged_ph):
        warnings.append("pH 클라이언트 간 차이가 0.15를 넘었습니다.")
    if any(record["spread"]["temperature"] > 1.0 for record in averaged_temperature):
        warnings.append("온도 클라이언트 간 차이가 1.0 °C를 넘었습니다.")
    result["sensorWarnings"] = warnings

    temperature_volume, temperature_values = match_field_to_volume(
        averaged_volume, averaged_temperature, "temperature"
    )
    if temperature_volume.size:
        order = np.argsort(temperature_volume)
        temperature_volume = temperature_volume[order]
        temperature_values = temperature_values[order]
        if temperature_values.size >= 5:
            window = min(9, int(temperature_values.size))
            if window % 2 == 0:
                window -= 1
            temperature_values = savgol_filter(temperature_values, window, min(2, window - 1))
        peak_index = int(np.argmax(temperature_values))
        result.update(
            {
                "temperatureVolume": temperature_volume.round(4).tolist(),
                "temperature": temperature_values.round(3).tolist(),
                "temperaturePeakVolume": round(float(temperature_volume[peak_index]), 4),
                "temperaturePeak": round(float(temperature_values[peak_index]), 3),
            }
        )

    color_volume, delta_color = match_field_to_volume(averaged_volume, averaged_color, "deltaColor")
    if color_volume.size:
        order = np.argsort(color_volume)
        color_volume = color_volume[order]
        delta_color = delta_color[order]
        if delta_color.size >= 5:
            window = min(9, int(delta_color.size))
            if window % 2 == 0:
                window -= 1
            delta_color = savgol_filter(delta_color, window, min(2, window - 1))
            endpoint_index = int(np.argmax(np.abs(np.gradient(delta_color, color_volume))))
        else:
            endpoint_index = int(np.argmax(delta_color))
        result.update(
            {
                "colorVolume": color_volume.round(4).tolist(),
                "deltaColor": delta_color.round(3).tolist(),
                "colorEndpointVolume": round(float(color_volume[endpoint_index]), 4),
                "colorEndpointDelta": round(float(delta_color[endpoint_index]), 3),
            }
        )

    paired_volume, paired_ph = match_by_timestamp(averaged_volume, averaged_ph)
    if paired_volume.size == 0:
        return result

    order = np.argsort(paired_volume)
    paired_volume = paired_volume[order]
    paired_ph = paired_ph[order]

    # 같은 부피에 여러 pH 값이 있으면 평균하여 0으로 나누는 미분을 방지한다.
    unique_volume, inverse = np.unique(paired_volume, return_inverse=True)
    ph_sum = np.zeros_like(unique_volume, dtype=float)
    ph_count = np.zeros_like(unique_volume, dtype=float)
    np.add.at(ph_sum, inverse, paired_ph)
    np.add.at(ph_count, inverse, 1)
    unique_ph = ph_sum / ph_count

    result["volume"] = unique_volume.round(4).tolist()
    result["ph"] = unique_ph.round(4).tolist()
    result["matchedCount"] = int(paired_volume.size)
    if unique_volume.size < 5:
        result["smoothedPh"] = result["ph"]
        return result

    window_length = min(11, int(unique_volume.size))
    if window_length % 2 == 0:
        window_length -= 1
    polynomial_order = min(3, window_length - 1)
    smoothed_ph = savgol_filter(unique_ph, window_length, polynomial_order)
    first_derivative = np.gradient(smoothed_ph, unique_volume)
    second_derivative = np.gradient(first_derivative, unique_volume)

    prominence = max(float(np.ptp(first_derivative)) * 0.08, 0.02)
    peaks, _ = find_peaks(
        first_derivative,
        prominence=prominence,
        distance=max(1, unique_volume.size // 20),
    )
    if peaks.size:
        equivalence_index = int(peaks[np.argmax(first_derivative[peaks])])
    else:
        equivalence_index = int(np.argmax(first_derivative))

    result.update(
        {
            "smoothedPh": smoothed_ph.round(4).tolist(),
            "firstDerivative": first_derivative.round(4).tolist(),
            "secondDerivative": second_derivative.round(4).tolist(),
            "equivalenceVolume": round(float(unique_volume[equivalence_index]), 4),
            "equivalencePh": round(float(smoothed_ph[equivalence_index]), 4),
        }
    )
    return result


EXPORT_COLUMNS = (
    ("volume_mL", "부피 (mL)"),
    ("ph", "pH"),
    ("smoothedPh", "평활 pH"),
    ("firstDerivative", "dpH/dV"),
    ("secondDerivative", "d²pH/dV²"),
    ("temperature", "온도 (°C)"),
    ("deltaColor", "Δ색"),
)


def analyse_experiment(experiment: dict[str, Any]) -> dict[str, Any]:
    streams = experiment.get("streams", {})
    return analyse_streams(
        list(streams.get("burette", [])),
        list(streams.get("ph", [])),
        list(streams.get("temperature", [])),
        list(streams.get("color", [])),
    )


def _interpolate_at(target: float, x_values: list[float], y_values: list[float]) -> float | None:
    if not x_values or not y_values or len(x_values) != len(y_values):
        return None
    x = np.asarray(x_values, dtype=float)
    y = np.asarray(y_values, dtype=float)
    order = np.argsort(x)
    x = x[order]
    y = y[order]
    unique_x, inverse = np.unique(x, return_inverse=True)
    unique_y = np.zeros_like(unique_x)
    counts = np.zeros_like(unique_x)
    np.add.at(unique_y, inverse, y)
    np.add.at(counts, inverse, 1)
    unique_y /= counts
    if target < unique_x[0] or target > unique_x[-1]:
        return None
    if unique_x.size == 1:
        return float(unique_y[0]) if np.isclose(target, unique_x[0]) else None
    return float(np.interp(target, unique_x, unique_y))


def build_export_rows(analysis: dict[str, Any]) -> list[dict[str, float | None]]:
    """모든 부피 기반 분석값을 하나의 부피 축에 보간해 표로 만든다."""
    volume_axis = sorted(
        {
            float(value)
            for key in ("volume", "temperatureVolume", "colorVolume")
            for value in analysis.get(key, [])
        }
    )
    rows: list[dict[str, float | None]] = []
    for volume in volume_axis:
        rows.append(
            {
                "volume_mL": volume,
                "ph": _interpolate_at(volume, analysis.get("volume", []), analysis.get("ph", [])),
                "smoothedPh": _interpolate_at(
                    volume, analysis.get("volume", []), analysis.get("smoothedPh", [])
                ),
                "firstDerivative": _interpolate_at(
                    volume, analysis.get("volume", []), analysis.get("firstDerivative", [])
                ),
                "secondDerivative": _interpolate_at(
                    volume, analysis.get("volume", []), analysis.get("secondDerivative", [])
                ),
                "temperature": _interpolate_at(
                    volume,
                    analysis.get("temperatureVolume", []),
                    analysis.get("temperature", []),
                ),
                "deltaColor": _interpolate_at(
                    volume, analysis.get("colorVolume", []), analysis.get("deltaColor", [])
                ),
            }
        )
    return rows


def build_csv_bytes(analysis: dict[str, Any]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=[key for key, _ in EXPORT_COLUMNS])
    writer.writerow({key: label for key, label in EXPORT_COLUMNS})
    for row in build_export_rows(analysis):
        writer.writerow({key: "" if row[key] is None else row[key] for key, _ in EXPORT_COLUMNS})
    return output.getvalue().encode("utf-8-sig")


def build_xlsx_bytes(experiment: dict[str, Any], analysis: dict[str, Any]) -> bytes:
    openpyxl = importlib.import_module("openpyxl")
    styles = importlib.import_module("openpyxl.styles")
    workbook = openpyxl.Workbook()
    data_sheet = workbook.active
    data_sheet.title = "분석 데이터"
    data_sheet.append([label for _, label in EXPORT_COLUMNS])
    for cell in data_sheet[1]:
        cell.font = styles.Font(bold=True)
    for row in build_export_rows(analysis):
        data_sheet.append([row[key] for key, _ in EXPORT_COLUMNS])
    data_sheet.freeze_panes = "A2"
    for column in data_sheet.columns:
        data_sheet.column_dimensions[column[0].column_letter].width = 16

    summary = workbook.create_sheet("실험 요약")
    summary.append(["항목", "값"])
    summary.append(["실험 제목", experiment.get("title")])
    summary.append(["생성 시각 (Unix ms)", experiment.get("createdAt")])
    summary.append(["pH 당량점 부피 (mL)", analysis.get("equivalenceVolume")])
    summary.append(["당량점 pH", analysis.get("equivalencePh")])
    summary.append(["온도 최고점 부피 (mL)", analysis.get("temperaturePeakVolume")])
    summary.append(["최고 온도 (°C)", analysis.get("temperaturePeak")])
    summary.append(["지시약 색 종말점 부피 (mL)", analysis.get("colorEndpointVolume")])
    summary.append(["종말점 Δ색", analysis.get("colorEndpointDelta")])
    for cell in summary[1]:
        cell.font = styles.Font(bold=True)
    summary.column_dimensions["A"].width = 28
    summary.column_dimensions["B"].width = 32

    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def get_recordings_directory() -> Path:
    """사용자별 녹화 파일 저장 폴더를 반환한다."""
    local_app_data = Path(os.getenv("LOCALAPPDATA", BASE_DIR))
    directory = local_app_data / "SmartTitration" / "recordings"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def safe_recording_name(name: str, channel: str, content_type: str) -> str:
    """클라이언트 파일명을 안전한 녹화 파일명으로 정규화한다."""
    extension = ".mp4" if "mp4" in content_type.lower() else ".webm"
    stem = Path(name).stem[:80] if name else "recording"
    safe_stem = RECORDING_NAME_PATTERN.sub("-", stem).strip("-._") or "recording"
    safe_channel = channel if channel in ("burette", "ph") else "camera"
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    unique_suffix = uuid.uuid4().hex[:6]
    return f"{safe_channel}-{timestamp}-{safe_stem}-{unique_suffix}{extension}"


experiment_store = ExperimentStore(CHANNEL_FIELDS)
experiment_store.recover_interrupted_experiments()
hub = MeasurementHub(experiment_store)
app = FastAPI(title="Smart Titration Curve Analysis System", version="1.0.0")

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def add_browser_security_headers(request: Request, call_next: Any) -> Any:
    response = await call_next(request)
    response.headers["Permissions-Policy"] = "camera=(self), microphone=()"
    return response


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "timestamp": int(time.time() * 1000)})


@app.get("/api/experiments")
async def list_experiments() -> JSONResponse:
    return JSONResponse(
        {
            "activeId": experiment_store.active_id,
            "experiments": experiment_store.list(),
        }
    )


@app.post("/api/experiments")
async def create_experiment(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except (ValueError, TypeError):
        return JSONResponse({"message": "실험 제목을 입력하세요."}, status_code=400)
    recording_experiments = experiment_store.recording_experiments()
    recording_action = str(payload.get("recordingAction", ""))
    if recording_experiments:
        if recording_action not in ("stop", "continue"):
            return JSONResponse(
                {
                    "message": "입력 중인 실험을 중지할지, 함께 계속 입력할지 선택하세요.",
                    "code": "recording-experiments-active",
                },
                status_code=409,
            )
        if recording_action == "stop":
            for summary in recording_experiments:
                running_experiment = experiment_store.load(str(summary["id"]))
                experiment_store.set_status(running_experiment, "stopped")
                if hub.active_experiment and hub.active_experiment.get("id") == summary["id"]:
                    hub.active_experiment["status"] = "stopped"
    try:
        experiment = experiment_store.create(
            str(payload.get("title", "")),
            ensure_unique=recording_action == "continue",
        )
    except (ValueError, TypeError):
        return JSONResponse({"message": "실험 제목을 입력하세요."}, status_code=400)
    if recording_action == "continue":
        experiment_store.set_status(experiment, "recording")
    hub.select_experiment(experiment)
    await hub.broadcast(hub.snapshot())
    await hub.broadcast_recording_status()
    return JSONResponse({"experiment": hub.snapshot()["experiment"]}, status_code=201)


@app.post("/api/experiments/{experiment_id}/select")
async def select_experiment(experiment_id: str, request: Request) -> JSONResponse:
    try:
        experiment = experiment_store.load(experiment_id)
    except (FileNotFoundError, ValueError):
        return JSONResponse({"message": "실험을 찾을 수 없습니다."}, status_code=404)
    hub.select_experiment(experiment)
    await hub.broadcast(hub.snapshot())
    return JSONResponse({"experiment": hub.snapshot()["experiment"]})


@app.post("/api/experiments/{experiment_id}/start")
async def start_experiment(experiment_id: str) -> JSONResponse:
    if not hub.active_experiment or hub.active_experiment.get("id") != experiment_id:
        return JSONResponse({"message": "먼저 실험을 선택하세요."}, status_code=409)
    experiment_store.set_status(hub.active_experiment, "recording")
    await hub.broadcast(hub.snapshot())
    await hub.broadcast_recording_status()
    return JSONResponse({"experiment": hub.snapshot()["experiment"]})


@app.post("/api/experiments/{experiment_id}/stop")
async def stop_experiment(experiment_id: str) -> JSONResponse:
    if not hub.active_experiment or hub.active_experiment.get("id") != experiment_id:
        return JSONResponse({"message": "현재 선택된 실험이 아닙니다."}, status_code=409)
    experiment_store.set_status(hub.active_experiment, "stopped")
    hub.persist_active_experiment()
    await hub.broadcast(hub.snapshot())
    await hub.broadcast_recording_status()
    return JSONResponse({"experiment": hub.snapshot()["experiment"]})


def _load_experiment_for_export(experiment_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if hub.active_experiment and hub.active_experiment.get("id") == experiment_id:
        hub.persist_active_experiment()
        experiment = hub.active_experiment
        analysis = hub.latest_analysis
    else:
        experiment = experiment_store.load(experiment_id)
        analysis = analyse_experiment(experiment)
    return experiment, analysis


@app.get("/api/experiments/{experiment_id}/export.csv")
async def export_experiment_csv(experiment_id: str) -> Any:
    try:
        experiment, analysis = _load_experiment_for_export(experiment_id)
    except (FileNotFoundError, ValueError):
        return JSONResponse({"message": "실험을 찾을 수 없습니다."}, status_code=404)
    filename = f"{normalise_title(str(experiment['title']))}.csv"
    return StreamingResponse(
        io.BytesIO(build_csv_bytes(analysis)),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@app.get("/api/experiments/{experiment_id}/export.xlsx")
async def export_experiment_xlsx(experiment_id: str) -> Any:
    try:
        experiment, analysis = _load_experiment_for_export(experiment_id)
    except (FileNotFoundError, ValueError):
        return JSONResponse({"message": "실험을 찾을 수 없습니다."}, status_code=404)
    filename = f"{normalise_title(str(experiment['title']))}.xlsx"
    return StreamingResponse(
        io.BytesIO(build_xlsx_bytes(experiment, analysis)),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@app.post("/api/recordings")
async def upload_recording(request: Request) -> JSONResponse:
    """브라우저 녹화 파일을 메모리에 적재하지 않고 서버 디스크로 저장한다."""
    content_type = request.headers.get("content-type", "video/webm").split(";", 1)[0]
    if content_type not in ("video/webm", "video/mp4"):
        return JSONResponse({"message": "지원하지 않는 녹화 형식입니다."}, status_code=415)

    channel = request.headers.get("x-recording-channel", "camera")
    requested_name = request.headers.get("x-recording-filename", "recording")
    filename = safe_recording_name(requested_name, channel, content_type)
    destination = get_recordings_directory() / filename
    temporary = destination.with_suffix(destination.suffix + ".part")
    received_bytes = 0

    try:
        with temporary.open("wb") as output:
            async for chunk in request.stream():
                received_bytes += len(chunk)
                if received_bytes > MAX_RECORDING_BYTES:
                    raise ValueError("녹화 파일은 1.5 GB를 초과할 수 없습니다.")
                output.write(chunk)
        if received_bytes == 0:
            raise ValueError("빈 녹화 파일은 저장할 수 없습니다.")
        temporary.replace(destination)
    except ValueError as error:
        temporary.unlink(missing_ok=True)
        return JSONResponse({"message": str(error)}, status_code=413)
    except OSError:
        temporary.unlink(missing_ok=True)
        return JSONResponse({"message": "녹화 파일을 저장하지 못했습니다."}, status_code=500)

    return JSONResponse(
        {
            "filename": filename,
            "size": received_bytes,
            "downloadUrl": f"/api/recordings/{filename}",
        },
        status_code=201,
    )


@app.get("/api/recordings")
async def list_recordings() -> JSONResponse:
    recordings = [
        {
            "filename": path.name,
            "size": path.stat().st_size,
            "modifiedAt": int(path.stat().st_mtime * 1000),
            "downloadUrl": f"/api/recordings/{path.name}",
        }
        for path in get_recordings_directory().iterdir()
        if path.is_file() and path.suffix.lower() in (".webm", ".mp4")
    ]
    recordings.sort(key=lambda item: item["modifiedAt"], reverse=True)
    return JSONResponse({"recordings": recordings})


@app.get("/api/recordings/{filename}")
async def download_recording(filename: str) -> Any:
    if Path(filename).name != filename:
        return JSONResponse({"message": "잘못된 파일명입니다."}, status_code=400)
    path = get_recordings_directory() / filename
    if not path.is_file() or path.suffix.lower() not in (".webm", ".mp4"):
        return JSONResponse({"message": "녹화 파일을 찾을 수 없습니다."}, status_code=404)
    media_type = "video/mp4" if path.suffix.lower() == ".mp4" else "video/webm"
    return FileResponse(path, media_type=media_type, filename=path.name)


@app.get("/")
async def dashboard_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "dashboard.html")


@app.get("/burette")
async def burette_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "burette.html")


@app.get("/ph-meter")
async def ph_meter_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "ph-meter.html")


@app.get("/indicator")
async def indicator_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "indicator.html")


@app.websocket("/ws/dashboard")
async def dashboard_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    await hub.register_dashboard(websocket)
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong", "timestamp": int(time.time() * 1000)})
    except WebSocketDisconnect:
        hub.unregister_dashboard(websocket)


@app.websocket("/ws/{channel}")
async def measurement_socket(websocket: WebSocket, channel: str) -> None:
    if channel not in CHANNEL_FIELDS:
        await websocket.close(code=1008, reason="지원하지 않는 측정 채널입니다.")
        return

    await websocket.accept()
    typed_channel = cast(Channel, channel)
    hub.measurement_clients[typed_channel].add(websocket)
    await websocket.send_json(
        {
            "type": "experiment-status",
            "experiments": experiment_store.recording_experiments(),
        }
    )
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong", "timestamp": int(time.time() * 1000)})
                continue

            raw_records = message.get("records", [message])
            if not isinstance(raw_records, list):
                await websocket.send_json(
                    {"type": "error", "message": "records는 배열이어야 합니다."}
                )
                continue

            accepted_ids, rejected = await hub.ingest(typed_channel, raw_records)
            await websocket.send_json(
                {"type": "ack", "ids": accepted_ids, "rejected": rejected}
            )
    except WebSocketDisconnect:
        return
    finally:
        hub.measurement_clients[typed_channel].discard(websocket)


def get_local_ip() -> str:
    """외부 전송 없이 운영체제가 선택한 로컬 네트워크 주소를 구한다."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


def print_access_qr(url: str) -> None:
    """모바일 접속 주소와 터미널용 QR 코드를 출력한다."""
    print(f"\n모바일 접속 주소: {url}")
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.make(fit=True)
    qr.print_ascii(invert=True)


def get_default_certificate_paths() -> tuple[Path, Path]:
    """Windows 사용자 데이터 폴더의 기본 인증서 경로를 반환한다."""
    local_app_data = Path(os.getenv("LOCALAPPDATA", BASE_DIR))
    certificate_directory = local_app_data / "SmartTitration" / "certs"
    return (
        certificate_directory / "titration.pem",
        certificate_directory / "titration-key.pem",
    )


def resolve_tls_configuration() -> tuple[str, str]:
    """인증서 파일과 개인키를 확인하고 실제 TLS 로딩까지 검증한다."""
    configured_certificate = os.getenv("TITRATION_SSL_CERT")
    configured_private_key = os.getenv("TITRATION_SSL_KEY")
    default_certificate, default_private_key = get_default_certificate_paths()

    if configured_certificate or configured_private_key:
        if not configured_certificate or not configured_private_key:
            raise RuntimeError(
                "TITRATION_SSL_CERT와 TITRATION_SSL_KEY를 모두 설정해야 합니다."
            )
        certificate = Path(configured_certificate).expanduser()
        private_key = Path(configured_private_key).expanduser()
    else:
        certificate = default_certificate
        private_key = default_private_key

    missing_files = [
        str(path) for path in (certificate, private_key) if not path.is_file()
    ]
    if missing_files:
        missing_text = "\n  - ".join(missing_files)
        raise RuntimeError(
            "HTTPS 인증서가 없습니다. setup-ios-https.ps1을 먼저 실행하세요."
            f"\n  - {missing_text}"
        )

    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(certificate), str(private_key))
    except (OSError, ssl.SSLError) as error:
        raise RuntimeError(
            "HTTPS 인증서 또는 개인키를 읽을 수 없습니다. 인증서를 다시 생성하세요."
        ) from error

    return str(certificate), str(private_key)


def run() -> None:
    host = os.getenv("TITRATION_HOST", "0.0.0.0")
    port = int(os.getenv("TITRATION_PORT", "8000"))
    local_ip = get_local_ip()
    if not os.getenv("TITRATION_SSL_CERT") and not os.getenv("TITRATION_SSL_KEY"):
        default_certificate, default_private_key = get_default_certificate_paths()
        try:
            ensure_short_lived_server_certificate(
                local_ip, default_certificate, default_private_key
            )
        except RuntimeError as error:
            print(f"\n24시간 HTTPS 인증서를 준비하지 못했습니다.\n{error}")
    try:
        certificate, private_key = resolve_tls_configuration()
    except RuntimeError as error:
        print(f"\n서버를 시작할 수 없습니다.\n{error}")
        raise SystemExit(2) from error

    access_url = f"https://{local_ip}:{port}"
    print_access_qr(access_url)
    print(f"서버 PC에서도 실시간 데이터는 {access_url} 에서 확인하세요.\n")
    uvicorn.run(
        app,
        host=host,
        port=port,
        ssl_certfile=certificate,
        ssl_keyfile=private_key,
    )


if __name__ == "__main__":
    run()