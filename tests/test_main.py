import math
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from main import (
    MAX_EXTRAPOLATION_MS,
    MAX_INTERPOLATION_GAP_MS,
    analyse_streams,
    app,
    average_clients_by_time,
    hub,
    match_by_timestamp,
    resolve_tls_configuration,
)


def test_client_averaging_gives_each_device_equal_weight() -> None:
    records = [
        {"timestamp": 1_000, "clientId": "fast", "ph": 2.0},
        {"timestamp": 1_100, "clientId": "fast", "ph": 4.0},
        {"timestamp": 1_050, "clientId": "slow", "ph": 10.0},
    ]

    averaged = average_clients_by_time(records, ("ph",))

    assert len(averaged) == 1
    assert averaged[0]["clientCount"] == 2
    assert averaged[0]["ph"] == 6.5


def test_temperature_peak_and_color_endpoint_without_ph() -> None:
    volume_axis = np.linspace(0, 10, 41)
    base_timestamp = 1_700_000_000_000
    volumes = [
        {
            "id": f"v-{index}",
            "clientId": "volume-a",
            "timestamp": base_timestamp + index * 500,
            "volume": float(volume),
        }
        for index, volume in enumerate(volume_axis)
    ]
    temperatures = [
        {
            "id": f"t-{index}",
            "clientId": "temperature-a",
            "timestamp": base_timestamp + index * 500 + 40,
            "temperature": float(30 - (volume - 5) ** 2 * 0.2),
        }
        for index, volume in enumerate(volume_axis)
    ]
    colors = [
        {
            "id": f"c-{index}",
            "clientId": "color-a",
            "timestamp": base_timestamp + index * 500 + 60,
            "red": 120.0,
            "green": 100.0,
            "blue": 80.0,
            "hue": 20.0,
            "saturation": 0.5,
            "lightness": 50.0,
            "deltaColor": float(20 / (1 + np.exp(-3 * (volume - 6)))),
        }
        for index, volume in enumerate(volume_axis)
    ]

    result = analyse_streams(volumes, [], temperatures, colors)

    assert math.isclose(result["temperaturePeakVolume"], 5.0, abs_tol=0.3)
    assert math.isclose(result["temperaturePeak"], 30.0, abs_tol=0.2)
    assert math.isclose(result["colorEndpointVolume"], 6.0, abs_tol=0.4)
    assert result["equivalenceVolume"] is None


def test_timestamp_matching_interpolates_at_volume_times() -> None:
    volumes = [
        {"id": "v1", "timestamp": 1_000, "volume": 1.0},
        {"id": "v2", "timestamp": 1_500, "volume": 2.0},
        {"id": "v3", "timestamp": 2_000, "volume": 3.0},
    ]
    ph_values = [
        {"id": "p1", "timestamp": 1_000, "ph": 2.0},
        {"id": "p2", "timestamp": 2_000, "ph": 4.0},
    ]

    matched_volume, matched_ph = match_by_timestamp(volumes, ph_values)

    assert matched_volume.tolist() == [1.0, 2.0, 3.0]
    assert matched_ph.tolist() == [2.0, 3.0, 4.0]


def test_timestamp_matching_rejects_large_source_gap() -> None:
    volumes = [{"timestamp": 2_000, "volume": 2.0}]
    ph_values = [
        {"timestamp": 1_000, "ph": 2.0},
        {"timestamp": 1_000 + MAX_INTERPOLATION_GAP_MS + 1, "ph": 4.0},
    ]

    matched_volume, matched_ph = match_by_timestamp(volumes, ph_values)

    assert matched_volume.size == 0
    assert matched_ph.size == 0


