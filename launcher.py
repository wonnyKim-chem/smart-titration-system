from __future__ import annotations

import logging
import os
import socket
import ssl
import sys
import time
from pathlib import Path
from typing import Any

import qrcode
import uvicorn
from PySide6.QtCore import QProcess, QThread, QTimer, Qt, QUrl, Signal
from PySide6.QtGui import QAction, QColor, QCloseEvent, QDesktopServices, QFont, QIcon, QImage, QPainter, QPixmap
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSizePolicy,
    QStyle,
    QSystemTrayIcon,
    QVBoxLayout,
    QWidget,
)

from main import (
    app,
    get_default_certificate_paths,
    get_local_ip,
    get_recordings_directory,
    hub,
    resolve_tls_configuration,
)


APP_NAME = "Smart Titration"
DEFAULT_PORT = 8000
INSTANCE_SERVER_NAME = "SmartTitrationServerLauncher"


def resource_path(filename: str) -> Path:
    """개발 환경과 PyInstaller 환경에서 공통으로 자원 경로를 찾는다."""
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return root / filename


def create_app_icon() -> QIcon:
    image = QImage(64, 64, QImage.Format.Format_ARGB32)
    image.fill(QColor("#f1c84a"))
    painter = QPainter(image)
    painter.setPen(QColor("#17201f"))
    painter.setFont(QFont("Arial", 22, QFont.Weight.Bold))
    painter.drawText(image.rect(), Qt.AlignmentFlag.AlignCenter, "pH")
    painter.end()
    return QIcon(QPixmap.fromImage(image))


def create_qr_pixmap(value: str, target_size: int = 220) -> QPixmap:
    qr = qrcode.QRCode(border=2, box_size=8)
    qr.add_data(value)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    module_count = len(matrix)
    image = QImage(module_count, module_count, QImage.Format.Format_RGB32)
    white = QColor("#ffffff").rgb()
    dark = QColor("#17201f").rgb()
    for row, values in enumerate(matrix):
        for column, enabled in enumerate(values):
            image.setPixel(column, row, dark if enabled else white)
    return QPixmap.fromImage(image).scaled(
        target_size,
        target_size,
        Qt.AspectRatioMode.KeepAspectRatio,
        Qt.TransformationMode.FastTransformation,
    )


def inspect_certificate(host: str) -> tuple[bool, str]:
    try:
        certificate, _ = resolve_tls_configuration()
        decoded = ssl._ssl._test_decode_cert(certificate)  # type: ignore[attr-defined]
        alternative_names = decoded.get("subjectAltName", ())
        if ("IP Address", host) not in alternative_names and ("DNS", host) not in alternative_names:
            return False, f"현재 IP {host}가 인증서에 없습니다. 인증서를 다시 생성하세요."
        expires_at = ssl.cert_time_to_seconds(decoded["notAfter"])
        if expires_at <= time.time():
            return False, "HTTPS 인증서가 만료되었습니다. 인증서를 다시 생성하세요."
        expires_text = time.strftime("%Y-%m-%d", time.localtime(expires_at))
        return True, f"현재 IP에 유효함 · 만료 {expires_text}"
    except (KeyError, OSError, RuntimeError, ssl.SSLError) as error:
        return False, str(error)


