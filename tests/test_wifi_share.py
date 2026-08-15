import wifi_share
from wifi_share import build_wifi_qr_payload, has_wireless_adapter


def test_wifi_qr_payload_escapes_reserved_characters() -> None:
    payload = build_wifi_qr_payload("Lab;WiFi", "WPA", "pass:word,1", False)

    assert payload == r"WIFI:T:WPA;S:Lab\;WiFi;P:pass\:word\,1;H:false;;"


def test_open_wifi_qr_uses_nopass() -> None:
    payload = build_wifi_qr_payload("Open Lab", "nopass", "", True)

    assert payload == "WIFI:T:nopass;S:Open Lab;P:;H:true;;"


def test_wireless_adapter_is_detected_by_interface_guid(monkeypatch) -> None:
    monkeypatch.setattr(
        wifi_share,
        "_run_netsh",
        lambda arguments: "GUID : ae3cd16d-bf04-4a9c-b7c3-36fcb0bb8cc8",
    )

    assert has_wireless_adapter()


def test_no_wireless_adapter_without_interface_guid(monkeypatch) -> None:
    monkeypatch.setattr(wifi_share, "_run_netsh", lambda arguments: "인터페이스가 없습니다.")

    assert not has_wireless_adapter()