def test_timestamp_matching_limits_linear_extrapolation() -> None:
    ph_values = [
        {"timestamp": 1_000, "ph": 2.0},
        {"timestamp": 1_500, "ph": 3.0},
    ]
    volumes = [
        {"timestamp": 1_000 - MAX_EXTRAPOLATION_MS, "volume": 1.0},
        {"timestamp": 1_500 + MAX_EXTRAPOLATION_MS, "volume": 2.0},
        {"timestamp": 1_501 + MAX_EXTRAPOLATION_MS, "volume": 3.0},
    ]

    matched_volume, matched_ph = match_by_timestamp(volumes, ph_values)

    assert matched_volume.tolist() == [1.0, 2.0]
    assert matched_ph.tolist() == [1.0, 4.0]


def test_duplicate_sensor_timestamps_are_averaged() -> None:
    volumes = [{"timestamp": 1_000, "volume": 1.0}]
    ph_values = [
        {"timestamp": 1_000, "ph": 2.0},
        {"timestamp": 1_000, "ph": 4.0},
    ]

    matched_volume, matched_ph = match_by_timestamp(volumes, ph_values)

    assert matched_volume.tolist() == [1.0]
    assert matched_ph.tolist() == [3.0]


def test_normalise_record_preserves_clock_correction_metadata() -> None:
    record = hub._normalise_record(
        "ph",
        {
            "id": "p1",
            "clientId": "phone-a",
            "clientTimestamp": 1_000,
            "timestamp": 1_125,
            "clockOffsetMs": 125,
            "clockRttMs": 9,
            "clockSynchronized": True,
            "ph": 7.0,
        },
    )

    assert record["clientTimestamp"] == 1_000
    assert record["timestamp"] == 1_125
    assert record["clockOffsetMs"] == 125
    assert record["clockRttMs"] == 9
    assert record["clockSynchronized"] is True


def test_analysis_finds_logistic_equivalence_point() -> None:
    volume_axis = np.linspace(0, 20, 101)
    ph_axis = 2 + 10 / (1 + np.exp(-2 * (volume_axis - 10)))
    base_timestamp = 1_700_000_000_000
    volumes = [
        {"id": f"v-{index}", "timestamp": base_timestamp + index * 500, "volume": float(volume)}
        for index, volume in enumerate(volume_axis)
    ]
    ph_values = [
        {"id": f"p-{index}", "timestamp": base_timestamp + index * 500 + 80, "ph": float(ph)}
        for index, ph in enumerate(ph_axis)
    ]

    result = analyse_streams(volumes, ph_values)

    assert result["matchedCount"] == 101
    assert math.isclose(result["equivalenceVolume"], 10.0, abs_tol=0.3)
    assert len(result["firstDerivative"]) == 101
    assert len(result["secondDerivative"]) == 101


def test_health_and_static_pages() -> None:
    with TestClient(app) as client:
        health_response = client.get("/api/health")
        assert health_response.json()["status"] == "ok"
        assert health_response.headers["permissions-policy"] == "camera=(self), microphone=()"
        assert client.get("/").status_code == 200
        burette_page = client.get("/burette")
        ph_meter_page = client.get("/ph-meter")
        indicator_page = client.get("/indicator")
        assert burette_page.status_code == 200
        assert ph_meter_page.status_code == 200
        assert indicator_page.status_code == 200
        assert "0.01 mL까지 추적" in burette_page.text
        assert "메니스커스를 터치해주세요" in burette_page.text
        assert "중앙 수평선" in burette_page.text
        assert "굴절·시차 위험" in burette_page.text
        assert 'id="tiltGuideText"' in burette_page.text
        assert 'id="detectionMode"' not in burette_page.text
        assert "Y 현재" not in burette_page.text
        assert "무엇을 측정할지 선택" in ph_meter_page.text
        assert "pH 값" in ph_meter_page.text
        assert "디지털 온도" in ph_meter_page.text
        assert "아날로그 온도계" in ph_meter_page.text
        assert "온도도 측정" not in ph_meter_page.text
        assert 'id="enablePh"' not in ph_meter_page.text
        assert "인식 영역 (%)" not in ph_meter_page.text
        assert "이진화 임계값" not in ph_meter_page.text
        assert "녹화 시작" in burette_page.text
        assert "서버로 전송" in ph_meter_page.text
        assert "전극 없이 색만 측정한다면" in indicator_page.text
        assert "Δ색" in indicator_page.text
        dashboard_page = client.get("/").text
        assert "온도 최고점 부피" in dashboard_page
        assert "지시약 색 종말점" in dashboard_page
        assert "온도-시간" not in dashboard_page
        assert "d²pH/dV²" in dashboard_page
        assert "Δ색 = √" in dashboard_page
        assert "새 실험" in dashboard_page
        assert "데이터 입력 시작" in dashboard_page
        assert "CSV" in dashboard_page
        assert "XLSX" in dashboard_page
        assert "그래프 PNG 저장" in dashboard_page
        assert "기존 입력 유지 · 새 실험도 시작" in dashboard_page
        assert "같은 제목의 실험이 이미 있습니다" in dashboard_page
        assert "기존 데이터는 덮어쓰지 않습니다" in dashboard_page
        assert 'id="toggleDeleteMode"' in dashboard_page
        assert 'value="실험 1"' in dashboard_page
        assert 'aria-label="평활화 설명"' in dashboard_page
        assert 'aria-label="시간 정합 설명"' in dashboard_page
        assert "부피 기준" in dashboard_page
        assert 'aria-label="Δ색 계산 설명"' in dashboard_page
        assert 'id="experimentStatus"' in burette_page.text
        assert 'id="experimentStatus"' in ph_meter_page.text


