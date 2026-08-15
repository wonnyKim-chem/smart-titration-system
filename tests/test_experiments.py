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
            assert websocket.receive_json()["type"] == "experiment-status"
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
            assert websocket.receive_json()["type"] == "experiment-status"
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


def test_switching_view_keeps_recording_and_continue_creation_copies_data(
    isolated_experiments: ExperimentStore,
) -> None:
    with TestClient(main.app) as client:
        first_id = client.post("/api/experiments", json={"title": "첫 실험"}).json()[
            "experiment"
        ]["id"]
        client.post(f"/api/experiments/{first_id}/start")
        blocked_create = client.post(
            "/api/experiments", json={"title": "첫 실험"}
        )
        assert blocked_create.status_code == 409
        created = client.post(
            "/api/experiments",
            json={"title": "첫 실험", "recordingAction": "continue"},
        )
        assert created.status_code == 409
        assert created.json()["code"] == "duplicate-title"
        assert created.json()["suggestedTitle"] == "첫 실험 (1)"
        created = client.post(
            "/api/experiments",
            json={
                "title": "첫 실험",
                "recordingAction": "continue",
                "duplicateAction": "suffix",
            },
        )
        second_id = created.json()["experiment"]["id"]
        assert created.json()["experiment"]["title"] == "첫 실험 (1)"
        assert created.json()["experiment"]["status"] == "recording"

        switched = client.post(f"/api/experiments/{first_id}/select", json={})
        assert switched.status_code == 200
        assert switched.json()["experiment"]["id"] == first_id
        assert switched.json()["experiment"]["status"] == "recording"
        assert len(isolated_experiments.recording_experiments()) == 2

        with client.websocket_connect("/ws/burette") as websocket:
            status = websocket.receive_json()
            assert status["type"] == "experiment-status"
            assert {item["title"] for item in status["experiments"]} == {
                "첫 실험",
                "첫 실험 (1)",
            }
            websocket.send_json(
                {
                    "type": "batch",
                    "records": [
                        {
                            "id": "shared-volume",
                            "clientId": "burette-a",
                            "timestamp": 1_700_000_100_000,
                            "volume": 2.5,
                        }
                    ],
                }
            )
            assert websocket.receive_json()["ids"] == ["shared-volume"]

        first = isolated_experiments.load(first_id)
        second = isolated_experiments.load(second_id)
        assert first["streams"]["burette"][-1]["id"] == "shared-volume"
        assert second["streams"]["burette"][-1]["id"] == "shared-volume"


def test_duplicate_title_never_overwrites_and_delete_is_permanent(
    isolated_experiments: ExperimentStore,
) -> None:
    with TestClient(main.app) as client:
        first = client.post("/api/experiments", json={"title": "반복 실험"}).json()[
            "experiment"
        ]
        duplicate = client.post("/api/experiments", json={"title": "반복 실험"})

        assert duplicate.status_code == 409
        assert duplicate.json()["code"] == "duplicate-title"
        assert duplicate.json()["suggestedTitle"] == "반복 실험 (1)"
        assert len(isolated_experiments.list()) == 1

        suffixed = client.post(
            "/api/experiments",
            json={"title": "반복 실험", "duplicateAction": "suffix"},
        )
        assert suffixed.status_code == 201
        assert suffixed.json()["experiment"]["title"] == "반복 실험 (1)"
        assert len(isolated_experiments.list()) == 2

        deleted = client.delete(f"/api/experiments/{first['id']}")
        assert deleted.status_code == 200
        assert deleted.json()["deleted"]["title"] == "반복 실험"
        assert not (isolated_experiments.directory / f"{first['id']}.json").exists()
        assert [item["title"] for item in isolated_experiments.list()] == ["반복 실험 (1)"]