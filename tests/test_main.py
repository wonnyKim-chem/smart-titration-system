import math
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from main import (
    SYNC_TOLERANCE_MS,
    analyse_streams,
    app,
    hub,
    match_by_timestamp,
    resolve_tls_configuration,
)


def test_timestamp_matching_respects_tolerance() -> None:
    volumes = [
        {"id": "v1", "timestamp": 1_000, "volume": 1.0},
    ]
    ph_values = [
        {"id": "p1", "timestamp": 1_000 + SYNC_TOLERANCE_MS, "ph": 3.0},
        {"id": "p2", "timestamp": 1_001 + SYNC_TOLERANCE_MS, "ph": 4.0},
    ]

    matched_volume, matched_ph = match_by_timestamp(volumes, ph_values)

    assert matched_volume.tolist() == [1.0]
    assert matched_ph.tolist() == [3.0]


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
        assert burette_page.status_code == 200
        assert ph_meter_page.status_code == 200
        assert "보정 중입니다" in burette_page.text
        assert "Y 현재" not in burette_page.text
        assert "LCD 숫자 부분을 한 번 터치" in ph_meter_page.text
        assert "인식 영역 (%)" not in ph_meter_page.text
        assert "이진화 임계값" not in ph_meter_page.text
        assert "녹화 시작" in burette_page.text
        assert "서버로 전송" in ph_meter_page.text


def test_measurement_websocket_tracks_connected_camera() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/burette"):
            assert len(hub.measurement_clients["burette"]) == 1
        assert len(hub.measurement_clients["burette"]) == 0


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