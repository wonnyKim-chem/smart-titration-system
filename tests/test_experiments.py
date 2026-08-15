from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

import main
from experiment_store import ExperimentStore


@pytest.fixture
def isolated_experiments(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> ExperimentStore:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    store = ExperimentStore(main.CHANNEL_FIELDS)
    monkeypatch.setattr(main, "experiment_store", store)
    main.hub.experiment_store = store
    main.hub.active_experiment = None
    store.active_id = None
    for channel in main.CHANNEL_FIELDS:
        main.hub.streams[channel].clear()
        main.hub.seen_ids[channel].clear()
    main.hub.latest_analysis = main.hub._empty_analysis()
    yield store
    main.hub.active_experiment = None


def test_experiment_lifecycle_and_exports(isolated_experiments: ExperimentStore) -> None:
    with TestClient(main.app) as client:
        created = client.post("/api/experiments", json={"title": "강산-강염기 1차"})
        assert created.status_code == 201
        experiment_id = created.json()["experiment"]["id"]

        started = client.post(f"/api/experiments/{experiment_id}/start")
        assert started.status_code == 200
        assert started.json()["experiment"]["status"] == "recording"

        with client.websocket_connect("/ws/burette") as websocket:
            websocket.send_json(
                {
                    "type": "batch",
                    "records": [
                        {
                            "id": "volume-1",
                            "clientId": "burette-a",
                            "timestamp": 1_700_000_000_000,
                            "volume": 0.0,
                        },
                        {
                            "id": "volume-2",
                            "clientId": "burette-a",
                            "timestamp": 1_700_000_000_500,
                            "volume": 1.0,
                        },
                    ],
                }
            )
            assert websocket.receive_json()["ids"] == ["volume-1", "volume-2"]
        with client.websocket_connect("/ws/ph") as websocket:
            websocket.send_json(
                {
                    "type": "batch",
                    "records": [
                        {
                            "id": "ph-1",
                            "clientId": "ph-a",
                            "timestamp": 1_700_000_000_040,
                            "ph": 3.0,
                        },
                        {
                            "id": "ph-2",
                            "clientId": "ph-a",
                            "timestamp": 1_700_000_000_540,
                            "ph": 4.0,
                        },
                    ],
                }
            )
            assert websocket.receive_json()["ids"] == ["ph-1", "ph-2"]

        stopped = client.post(f"/api/experiments/{experiment_id}/stop")
        assert stopped.json()["experiment"]["status"] == "stopped"
        listing = client.get("/api/experiments").json()
        assert listing["activeId"] == experiment_id
        assert listing["experiments"][0]["recordCount"] == 4

        csv_response = client.get(f"/api/experiments/{experiment_id}/export.csv")
        assert csv_response.status_code == 200
        csv_text = csv_response.content.decode("utf-8-sig")
        assert "부피 (mL),pH,평활 pH,dpH/dV,d²pH/dV²,온도 (°C),Δ색" in csv_text
        assert quote("강산-강염기 1차.csv") in csv_response.headers["content-disposition"]

        xlsx_response = client.get(f"/api/experiments/{experiment_id}/export.xlsx")
        assert xlsx_response.status_code == 200
        workbook = load_workbook(BytesIO(xlsx_response.content))
        assert workbook["분석 데이터"]["A1"].value == "부피 (mL)"
        assert workbook["실험 요약"]["B2"].value == "강산-강염기 1차"


def test_switching_recording_experiment_requires_confirmation(
    isolated_experiments: ExperimentStore,
) -> None:
    with TestClient(main.app) as client:
        first_id = client.post("/api/experiments", json={"title": "첫 실험"}).json()[
            "experiment"
        ]["id"]
        client.post(f"/api/experiments/{first_id}/start")
        blocked_create = client.post(
            "/api/experiments", json={"title": "둘째 실험", "stopCurrent": False}
        )
        assert blocked_create.status_code == 409
        second_id = client.post(
            "/api/experiments", json={"title": "둘째 실험", "stopCurrent": True}
        ).json()["experiment"]["id"]
        client.post(f"/api/experiments/{first_id}/select", json={"stopCurrent": False})
        client.post(f"/api/experiments/{first_id}/start")

        blocked = client.post(
            f"/api/experiments/{second_id}/select", json={"stopCurrent": False}
        )
        assert blocked.status_code == 409

        switched = client.post(
            f"/api/experiments/{second_id}/select", json={"stopCurrent": True}
        )
        assert switched.status_code == 200
        assert switched.json()["experiment"]["id"] == second_id