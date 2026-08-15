from __future__ import annotations

import json
import logging
import os
import socket
import ssl
import subprocess
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
    QCheckBox,
    QDialog,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QInputDialog,
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

from certificate_manager import (
    ensure_short_lived_server_certificate,
    get_local_ca_paths,
    read_certificate_expiry,
)
from main import (
    app,
    get_default_certificate_paths,
    get_local_ip,
    get_recordings_directory,
    hub,
    resolve_tls_configuration,
)
from wifi_share import (
    build_wifi_qr_payload,
    get_connected_ssid,
    get_wifi_profiles,
    read_wifi_profile,
)


APP_NAME = "Smart Titration"
DEFAULT_PORT = 8000
INSTANCE_SERVER_NAME = "SmartTitrationServerLauncher"


def get_launcher_settings_path() -> Path:
    directory = Path(os.getenv("LOCALAPPDATA", Path.home())) / "SmartTitration"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / "settings.json"


def load_auto_renew_setting() -> bool:
    try:
        settings = json.loads(get_launcher_settings_path().read_text(encoding="utf-8"))
        return bool(settings.get("autoRenewCertificate", False))
    except (OSError, ValueError, TypeError):
        return False


def save_auto_renew_setting(enabled: bool) -> None:
    path = get_launcher_settings_path()
    path.write_text(
        json.dumps({"autoRenewCertificate": enabled}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


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
        expires_text = time.strftime("%Y-%m-%d %H:%M", time.localtime(expires_at))
        ca_expiry = read_certificate_expiry(get_local_ca_paths()[0])
        ca_text = ca_expiry.astimezone().strftime("%Y-%m-%d") if ca_expiry else "확인 불가"
        return True, f"서버 인증서 만료 {expires_text} · 자동 갱신 · 모바일 신뢰 CA 만료 {ca_text}"
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
        self.auto_renew_certificate = load_auto_renew_setting()
        self.was_server_running = False
        self.restart_after_certificate_renewal = False
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
        self.certificate_timer = QTimer(self)
        self.certificate_timer.setInterval(30 * 60 * 1000)
        self.certificate_timer.timeout.connect(self._maintain_short_lived_certificate)
        if self.auto_renew_certificate:
            self.certificate_timer.start()
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
        self.wifi_button = QPushButton("Wi-Fi 초대")
        self.wifi_button.clicked.connect(self._show_wifi_share)
        action_row.addWidget(self.copy_button)
        action_row.addWidget(self.open_button)
        action_row.addWidget(self.wifi_button)
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
        certificate_title = QLabel("HTTPS 필수 보안 설정")
        certificate_title.setObjectName("sectionTitle")
        self.certificate_status = QLabel("확인 중")
        self.certificate_status.setObjectName("certificateStatus")
        self.certificate_detail = QLabel("")
        self.certificate_detail.setWordWrap(True)
        self.certificate_detail.setObjectName("mutedText")
        self.auto_renew_status = QLabel("")
        self.auto_renew_status.setObjectName("mutedText")
        self.auto_renew_toggle = QCheckBox("만료 2시간 전 자동 갱신 및 서버 재시작")
        self.auto_renew_toggle.setChecked(self.auto_renew_certificate)
        self.auto_renew_toggle.toggled.connect(self._set_auto_renew_certificate)
        certificate_reason = QLabel(
            "서버 시작과 모바일 브라우저 카메라 사용에는 신뢰된 HTTPS가 필수입니다. "
            "카메라를 사용할 iPhone·Android에도 로컬 CA 인증서를 설치하고 신뢰해야 합니다."
        )
        certificate_reason.setWordWrap(True)
        certificate_reason.setObjectName("requiredNotice")
        certificate_actions = QHBoxLayout()
        self.setup_certificate_button = QPushButton("HTTPS 필수 설정")
        self.setup_certificate_button.setObjectName("primaryButton")
        self.setup_certificate_button.clicked.connect(self._setup_certificate)
        self.open_certificate_button = QPushButton("인증서 폴더")
        self.open_certificate_button.clicked.connect(self._open_certificate_folder)
        certificate_actions.addWidget(self.setup_certificate_button)
        certificate_actions.addWidget(self.open_certificate_button)
        certificate_layout.addWidget(certificate_title)
        certificate_layout.addWidget(self.certificate_status)
        certificate_layout.addWidget(self.certificate_detail)
        certificate_layout.addWidget(self.auto_renew_status)
        certificate_layout.addWidget(self.auto_renew_toggle)
        certificate_layout.addWidget(certificate_reason)
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
        self.temperature_metric = MetricWidget("온도 레코드")
        self.color_metric = MetricWidget("색 레코드")
        self.camera_metric = MetricWidget("카메라 연결")
        self.matched_metric = MetricWidget("시간 정합")
        metrics.addWidget(self.volume_metric, 0, 0)
        metrics.addWidget(self.ph_metric, 0, 1)
        metrics.addWidget(self.temperature_metric, 1, 0)
        metrics.addWidget(self.color_metric, 1, 1)
        metrics.addWidget(self.camera_metric, 2, 0)
        metrics.addWidget(self.matched_metric, 2, 1)
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
            QLabel#requiredNotice {
                padding: 9px 10px;
                border-left: 4px solid #f1c84a;
                color: #5b574a;
                background: #fff8dc;
                font-size: 11px;
            }
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
        if not self._server_is_running():
            certificate, private_key = get_default_certificate_paths()
            try:
                renewed, expires_at = ensure_short_lived_server_certificate(
                    self.ip_address,
                    certificate,
                    private_key,
                    renew_before_hours=2 if self.auto_renew_certificate else 0,
                )
                if renewed and expires_at:
                    self._append_log(
                        f"24시간 HTTPS 서버 인증서를 발급했습니다. 만료: {expires_at.astimezone():%Y-%m-%d %H:%M}"
                    )
            except RuntimeError as error:
                self._append_log(f"HTTPS 인증서 준비 필요: {error}")
        valid, detail = inspect_certificate(self.ip_address)
        self.certificate_status.setText("필수 설정 완료" if valid else "필수 설정 미완료")
        self.certificate_status.setStyleSheet("color: #087f6d;" if valid else "color: #c44235;")
        self.certificate_detail.setText(detail)
        self.auto_renew_status.setText(
            "실행 중 만료 2시간 전 자동 갱신: 켜짐"
            if self.auto_renew_certificate
            else "실행 중 만료 2시간 전 자동 갱신: 꺼짐 (기본값)"
        )
        self.start_button.setEnabled(valid and not self._server_is_running())
        return valid

    def _auto_start_server(self) -> None:
        if self._refresh_certificate_state():
            self._start_server()
        else:
            self.server_status.setText("HTTPS 필수 설정 미완료")
            self.qr_label.setText("HTTPS 필수 설정을 완료하면\n서버와 카메라 QR 코드가 활성화됩니다.")

    def _server_is_running(self) -> bool:
        return bool(self.server_thread and self.server_thread.is_serving)

    def _start_server(self) -> None:
        if self.server_thread and self.server_thread.isRunning():
            return
        if not self._refresh_certificate_state():
            QMessageBox.warning(
                self,
                "HTTPS 필수 설정 미완료",
                "서버와 모바일 브라우저 카메라를 사용하려면 HTTPS 필수 설정을 먼저 완료하세요.\n\n"
                + self.certificate_detail.text(),
            )
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
        if self.restart_after_certificate_renewal:
            self.restart_after_certificate_renewal = False
            QTimer.singleShot(300, self._start_server)

    def _maintain_short_lived_certificate(self) -> None:
        if not self.auto_renew_certificate:
            return
        certificate, private_key = get_default_certificate_paths()
        try:
            renewed, expires_at = ensure_short_lived_server_certificate(
                self.ip_address, certificate, private_key, renew_before_hours=2
            )
        except RuntimeError as error:
            self._append_log(f"24시간 인증서 자동 갱신 실패: {error}")
            return
        if not renewed:
            return
        self._append_log(
            f"24시간 HTTPS 인증서를 자동 갱신했습니다. 만료: {expires_at.astimezone():%Y-%m-%d %H:%M}"
        )
        if self._server_is_running():
            self.restart_after_certificate_renewal = True
            self._stop_server()
        else:
            self._refresh_certificate_state()

    def _set_auto_renew_certificate(self, enabled: bool) -> None:
        self.auto_renew_certificate = enabled
        save_auto_renew_setting(enabled)
        if self.auto_renew_toggle.isChecked() != enabled:
            self.auto_renew_toggle.blockSignals(True)
            self.auto_renew_toggle.setChecked(enabled)
            self.auto_renew_toggle.blockSignals(False)
        if enabled:
            self.certificate_timer.start()
        else:
            self.certificate_timer.stop()
        self.auto_renew_status.setText(
            "실행 중 만료 2시간 전 자동 갱신: 켜짐"
            if enabled
            else "실행 중 만료 2시간 전 자동 갱신: 꺼짐 (기본값)"
        )

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
        self.temperature_metric.set_value(str(len(hub.streams["temperature"])))
        self.color_metric.set_value(str(len(hub.streams["color"])))
        connected_cameras = sum(len(clients) for clients in hub.measurement_clients.values())
        self.camera_metric.set_value(str(connected_cameras))
        self.matched_metric.set_value(str(hub.latest_analysis.get("matchedCount", 0)))

    def _setup_certificate(self) -> None:
        if self.certificate_process and self.certificate_process.state() != QProcess.ProcessState.NotRunning:
            return
        dialog = QDialog(self)
        dialog.setWindowTitle("HTTPS 필수 설정")
        dialog.setModal(True)
        dialog.setMinimumWidth(560)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(24, 22, 24, 24)
        title = QLabel("서버와 모바일 카메라에 필요한 HTTPS 설정")
        title.setObjectName("sectionTitle")
        description = QLabel(
            "Smart Titration 서버와 모바일 브라우저 카메라는 신뢰된 HTTPS 연결에서만 작동하므로 "
            "이 설정은 서버 시작에 필수입니다.\n\n"
            "이 PC에 Smart Titration 전용 로컬 인증기관을 설치하고 현재 IP용 HTTPS 서버 인증서를 만듭니다. "
            "Windows가 인증기관 설치 확인 창을 표시할 수 있습니다.\n\n"
            "카메라를 사용할 iPhone·Android에도 SmartTitration-RootCA.crt를 한 번 설치하고 신뢰해야 합니다. "
            "이 인증서는 카메라 접근 권한이나 외부 전송 권한을 주는 것이 아니라, 로컬 HTTPS 통신을 "
            "암호화하고 서버 신원을 확인하는 용도입니다.\n\n"
            "서버 인증서는 발급 후 24시간만 유효합니다. 앱이 꺼져 있으면 갱신되지 않으며, 만료된 경우 "
            "다음 EXE 실행 시 서버 시작 전에 새 인증서를 발급합니다. 모바일 신뢰 CA는 장기 인증서이므로 "
            "매일 다시 설치하지 않습니다."
        )
        description.setWordWrap(True)
        description.setObjectName("mutedText")
        auto_renew_checkbox = QCheckBox(
            "앱 실행 중 인증서가 만료 2시간 이내이면 자동 갱신하고 HTTPS 서버 재시작"
        )
        auto_renew_checkbox.setChecked(self.auto_renew_certificate)
        auto_renew_checkbox.setObjectName("autoRenewCertificate")
        auto_renew_note = QLabel(
            "기본값은 꺼짐입니다. 끄면 실행 중 사전 갱신하지 않으며 인증서가 만료될 수 있습니다."
        )
        auto_renew_note.setWordWrap(True)
        auto_renew_note.setObjectName("mutedText")
        actions = QHBoxLayout()
        cancel_button = QPushButton("취소")
        continue_button = QPushButton("필수 설정 진행")
        continue_button.setObjectName("primaryButton")
        cancel_button.clicked.connect(dialog.reject)
        continue_button.clicked.connect(dialog.accept)
        actions.addStretch()
        actions.addWidget(cancel_button)
        actions.addWidget(continue_button)
        layout.addWidget(title)
        layout.addWidget(description)
        layout.addWidget(auto_renew_checkbox)
        layout.addWidget(auto_renew_note)
        layout.addLayout(actions)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        self._set_auto_renew_certificate(auto_renew_checkbox.isChecked())
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
            renewal_text = (
                "실행 중 만료 2시간 전 자동 갱신을 사용합니다."
                if self.auto_renew_certificate
                else "실행 중 자동 갱신은 꺼져 있습니다. 만료 후 다음 EXE 실행 시 새 인증서를 발급합니다."
            )
            QMessageBox.information(
                self,
                "HTTPS 설정 완료",
                "HTTPS 필수 설정이 완료되었습니다. 서버 인증서는 발급 후 24시간 유효합니다.\n"
                f"{renewal_text}\n\n"
                "카메라를 사용할 모바일 기기에 SmartTitration-RootCA.crt를 한 번 설치하고 신뢰하세요.",
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

    def _show_wifi_share(self) -> None:
        warning = QMessageBox.warning(
            self,
            "Wi-Fi 암호가 포함된 QR",
            "이 QR을 스캔한 사람은 선택한 Wi-Fi에 암호 입력 없이 접속할 수 있습니다.\n\n"
            "암호는 화면 텍스트나 로그에 표시하지 않으며 QR 창을 닫은 뒤 메모리에 보관하지 않습니다. "
            "신뢰하는 사람에게만 보여주세요. 계속할까요?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel,
        )
        if warning != QMessageBox.StandardButton.Yes:
            return

        try:
            profiles = get_wifi_profiles()
            if not profiles:
                raise RuntimeError("Windows에 저장된 Wi-Fi 프로필이 없습니다.")
            connected = get_connected_ssid()
            default_index = profiles.index(connected) if connected in profiles else 0
            profile, accepted = QInputDialog.getItem(
                self,
                "Wi-Fi 선택",
                "초대할 Wi-Fi 프로필을 선택하세요.",
                profiles,
                default_index,
                False,
            )
            if not accepted:
                return
            ssid, security, password, hidden = read_wifi_profile(profile)
            payload = build_wifi_qr_payload(ssid, security, password, hidden)
        except (OSError, subprocess.SubprocessError, RuntimeError) as error:
            QMessageBox.critical(self, "Wi-Fi QR 생성 실패", str(error))
            return

        dialog = QDialog(self)
        dialog.setWindowTitle("Wi-Fi 초대")
        dialog.setModal(True)
        dialog.setMinimumWidth(360)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(24, 22, 24, 24)
        title = QLabel("Wi-Fi 연결 QR")
        title.setObjectName("sectionTitle")
        subtitle = QLabel(f"SSID: {ssid}\n모바일 카메라로 스캔해 네트워크에 연결하세요.")
        subtitle.setWordWrap(True)
        subtitle.setObjectName("mutedText")
        qr_label = QLabel()
        qr_label.setPixmap(create_qr_pixmap(payload, 260))
        qr_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        close_button = QPushButton("QR 닫기")
        close_button.setObjectName("primaryButton")
        close_button.clicked.connect(dialog.accept)
        layout.addWidget(title)
        layout.addWidget(subtitle)
        layout.addWidget(qr_label, 0, Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(close_button)
        password = ""
        payload = ""
        dialog.exec()

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

    def _prompt_close_action(self) -> str:
        message = QMessageBox(self)
        message.setWindowTitle("Smart Titration 닫기")
        message.setIcon(QMessageBox.Icon.Question)
        message.setText("서버 창을 닫으시겠습니까?")
        message.setInformativeText(
            "서버를 종료하면 연결된 모바일 카메라와 대시보드 연결도 모두 끊깁니다."
        )
        exit_button = message.addButton("서버 종료", QMessageBox.ButtonRole.DestructiveRole)
        tray_button = message.addButton(
            "트레이에서 계속 실행", QMessageBox.ButtonRole.AcceptRole
        )
        cancel_button = message.addButton("취소", QMessageBox.ButtonRole.RejectRole)
        message.setDefaultButton(tray_button)
        message.exec()
        if message.clickedButton() is exit_button:
            return "exit"
        if message.clickedButton() is tray_button:
            return "tray"
        if message.clickedButton() is cancel_button:
            return "cancel"
        return "cancel"

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.quitting:
            event.accept()
            return
        action = self._prompt_close_action()
        if action == "tray":
            event.ignore()
            self.hide()
            self.tray.showMessage(APP_NAME, "서버가 알림 영역에서 계속 실행됩니다.")
            return
        if action == "exit":
            self.quitting = True
            if self.server_thread and self.server_thread.isRunning():
                self.server_thread.stop()
                self.server_thread.wait(4_000)
            self.tray.hide()
            event.accept()
            QTimer.singleShot(0, QApplication.quit)
            return
        event.ignore()


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