def test_measurement_websocket_tracks_connected_camera() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/burette"):
            assert len(hub.measurement_clients["burette"]) == 1
        assert len(hub.measurement_clients["burette"]) == 0


def test_measurement_websocket_returns_ntp_style_time_sample() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/ph") as websocket:
            websocket.receive_json()
            websocket.send_json(
                {"type": "time-sync", "sequence": 3, "clientSendTimestamp": 1_000}
            )
            response = websocket.receive_json()

    assert response["type"] == "time-sync"
    assert response["sequence"] == 3
    assert response["clientSendTimestamp"] == 1_000
    assert response["serverReceiveTimestamp"] <= response["serverSendTimestamp"]


def test_recording_upload_list_and_download(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    video_bytes = b"test-webm-recording"
    with TestClient(app) as client:
        upload = client.post(
            "/api/recordings",
            content=video_bytes,
            headers={
                "content-type": "video/webm",
                "x-recording-channel": "ph",
                "x-recording-filename": "experiment.webm",
            },
        )
        assert upload.status_code == 201
        filename = upload.json()["filename"]
        assert filename.startswith("ph-")
        assert filename.endswith(".webm")

        listing = client.get("/api/recordings").json()["recordings"]
        assert listing[0]["filename"] == filename
        assert listing[0]["size"] == len(video_bytes)

        download = client.get(f"/api/recordings/{filename}")
        assert download.status_code == 200
        assert download.content == video_bytes


def test_recording_upload_rejects_unknown_media_type(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/api/recordings",
            content=b"not-video",
            headers={"content-type": "application/octet-stream"},
        )
    assert response.status_code == 415


def test_tls_configuration_rejects_missing_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("TITRATION_SSL_CERT", str(tmp_path / "missing.pem"))
    monkeypatch.setenv("TITRATION_SSL_KEY", str(tmp_path / "missing-key.pem"))

    with pytest.raises(RuntimeError, match="HTTPS 인증서가 없습니다"):
        resolve_tls_configuration()


def test_tls_configuration_rejects_invalid_certificate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    certificate = tmp_path / "invalid-test.pem"
    private_key = tmp_path / "invalid-test-key.pem"
    certificate.write_text("invalid certificate", encoding="ascii")
    private_key.write_text("invalid key", encoding="ascii")
    monkeypatch.setenv("TITRATION_SSL_CERT", str(certificate))
    monkeypatch.setenv("TITRATION_SSL_KEY", str(private_key))

    try:
        with pytest.raises(RuntimeError, match="읽을 수 없습니다"):
            resolve_tls_configuration()
    finally:
        certificate.unlink(missing_ok=True)
        private_key.unlink(missing_ok=True)