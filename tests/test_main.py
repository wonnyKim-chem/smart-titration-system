import math

import numpy as np
from fastapi.testclient import TestClient

from main import SYNC_TOLERANCE_MS, analyse_streams, app, match_by_timestamp


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
        assert client.get("/burette").status_code == 200
        assert client.get("/ph-meter").status_code == 200