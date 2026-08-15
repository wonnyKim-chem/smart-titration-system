from wifi_share import build_wifi_qr_payload


def test_wifi_qr_payload_escapes_reserved_characters() -> None:
    payload = build_wifi_qr_payload("Lab;WiFi", "WPA", "pass:word,1", False)

    assert payload == r"WIFI:T:WPA;S:Lab\;WiFi;P:pass\:word\,1;H:false;;"


def test_open_wifi_qr_uses_nopass() -> None:
    payload = build_wifi_qr_payload("Open Lab", "nopass", "", True)

    assert payload == "WIFI:T:nopass;S:Open Lab;P:;H:true;;"