def is_port_available(port: int) -> bool:
    """서버 시작 전에 지정 포트를 다른 프로세스가 점유했는지 확인한다."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name == "nt":
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        probe.bind(("0.0.0.0", port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


class GuiLogHandler(logging.Handler):
    def __init__(self, callback: Any) -> None:
        super().__init__()
        self.callback = callback
        self.setFormatter(logging.Formatter("%(asctime)s  %(levelname)s  %(message)s", "%H:%M:%S"))

    def emit(self, record: logging.LogRecord) -> None:
        self.callback(self.format(record))


class ServerThread(QThread):
    log_message = Signal(str)
    failed = Signal(str)
    finished_cleanly = Signal()

    def __init__(self, port: int) -> None:
        super().__init__()
        self.port = port
        self.server: uvicorn.Server | None = None
        self.stop_requested = False

    @property
    def is_serving(self) -> bool:
        return bool(self.server and self.server.started and not self.server.should_exit)

    def run(self) -> None:
        handler = GuiLogHandler(self.log_message.emit)
        loggers = [logging.getLogger(name) for name in ("uvicorn", "uvicorn.error", "uvicorn.access")]
        for logger in loggers:
            logger.addHandler(handler)
        try:
            certificate, private_key = resolve_tls_configuration()
            configuration = uvicorn.Config(
                app,
                host="0.0.0.0",
                port=self.port,
                ssl_certfile=certificate,
                ssl_keyfile=private_key,
                log_config=None,
            )
            self.server = uvicorn.Server(configuration)
            self.server.run()
            if not self.stop_requested and not self.server.started:
                self.failed.emit("서버가 시작되기 전에 종료되었습니다. 포트 사용 여부를 확인하세요.")
            else:
                self.finished_cleanly.emit()
        except SystemExit as error:
            if not self.stop_requested:
                if error.code == 3:
                    self.failed.emit(f"포트 {self.port}이 이미 사용 중입니다. 실행 중인 서버를 확인하세요.")
                else:
                    self.failed.emit(f"서버 프로세스가 종료되었습니다. 오류 코드: {error.code}")
        except BaseException as error:
            if not self.stop_requested:
                message = str(error).strip() or type(error).__name__
                self.failed.emit(message)
        finally:
            for logger in loggers:
                logger.removeHandler(handler)

    def stop(self) -> None:
        self.stop_requested = True
        if self.server:
            self.server.should_exit = True


class MetricWidget(QFrame):
    def __init__(self, title: str) -> None:
        super().__init__()
        self.setObjectName("metric")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 10, 12, 10)
        layout.setSpacing(2)
        title_label = QLabel(title)
        title_label.setObjectName("metricTitle")
        self.value_label = QLabel("0")
        self.value_label.setObjectName("metricValue")
        layout.addWidget(title_label)
        layout.addWidget(self.value_label)

    def set_value(self, value: str) -> None:
        self.value_label.setText(value)


class MainWindow(QMainWindow):
    def __init__(self, auto_start: bool = True) -> None:
        super().__init__()
        self.ip_address = get_local_ip()
        self.port = int(os.getenv("TITRATION_PORT", str(DEFAULT_PORT)))
        self.access_url = f"https://{self.ip_address}:{self.port}"
        self.server_thread: ServerThread | None = None
        self.certificate_process: QProcess | None = None
        self.was_server_running = False
        self.quitting = False
        self.setWindowTitle(f"{APP_NAME} Server")
        self.setWindowIcon(create_app_icon())
        self.setMinimumSize(920, 680)
        self.resize(1080, 760)
        self._build_ui()
        self._build_tray()
        self._apply_style()

        self.refresh_timer = QTimer(self)
        self.refresh_timer.setInterval(500)
        self.refresh_timer.timeout.connect(self._refresh_runtime_state)
        self.refresh_timer.start()
        self._refresh_certificate_state()
        if auto_start:
            QTimer.singleShot(250, self._auto_start_server)

    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)
        root.setContentsMargins(28, 24, 28, 24)
        root.setSpacing(18)

        header = QHBoxLayout()
        brand = QVBoxLayout()
        eyebrow = QLabel("LOCAL LAB SERVER")
        eyebrow.setObjectName("eyebrow")
        title = QLabel("Smart Titration")
        title.setObjectName("title")
        brand.addWidget(eyebrow)
        brand.addWidget(title)
        header.addLayout(brand)
        header.addStretch()
        self.server_status = QLabel("준비 중")
        self.server_status.setObjectName("serverStatus")
        header.addWidget(self.server_status)
        root.addLayout(header)

        content = QHBoxLayout()
        content.setSpacing(18)

        connection_panel = QFrame()
        connection_panel.setObjectName("panel")
        connection_layout = QVBoxLayout(connection_panel)
        connection_layout.setContentsMargins(22, 20, 22, 22)
        connection_layout.setSpacing(14)
        panel_title = QLabel("모바일 접속")
        panel_title.setObjectName("sectionTitle")
        connection_layout.addWidget(panel_title)
        self.qr_label = QLabel()
        self.qr_label.setObjectName("qrLabel")
        self.qr_label.setFixedSize(236, 236)
        self.qr_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        connection_layout.addWidget(self.qr_label, 0, Qt.AlignmentFlag.AlignHCenter)
        self.url_input = QLineEdit(self.access_url)
        self.url_input.setReadOnly(True)
        self.url_input.setObjectName("urlInput")
        connection_layout.addWidget(self.url_input)
        action_row = QHBoxLayout()
        self.copy_button = QPushButton("주소 복사")
        self.copy_button.clicked.connect(self._copy_url)
        self.open_button = QPushButton("대시보드 열기")
        self.open_button.setObjectName("primaryButton")
        self.open_button.clicked.connect(self._open_dashboard)
        action_row.addWidget(self.copy_button)
        action_row.addWidget(self.open_button)
        connection_layout.addLayout(action_row)
        self.access_note = QLabel("HTTPS 서버가 시작되면 이 주소에서 실시간 데이터를 확인할 수 있습니다.")
        self.access_note.setWordWrap(True)
        self.access_note.setObjectName("mutedText")
        connection_layout.addWidget(self.access_note)
        connection_layout.addStretch()
        content.addWidget(connection_panel, 5)

        operation_column = QVBoxLayout()
        operation_column.setSpacing(14)

        certificate_panel = QFrame()
        certificate_panel.setObjectName("panel")
        certificate_layout = QVBoxLayout(certificate_panel)
        certificate_layout.setContentsMargins(18, 16, 18, 18)
        certificate_title = QLabel("HTTPS 인증서")
        certificate_title.setObjectName("sectionTitle")
        self.certificate_status = QLabel("확인 중")
        self.certificate_status.setObjectName("certificateStatus")
        self.certificate_detail = QLabel("")
        self.certificate_detail.setWordWrap(True)
        self.certificate_detail.setObjectName("mutedText")
        certificate_actions = QHBoxLayout()
        self.setup_certificate_button = QPushButton("HTTPS 설정 안내")
        self.setup_certificate_button.clicked.connect(self._setup_certificate)
        self.open_certificate_button = QPushButton("인증서 폴더")
        self.open_certificate_button.clicked.connect(self._open_certificate_folder)
        certificate_actions.addWidget(self.setup_certificate_button)
        certificate_actions.addWidget(self.open_certificate_button)
        certificate_layout.addWidget(certificate_title)
        certificate_layout.addWidget(self.certificate_status)
        certificate_layout.addWidget(self.certificate_detail)
        certificate_layout.addLayout(certificate_actions)
        operation_column.addWidget(certificate_panel)

        server_panel = QFrame()
        server_panel.setObjectName("panel")
        server_layout = QVBoxLayout(server_panel)
        server_layout.setContentsMargins(18, 16, 18, 18)
        server_title = QLabel("서버 제어")
        server_title.setObjectName("sectionTitle")
        server_actions = QHBoxLayout()
        self.start_button = QPushButton("서버 시작")
        self.start_button.setObjectName("primaryButton")
        self.start_button.clicked.connect(self._start_server)
        self.stop_button = QPushButton("서버 중지")
        self.stop_button.clicked.connect(self._stop_server)
        self.stop_button.setEnabled(False)
        self.recordings_button = QPushButton("녹화 폴더")
        self.recordings_button.clicked.connect(self._open_recordings_folder)
        server_actions.addWidget(self.start_button)
        server_actions.addWidget(self.stop_button)
        server_actions.addWidget(self.recordings_button)
        server_layout.addWidget(server_title)
        server_layout.addLayout(server_actions)
        operation_column.addWidget(server_panel)

        metrics = QGridLayout()
        metrics.setSpacing(8)
        self.volume_metric = MetricWidget("부피 레코드")
        self.ph_metric = MetricWidget("pH 레코드")
        self.camera_metric = MetricWidget("카메라 연결")
        self.matched_metric = MetricWidget("시간 정합")
        metrics.addWidget(self.volume_metric, 0, 0)
        metrics.addWidget(self.ph_metric, 0, 1)
        metrics.addWidget(self.camera_metric, 1, 0)
        metrics.addWidget(self.matched_metric, 1, 1)
        operation_column.addLayout(metrics)
        operation_column.addStretch()
        content.addLayout(operation_column, 4)
        root.addLayout(content, 1)

        log_header = QHBoxLayout()
        log_title = QLabel("서버 로그")
        log_title.setObjectName("sectionTitle")
        self.log_toggle = QPushButton("로그 펼치기")
        self.log_toggle.setObjectName("textButton")
        self.log_toggle.clicked.connect(self._toggle_logs)
        log_header.addWidget(log_title)
        log_header.addStretch()
        log_header.addWidget(self.log_toggle)
        root.addLayout(log_header)
        self.log_output = QPlainTextEdit()
        self.log_output.setReadOnly(True)
        self.log_output.setMaximumBlockCount(600)
        self.log_output.setVisible(False)
        self.log_output.setMinimumHeight(150)
        root.addWidget(self.log_output)
        self.setCentralWidget(central)

    def _build_tray(self) -> None:
        self.tray = QSystemTrayIcon(self.windowIcon(), self)
        menu = QMenu()
        show_action = QAction("서버 창 열기", self)
        show_action.triggered.connect(self._show_window)
        dashboard_action = QAction("대시보드 열기", self)
        dashboard_action.triggered.connect(self._open_dashboard)
        quit_action = QAction("서버 종료", self)
        quit_action.triggered.connect(self._quit_application)
        menu.addAction(show_action)
        menu.addAction(dashboard_action)
        menu.addSeparator()
        menu.addAction(quit_action)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(
            lambda reason: self._show_window()
            if reason == QSystemTrayIcon.ActivationReason.DoubleClick
            else None
        )
        self.tray.show()

    def _apply_style(self) -> None:
        self.setStyleSheet(
            """
            QMainWindow, QWidget {
                background: #f2f1ec;
                color: #17201f;
                font-family: "Malgun Gothic";
                font-size: 13px;
            }
            QLabel#eyebrow { color: #66716e; font-size: 10px; font-weight: 700; }
            QLabel#title { font-size: 28px; font-weight: 700; }
            QLabel#serverStatus {
                padding: 8px 14px;
                border: 1px solid #cbd1cd;
                border-radius: 5px;
                background: #ffffff;
                font-weight: 700;
            }
            QFrame#panel { background: #ffffff; border-top: 3px solid #17201f; }
            QLabel#sectionTitle { font-size: 15px; font-weight: 700; }
            QLabel#mutedText { color: #66716e; line-height: 1.5; }
            QLabel#certificateStatus { color: #087f6d; font-size: 16px; font-weight: 700; }
            QLabel#qrLabel { background: #ffffff; border: 1px solid #cbd1cd; }
            QLineEdit#urlInput {
                min-height: 38px;
                padding: 0 10px;
                border: 1px solid #cbd1cd;
                border-radius: 4px;
                background: #f8f9f7;
                font-family: Consolas;
                font-size: 14px;
            }
            QPushButton {
                min-height: 38px;
                padding: 0 14px;
                border: 1px solid #aeb7b2;
                border-radius: 4px;
                background: #ffffff;
                font-weight: 700;
            }
            QPushButton:hover { background: #e8ebe7; }
            QPushButton:disabled { color: #9ca4a1; background: #e8ebe7; }
            QPushButton#primaryButton { color: #ffffff; border-color: #045e51; background: #087f6d; }
            QPushButton#primaryButton:hover { background: #045e51; }
            QPushButton#textButton { min-height: 28px; border: 0; color: #087f6d; background: transparent; }
            QFrame#metric { background: #ffffff; border: 1px solid #cbd1cd; }
            QLabel#metricTitle { color: #66716e; font-size: 11px; }
            QLabel#metricValue { font-family: Consolas; font-size: 20px; font-weight: 700; }
            QPlainTextEdit {
                border: 1px solid #293230;
                border-radius: 4px;
                color: #dce5e1;
                background: #17201f;
                font-family: Consolas;
                font-size: 11px;
            }
            """
        )

    def _append_log(self, message: str) -> None:
        self.log_output.appendPlainText(message)

    def _refresh_certificate_state(self) -> bool:
        valid, detail = inspect_certificate(self.ip_address)
        self.certificate_status.setText("사용 가능" if valid else "설정 필요")
        self.certificate_status.setStyleSheet("color: #087f6d;" if valid else "color: #c44235;")
        self.certificate_detail.setText(detail)
        self.start_button.setEnabled(valid and not self._server_is_running())
        return valid

    def _auto_start_server(self) -> None:
        if self._refresh_certificate_state():
            self._start_server()
        else:
            self.server_status.setText("HTTPS 설정 필요")
            self.qr_label.setText("인증서를 설정하면\nHTTPS QR 코드가 표시됩니다.")

    def _server_is_running(self) -> bool:
        return bool(self.server_thread and self.server_thread.is_serving)

    def _start_server(self) -> None:
        if self.server_thread and self.server_thread.isRunning():
            return
        if not self._refresh_certificate_state():
            QMessageBox.warning(self, "HTTPS 설정 필요", self.certificate_detail.text())
            return
        if not is_port_available(self.port):
            self._server_failed(f"포트 {self.port}이 이미 사용 중입니다. 기존 Smart Titration을 열거나 해당 프로그램을 종료하세요.")
            return
        self.server_status.setText("HTTPS 시작 중")
        self.start_button.setEnabled(False)
        self.stop_button.setEnabled(True)
        self.server_thread = ServerThread(self.port)
        self.server_thread.log_message.connect(self._append_log)
        self.server_thread.failed.connect(self._server_failed)
        self.server_thread.finished_cleanly.connect(self._server_stopped)
        self.server_thread.start()
        self._append_log(f"HTTPS 서버 시작 요청: {self.access_url}")

    def _stop_server(self) -> None:
        if not self.server_thread:
            return
        self.server_status.setText("서버 중지 중")
        self.server_thread.stop()

    def _server_failed(self, message: str) -> None:
        self._append_log(f"서버 오류: {message}")
        self.server_status.setText("시작 실패")
        self.start_button.setEnabled(self._refresh_certificate_state())
        self.stop_button.setEnabled(False)
        QMessageBox.critical(self, "서버 시작 실패", message)

    def _server_stopped(self) -> None:
        if self.quitting:
            return
        self.server_status.setText("서버 중지됨")
        self.qr_label.clear()
        self.start_button.setEnabled(self._refresh_certificate_state())
        self.stop_button.setEnabled(False)

    def _refresh_runtime_state(self) -> None:
        running = self._server_is_running()
        if running and not self.was_server_running:
            self.server_status.setText("HTTPS 서버 실행 중")
            self.server_status.setStyleSheet("color: #045e51; border-color: #087f6d; background: #e5f3ef;")
            self.qr_label.setPixmap(create_qr_pixmap(self.access_url))
            self.access_note.setText(f"서버 PC와 모바일 기기 모두 {self.access_url} 에서 실시간 데이터를 확인하세요.")
            self.open_button.setEnabled(True)
            self.copy_button.setEnabled(True)
            self.tray.setToolTip(f"{APP_NAME} · {self.access_url}")
            self.tray.showMessage(APP_NAME, f"HTTPS 서버가 시작되었습니다.\n{self.access_url}")
        elif not running and self.was_server_running:
            self.server_status.setStyleSheet("")
        self.was_server_running = running

        self.volume_metric.set_value(str(len(hub.streams["burette"])))
        self.ph_metric.set_value(str(len(hub.streams["ph"])))
        connected_cameras = sum(len(clients) for clients in hub.measurement_clients.values())
        self.camera_metric.set_value(str(connected_cameras))
        self.matched_metric.set_value(str(hub.latest_analysis.get("matchedCount", 0)))

    def _setup_certificate(self) -> None:
        if self.certificate_process and self.certificate_process.state() != QProcess.ProcessState.NotRunning:
            return
        confirmation = QMessageBox.question(
            self,
            "로컬 HTTPS 인증서 설정",
            "Smart Titration은 첫 실행에서 인증서를 자동으로 설치하지 않습니다.\n\n"
            "설정을 시작하면 이 PC에 실험실 전용 로컬 인증기관을 만들고, 모바일 카메라가 "
            "HTTPS로 연결할 수 있는 인증서를 생성합니다. 인터넷 공개 인증서가 아니므로 iPhone과 "
            "Android에도 공개 인증서 파일을 직접 설치해야 합니다.\n\n"
            "완전 로컬 방식에서 브라우저 카메라를 사용하려면 이 신뢰 설정이 필요합니다. 지금 진행할까요?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel,
        )
        if confirmation != QMessageBox.StandardButton.Yes:
            return
        script = resource_path("setup-ios-https.ps1")
        if not script.is_file():
            QMessageBox.critical(self, "설정 파일 없음", f"인증서 설정 스크립트를 찾을 수 없습니다.\n{script}")
            return
        if self._server_is_running():
            self._stop_server()
        self.setup_certificate_button.setEnabled(False)
        self.certificate_status.setText("설정 중")
        self._append_log("HTTPS 인증서 설정을 시작합니다.")
        process = QProcess(self)
        process.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        process.readyReadStandardOutput.connect(self._read_certificate_output)
        process.finished.connect(self._certificate_setup_finished)
        self.certificate_process = process
        process.start(
            "powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-IpAddress", self.ip_address],
        )

    def _read_certificate_output(self) -> None:
        if not self.certificate_process:
            return
        output = bytes(self.certificate_process.readAllStandardOutput()).decode("utf-8", errors="replace")
        for line in output.splitlines():
            if line.strip():
                self._append_log(line)

    def _certificate_setup_finished(self, exit_code: int, _: Any) -> None:
        self.setup_certificate_button.setEnabled(True)
        valid = self._refresh_certificate_state()
        if exit_code == 0 and valid:
            QMessageBox.information(
                self,
                "HTTPS 설정 완료",
                "인증서가 준비되었습니다. 모바일 기기에 SmartTitration-RootCA.crt를 설치한 뒤 신뢰하세요.",
            )
            self._start_server()
        else:
            QMessageBox.critical(self, "HTTPS 설정 실패", "로그를 펼쳐 오류 내용을 확인하세요.")

    def _open_certificate_folder(self) -> None:
        certificate, _ = get_default_certificate_paths()
        certificate.parent.mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(certificate.parent)))

    def _open_recordings_folder(self) -> None:
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(get_recordings_directory())))

    def _copy_url(self) -> None:
        QApplication.clipboard().setText(self.access_url)
        self.statusBar().showMessage("접속 주소를 복사했습니다.", 2500)

    def _open_dashboard(self) -> None:
        if not self._server_is_running():
            QMessageBox.information(self, "서버 중지됨", "HTTPS 서버를 먼저 시작하세요.")
            return
        QDesktopServices.openUrl(QUrl(self.access_url))

    def _toggle_logs(self) -> None:
        visible = not self.log_output.isVisible()
        self.log_output.setVisible(visible)
        self.log_toggle.setText("로그 접기" if visible else "로그 펼치기")

    def _show_window(self) -> None:
        self.showNormal()
        self.activateWindow()
        self.raise_()

    def _quit_application(self) -> None:
        self.quitting = True
        if self.server_thread and self.server_thread.isRunning():
            self.server_thread.stop()
            self.server_thread.wait(4_000)
        self.tray.hide()
        QApplication.quit()

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.quitting:
            event.accept()
            return
        event.ignore()
        self.hide()
        self.tray.showMessage(APP_NAME, "서버가 알림 영역에서 계속 실행됩니다.")


def main() -> None:
    application = QApplication(sys.argv)
    application.setApplicationName(APP_NAME)
    application.setWindowIcon(create_app_icon())
    application.setQuitOnLastWindowClosed(False)

    existing_instance = QLocalSocket()
    existing_instance.connectToServer(INSTANCE_SERVER_NAME)
    if existing_instance.waitForConnected(500):
        existing_instance.write(b"show")
        existing_instance.waitForBytesWritten(500)
        return

    QLocalServer.removeServer(INSTANCE_SERVER_NAME)
    instance_server = QLocalServer(application)
    if not instance_server.listen(INSTANCE_SERVER_NAME):
        QMessageBox.critical(None, APP_NAME, "프로그램의 단일 실행 채널을 만들 수 없습니다.")
        return

    window = MainWindow()

    def show_existing_window() -> None:
        while instance_server.hasPendingConnections():
            connection = instance_server.nextPendingConnection()
            connection.readAll()
            connection.disconnectFromServer()
        window._show_window()

    instance_server.newConnection.connect(show_existing_window)
    window.show()
    exit_code = application.exec()
    instance_server.close()
    sys.exit(exit_code)


if __name__ == "__main__":
    main()