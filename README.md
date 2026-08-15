# Smart Titration Curve Analysis System

두 모바일 카메라에서 뷰렛 부피와 pH 계측기 표시값을 읽고, 시간 기준으로 결합해 적정 곡선과 당량점을 실시간 분석하는 FastAPI 웹 시스템입니다.

## 구성

```text
.
├─ main.py                  FastAPI, WebSocket, 시간 정합, SciPy 분석
├─ static/
│  ├─ burette.html/js       뷰렛 원근 보정과 메니스커스 추적
│  ├─ ph-meter.html/js      LCD ROI와 7세그먼트 OCR
│  ├─ dashboard.html/js     Plotly 실시간 분석 화면
│  ├─ offline-store.js      IndexedDB 영구 큐
│  └─ reliable-socket.js    ACK 기반 재접속·배치 동기화
├─ tests/test_main.py
├─ titration.spec
└─ build.ps1
```

## 개발 실행

Python 3.11 이상이 필요합니다.

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python main.py
```

서버는 `0.0.0.0:8000`에서 실행되며, 콘솔에 로컬 IP 주소와 QR 코드가 표시됩니다. Windows 방화벽에서 TCP 8000 인바운드 연결을 허용해야 다른 기기가 접속할 수 있습니다.

| 경로 | 화면 |
| --- | --- |
| `/` | 실시간 분석 대시보드 |
| `/burette` | 뷰렛 카메라 |
| `/ph-meter` | pH 계측기 카메라 |

## 모바일 카메라와 HTTPS

모바일 브라우저의 `getUserMedia`는 신뢰된 보안 컨텍스트에서만 동작합니다. PC의 `localhost`는 HTTP 예외가 적용되지만, 휴대폰에서 `http://192.168.x.x:8000`처럼 접속하면 카메라 권한이 차단될 수 있습니다.

로컬 인증서를 휴대폰에서도 신뢰하도록 설치한 뒤 다음 환경 변수를 설정하면 서버와 QR 코드가 HTTPS 주소를 사용합니다.

```powershell
$env:TITRATION_SSL_CERT = "C:\certs\titration.crt"
$env:TITRATION_SSL_KEY = "C:\certs\titration.key"
python main.py
```

OpenCV.js, Plotly.js, Lucide 및 웹 글꼴은 CDN에서 불러옵니다. 인터넷이 차단된 실험망에서는 해당 파일을 `static/vendor`에 내려받고 HTML의 스크립트·글꼴 주소를 로컬 경로로 바꿔야 합니다. 측정 레코드는 네트워크 상태와 무관하게 IndexedDB에 먼저 기록되며, 연결 복구 시 200개 단위로 서버에 재전송됩니다.

## 보정과 판독

1. 뷰렛 화면에서 액면을 0.00 mL에 맞춘 후 `0 mL 설정`을 누릅니다.
2. 알려진 부피만큼 배출하고 기준 부피를 입력한 후 `기준점 설정`을 누릅니다.
3. pH 화면에서 노란 사각형이 LCD 숫자 영역과 일치하도록 X, Y, 너비, 높이를 조절합니다.
4. LCD 종류에 맞춰 어두운 숫자 또는 밝은 숫자를 선택하고 임계값을 조절합니다.

## 테스트

```powershell
python -m pytest -q
```

## Windows 실행 파일

```powershell
.\build.ps1 -Clean
```

결과는 `dist\SmartTitration\SmartTitration.exe`에 생성됩니다. `COLLECT` 방식이므로 배포할 때 `dist\SmartTitration` 폴더 전체를 함께 복사해야 합니다.