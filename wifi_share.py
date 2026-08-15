from __future__ import annotations

import locale
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path


CREATE_NO_WINDOW = 0x08000000


def _run_netsh(arguments: list[str]) -> str:
    """콘솔 창 없이 netsh를 실행하고 Windows 로캘로 결과를 해석한다."""
    completed = subprocess.run(
        ["netsh", "wlan", *arguments],
        capture_output=True,
        check=True,
        creationflags=CREATE_NO_WINDOW,
    )
    try:
        return completed.stdout.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        encoding = locale.getencoding() or locale.getpreferredencoding(False) or "cp1252"
        return completed.stdout.decode(encoding, errors="replace")


def get_wifi_profiles() -> list[str]:
    """Windows에 저장된 개인 Wi-Fi 프로필 이름을 반환한다."""
    output = _run_netsh(["show", "profiles"])
    profiles: list[str] = []
    for line in output.splitlines():
        if ":" not in line:
            continue
        label, value = line.split(":", 1)
        if "프로필" not in label and "Profile" not in label:
            continue
        name = value.strip()
        if name and name not in profiles:
            profiles.append(name)
    return profiles


def get_connected_ssid() -> str | None:
    """현재 연결된 Wi-Fi SSID를 반환한다."""
    output = _run_netsh(["show", "interfaces"])
    for line in output.splitlines():
        if ":" not in line:
            continue
        label, value = line.split(":", 1)
        normalised = label.strip().lower()
        if normalised == "ssid" and "bssid" not in normalised:
            ssid = value.strip()
            if ssid:
                return ssid
    return None


def read_wifi_profile(profile_name: str) -> tuple[str, str, str, bool]:
    """선택한 프로필의 SSID, 암호화, 암호와 숨김 여부를 임시 XML에서 읽는다."""
    with tempfile.TemporaryDirectory(prefix="smart-titration-wifi-") as temporary_directory:
        _run_netsh(
            [
                "export",
                "profile",
                f"name={profile_name}",
                f"folder={temporary_directory}",
                "key=clear",
            ]
        )
        xml_files = list(Path(temporary_directory).glob("*.xml"))
        if not xml_files:
            raise RuntimeError("Wi-Fi 프로필을 읽지 못했습니다.")
        root = ET.parse(xml_files[0]).getroot()

        def find_text(local_name: str) -> str:
            for element in root.iter():
                if element.tag.rsplit("}", 1)[-1] == local_name and element.text:
                    return element.text.strip()
            return ""

        ssid = find_text("hex")
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] == "SSID":
                for child in element:
                    if child.tag.rsplit("}", 1)[-1] == "name" and child.text:
                        ssid = child.text.strip()
                        break
        authentication = find_text("authentication").upper()
        password = find_text("keyMaterial")
        hidden = find_text("nonBroadcast").lower() == "true"
        if not ssid:
            ssid = profile_name
        if "8021X" in authentication or "ENTERPRISE" in authentication:
            raise RuntimeError("기업용 또는 학교 인증 Wi-Fi는 QR 암호 공유를 지원하지 않습니다.")
        if authentication not in ("OPEN", "") and not password:
            raise RuntimeError("저장된 Wi-Fi 암호를 읽을 권한이 없습니다.")
        security = "nopass" if authentication in ("OPEN", "") else "WPA"
        return ssid, security, password, hidden


def _escape_wifi_value(value: str) -> str:
    escaped = value.replace("\\", "\\\\")
    for character in (";", ",", ":", '"'):
        escaped = escaped.replace(character, f"\\{character}")
    return escaped


def build_wifi_qr_payload(ssid: str, security: str, password: str, hidden: bool = False) -> str:
    """Android와 iOS가 인식하는 표준 Wi-Fi QR 문자열을 만든다."""
    return (
        f"WIFI:T:{_escape_wifi_value(security)};"
        f"S:{_escape_wifi_value(ssid)};"
        f"P:{_escape_wifi_value(password)};"
        f"H:{str(hidden).lower()};;"
    )