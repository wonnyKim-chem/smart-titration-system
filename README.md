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

모바일 브라우저의 `getUserMedia`는 신뢰된 보안 컨텍스트에서만 동작합니다. PC의 `localhost`는 HTTP 예외가 적용되지만, 휴대폰에서 `http://192.168.x.x:8000`처럼 접속하면 카메라 API가 제공되지 않습니다. iPhone의 Safari와 Chrome은 모두 iOS의 WebKit 카메라 계층을 사용하므로 두 브라우저에 동일하게 HTTPS가 필요합니다.

### 1. Windows에서 로컬 인증서 만들기

```powershell
winget install FiloSottile.mkcert
.\setup-ios-https.ps1
```

스크립트가 선택한 IP가 실제 Wi-Fi 주소와 다르면 다음처럼 직접 지정합니다.

```powershell
.\setup-ios-https.ps1 -IpAddress 192.168.0.28
```

Wi-Fi가 바뀌어 PC의 IP가 변경되면 새 IP로 인증서를 다시 만들어야 합니다.

### 2. iPhone에서 인증기관 신뢰하기

1. 스크립트가 출력한 `rootCA.pem` 파일을 AirDrop, iCloud Drive 또는 이메일로 iPhone에 전송합니다. 개인키인 `rootCA-key.pem`은 절대로 전송하지 않습니다.
2. iPhone에서 `rootCA.pem`을 열고 프로파일 다운로드를 허용합니다.
3. `설정 > 일반 > VPN 및 기기 관리 > 다운로드된 프로파일`에서 프로파일을 설치합니다.
4. `설정 > 일반 > 정보 > 인증서 신뢰 설정`에서 설치한 mkcert 인증서의 `완전 신뢰`를 켭니다.

### 3. HTTPS 서버 실행하기

프로젝트의 PowerShell 창에서 다음 명령을 실행합니다.

```powershell
$env:TITRATION_SSL_CERT = "$PWD\certs\titration.pem"
$env:TITRATION_SSL_KEY = "$PWD\certs\titration-key.pem"
python main.py
```

콘솔 QR 코드의 주소가 반드시 `https://`로 시작해야 합니다. iPhone과 PC는 같은 Wi-Fi에 연결되어 있어야 하며, Windows 방화벽에서 TCP 8000과 iPhone의 해당 브라우저에 대한 `로컬 네트워크` 접근을 허용해야 합니다.

### 4. iPhone 권한 확인하기

- Safari: `설정 > 앱 > Safari > 카메라`를 `묻기` 또는 `허용`으로 설정합니다. 사이트를 연 뒤 주소 막대의 페이지 메뉴에서 해당 웹사이트의 카메라 권한도 허용합니다.
- Chrome: `설정 > 개인정보 보호 및 보안 > 카메라`에서 Chrome을 허용하고, `설정 > 앱 > Chrome > 로컬 네트워크`도 켭니다.
- 이전에 거부했다면 브라우저 탭을 닫고 다시 열거나 해당 사이트의 웹사이트 데이터를 삭제한 뒤 다시 허용합니다.
- Safari와 Chrome의 권한은 앱별로 관리되므로 한쪽에서 허용해도 다른 쪽에는 자동 적용되지 않습니다.

카메라 시작 후 iPhone 상단에 녹색 카메라 사용 표시가 나타나야 합니다. 녹색 표시가 없으면 HTTPS 또는 권한 문제이고, 녹색 표시는 있지만 화면이 멈추면 다른 카메라 앱을 종료한 뒤 페이지를 새로고침합니다.

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