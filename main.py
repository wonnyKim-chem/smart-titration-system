from __future__ import annotations

import asyncio
import os
import socket
import time
from collections import deque
from pathlib import Path
from typing import Any, Literal, cast

import numpy as np
import qrcode
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from scipy.signal import find_peaks, savgol_filter


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
MAX_STREAM_SIZE = 20_000
SYNC_TOLERANCE_MS = 1_500

Channel = Literal["burette", "ph"]


class MeasurementHub:
    """두 측정 스트림을 수집하고 분석 결과를 배포한다."""

    def __init__(self) -> None:
        self.streams: dict[Channel, deque[dict[str, Any]]] = {
            "burette": deque(maxlen=MAX_STREAM_SIZE),
            "ph": deque(maxlen=MAX_STREAM_SIZE),
        }
        self.seen_ids: dict[Channel, set[str]] = {"burette": set(), "ph": set()}
        self.dashboard_clients: set[WebSocket] = set()
        self.lock = asyncio.Lock()
        self.latest_analysis = self._empty_analysis()

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
        }

    @staticmethod
    def _normalise_record(channel: Channel, record: dict[str, Any]) -> dict[str, Any]:
        value_key = "volume" if channel == "burette" else "ph"
        record_id = str(record.get("id", "")).strip()
        if not record_id:
            raise ValueError("측정값 id가 필요합니다.")

        timestamp = float(record["timestamp"])
        value = float(record[value_key])
        if not np.isfinite(timestamp) or not np.isfinite(value):
            raise ValueError("측정값은 유한한 숫자여야 합니다.")
        if channel == "ph" and not 0 <= value <= 14.5:
            raise ValueError("pH 값이 허용 범위를 벗어났습니다.")

        return {"id": record_id, "timestamp": timestamp, value_key: value}

    async def ingest(
        self, channel: Channel, records: list[dict[str, Any]]
    ) -> tuple[list[str], list[dict[str, str]]]:
        accepted_ids: list[str] = []
        rejected: list[dict[str, str]] = []

        async with self.lock:
            for raw_record in records:
                try:
                    record = self._normalise_record(channel, raw_record)
                except (KeyError, TypeError, ValueError) as error:
                    rejected.append(
                        {"id": str(raw_record.get("id", "")), "reason": str(error)}
                    )
                    continue

                record_id = record["id"]
                if record_id not in self.seen_ids[channel]:
                    if len(self.streams[channel]) == MAX_STREAM_SIZE:
                        expired = self.streams[channel].popleft()
                        self.seen_ids[channel].discard(expired["id"])
                    self.streams[channel].append(record)
                    self.seen_ids[channel].add(record_id)
                accepted_ids.append(record_id)

            self.latest_analysis = analyse_streams(
                list(self.streams["burette"]), list(self.streams["ph"])
            )
            snapshot = self.snapshot()

        await self.broadcast(snapshot)
        return accepted_ids, rejected

    def snapshot(self) -> dict[str, Any]:
        return {
            "type": "analysis",
            "serverTimestamp": int(time.time() * 1000),
            "streamCounts": {
                "burette": len(self.streams["burette"]),
                "ph": len(self.streams["ph"]),
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


def analyse_streams(
    volume_records: list[dict[str, Any]], ph_records: list[dict[str, Any]]
) -> dict[str, Any]:
    """동기화된 곡선을 평활화하고 미분하여 당량점을 찾는다."""
    paired_volume, paired_ph = match_by_timestamp(volume_records, ph_records)
    if paired_volume.size == 0:
        return MeasurementHub._empty_analysis()

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

    result = MeasurementHub._empty_analysis()
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


hub = MeasurementHub()
app = FastAPI(title="Smart Titration Curve Analysis System", version="1.0.0")

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "timestamp": int(time.time() * 1000)})


@app.get("/")
async def dashboard_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "dashboard.html")


@app.get("/burette")
async def burette_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "burette.html")


@app.get("/ph-meter")
async def ph_meter_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "ph-meter.html")


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
    if channel not in ("burette", "ph"):
        await websocket.close(code=1008, reason="지원하지 않는 측정 채널입니다.")
        return

    await websocket.accept()
    typed_channel = cast(Channel, channel)
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


def run() -> None:
    host = os.getenv("TITRATION_HOST", "0.0.0.0")
    port = int(os.getenv("TITRATION_PORT", "8000"))
    certificate = os.getenv("TITRATION_SSL_CERT")
    private_key = os.getenv("TITRATION_SSL_KEY")
    scheme = "https" if certificate and private_key else "http"
    print_access_qr(f"{scheme}://{get_local_ip()}:{port}")
    uvicorn.run(
        app,
        host=host,
        port=port,
        ssl_certfile=certificate,
        ssl_keyfile=private_key,
    )


if __name__ == "__main__":
    run()