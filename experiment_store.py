from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Iterable


TITLE_PATTERN = re.compile(r"[\\/:*?\"<>|\x00-\x1f]+")


def get_experiments_directory() -> Path:
    """사용자별 실험 데이터 저장 폴더를 반환한다."""
    local_app_data = Path(os.getenv("LOCALAPPDATA", Path.cwd()))
    directory = local_app_data / "SmartTitration" / "experiments"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def normalise_title(title: str) -> str:
    """화면과 파일명에 안전한 실험 제목으로 정리한다."""
    cleaned = TITLE_PATTERN.sub("-", title).strip().strip(".")
    if not cleaned:
        raise ValueError("실험 제목을 입력하세요.")
    return cleaned[:100]


class ExperimentStore:
    """실험 메타데이터와 원본 측정값을 JSON 파일로 원자적 저장한다."""

    def __init__(self, channels: Iterable[str]) -> None:
        self.channels = tuple(channels)
        self.directory = get_experiments_directory()
        self.active_id: str | None = None

    def _path(self, experiment_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", experiment_id):
            raise ValueError("잘못된 실험 ID입니다.")
        return self.directory / f"{experiment_id}.json"

    def unique_title(self, title: str, force_suffix: bool = False) -> str:
        """필요할 때 (1), (2) 접미사를 붙여 고유 제목을 만든다."""
        base_title = normalise_title(title)
        existing_titles = {str(item["title"]) for item in self.list()}
        if not force_suffix and base_title not in existing_titles:
            return base_title
        suffix = 1
        while f"{base_title} ({suffix})" in existing_titles:
            suffix += 1
        return f"{base_title} ({suffix})"

    def create(self, title: str, ensure_unique: bool = False) -> dict[str, Any]:
        now = int(time.time() * 1000)
        experiment = {
            "id": uuid.uuid4().hex,
            "title": self.unique_title(title, force_suffix=True)
            if ensure_unique
            else normalise_title(title),
            "status": "stopped",
            "createdAt": now,
            "updatedAt": now,
            "startedAt": None,
            "stoppedAt": None,
            "streams": {channel: [] for channel in self.channels},
        }
        self.save(experiment)
        self.active_id = experiment["id"]
        return experiment

    def save(self, experiment: dict[str, Any]) -> None:
        experiment["updatedAt"] = int(time.time() * 1000)
        path = self._path(str(experiment["id"]))
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(experiment, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(path)

    def load(self, experiment_id: str) -> dict[str, Any]:
        path = self._path(experiment_id)
        if not path.is_file():
            raise FileNotFoundError("실험을 찾을 수 없습니다.")
        experiment = json.loads(path.read_text(encoding="utf-8"))
        experiment.setdefault("streams", {})
        for channel in self.channels:
            experiment["streams"].setdefault(channel, [])
        return experiment

    def list(self) -> list[dict[str, Any]]:
        experiments: list[dict[str, Any]] = []
        for path in self.directory.glob("*.json"):
            try:
                experiment = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            streams = experiment.get("streams", {})
            experiments.append(
                {
                    "id": experiment.get("id"),
                    "title": experiment.get("title", "제목 없음"),
                    "status": experiment.get("status", "stopped"),
                    "createdAt": experiment.get("createdAt"),
                    "updatedAt": experiment.get("updatedAt"),
                    "startedAt": experiment.get("startedAt"),
                    "stoppedAt": experiment.get("stoppedAt"),
                    "recordCount": sum(len(records) for records in streams.values()),
                }
            )
        experiments.sort(key=lambda item: item.get("updatedAt") or 0, reverse=True)
        return experiments

    def recording_experiments(self) -> list[dict[str, Any]]:
        """현재 데이터 입력 중인 모든 실험 요약을 반환한다."""
        return [item for item in self.list() if item.get("status") == "recording"]

    def set_status(self, experiment: dict[str, Any], status: str) -> None:
        if status not in ("recording", "stopped"):
            raise ValueError("잘못된 수집 상태입니다.")
        now = int(time.time() * 1000)
        experiment["status"] = status
        if status == "recording":
            experiment["startedAt"] = now
            experiment["stoppedAt"] = None
        else:
            experiment["stoppedAt"] = now
        self.save(experiment)

    def recover_interrupted_experiments(self) -> None:
        """이전 프로세스 종료 때 남은 입력 중 상태를 안전하게 중지로 복구한다."""
        for summary in self.list():
            if summary.get("status") != "recording":
                continue
            experiment = self.load(str(summary["id"]))
            self.set_status(experiment, "stopped")
