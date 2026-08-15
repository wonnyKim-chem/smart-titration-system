import socket
from pathlib import Path

import pytest
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QLabel, QMessageBox

from launcher import MainWindow, is_port_available


def test_port_availability_detects_listener() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    listener.listen(1)

    try:
        assert not is_port_available(port)
    finally:
        listener.close()

    assert is_port_available(port)


def test_first_run_does_not_install_certificate_automatically(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.delenv("TITRATION_SSL_CERT", raising=False)
    monkeypatch.delenv("TITRATION_SSL_KEY", raising=False)
    application = QApplication.instance() or QApplication([])
    window = MainWindow(auto_start=True)

    QTest.qWait(400)

    assert window.certificate_process is None
    assert window.server_thread is None
    assert window.server_status.text() == "HTTPS 필수 설정 미완료"
    assert window.setup_certificate_button.text() == "HTTPS 필수 설정"
    required_notice = window.findChild(QLabel, "requiredNotice")
    assert required_notice is not None
    assert "모바일 브라우저 카메라" in required_notice.text()
    window.quitting = True
    window.tray.hide()
    window.close()
    application.processEvents()


def test_port_conflict_shows_readable_message(monkeypatch: pytest.MonkeyPatch) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    listener.listen(1)
    application = QApplication.instance() or QApplication([])
    window = MainWindow(auto_start=False)
    window.port = port
    monkeypatch.setattr(window, "_refresh_certificate_state", lambda: True)
    monkeypatch.setattr(QMessageBox, "critical", lambda *args: QMessageBox.StandardButton.Ok)

    try:
        window._start_server()
        assert window.server_thread is None
        assert window.server_status.text() == "시작 실패"
        assert f"포트 {port}이 이미 사용 중" in window.log_output.toPlainText()
    finally:
        listener.close()
        window.quitting = True
        window.tray.hide()
        window.close()
        application.processEvents()