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
.\setup-ios-https.ps1
```

스크립트가 `mkcert`를 찾지 못하면 `winget`으로 자동 설치합니다. 인증서와 키는 한글 경로 문제를 피하기 위해 `%LOCALAPPDATA%\SmartTitration\certs`에 저장됩니다.

스크립트가 선택한 IP가 실제 Wi-Fi 주소와 다르면 다음처럼 직접 지정합니다.

```powershell
.\setup-ios-https.ps1 -IpAddress 192.168.0.28
```

Wi-Fi가 바뀌어 PC의 IP가 변경되면 새 IP로 인증서를 다시 만들어야 합니다.

### 2. iPhone에서 인증기관 신뢰하기

1. 스크립트가 출력한 `SmartTitration-RootCA.crt` 파일을 AirDrop, iCloud Drive 또는 이메일로 iPhone에 전송합니다. 개인키인 `rootCA-key.pem`은 절대로 전송하지 않습니다.
2. iPhone에서 `SmartTitration-RootCA.crt`를 열고 프로파일 다운로드를 허용합니다.
3. `설정 > 일반 > VPN 및 기기 관리 > 다운로드된 프로파일`에서 프로파일을 설치합니다.
4. `설정 > 일반 > 정보 > 인증서 신뢰 설정`에서 설치한 mkcert 인증서의 `완전 신뢰`를 켭니다.

### 3. HTTPS 서버 실행하기

EXE는 `%LOCALAPPDATA%\SmartTitration\certs`의 인증서를 자동으로 찾으므로 환경변수 없이 실행합니다.

```powershell
.\dist\SmartTitration\SmartTitration.exe
```

콘솔 QR 코드의 주소가 반드시 `https://`로 시작해야 합니다. iPhone과 PC는 같은 Wi-Fi에 연결되어 있어야 하며, Windows 방화벽에서 TCP 8000과 iPhone의 해당 브라우저에 대한 `로컬 네트워크` 접근을 허용해야 합니다.

### 4. iPhone 권한 확인하기

- Safari: `설정 > 앱 > Safari > 카메라`를 `묻기` 또는 `허용`으로 설정합니다. 사이트를 연 뒤 주소 막대의 페이지 메뉴에서 해당 웹사이트의 카메라 권한도 허용합니다.
- Chrome: `설정 > 개인정보 보호 및 보안 > 카메라`에서 Chrome을 허용하고, `설정 > 앱 > Chrome > 로컬 네트워크`도 켭니다.
- 이전에 거부했다면 브라우저 탭을 닫고 다시 열거나 해당 사이트의 웹사이트 데이터를 삭제한 뒤 다시 허용합니다.
- Safari와 Chrome의 권한은 앱별로 관리되므로 한쪽에서 허용해도 다른 쪽에는 자동 적용되지 않습니다.

카메라 시작 후 iPhone 상단에 녹색 카메라 사용 표시가 나타나야 합니다. 녹색 표시가 없으면 HTTPS 또는 권한 문제이고, 녹색 표시는 있지만 화면이 멈추면 다른 카메라 앱을 종료한 뒤 페이지를 새로고침합니다.

### 5. Android 설정과 호환성

Android Chrome과 Samsung Internet에서도 카메라, IndexedDB, WebSocket, OpenCV.js 및 기기 방향 이벤트를 사용할 수 있습니다. Android에서도 카메라 API는 신뢰된 HTTPS 연결이 필요합니다.

1. `SmartTitration-RootCA.crt`를 Android 기기로 전송합니다.
2. Pixel 계열은 `설정 > 보안 및 개인정보 보호 > 보안 설정 더보기 > 암호화 및 사용자 인증 정보 > 인증서 설치 > CA 인증서`에서 설치합니다. Samsung 등 다른 제조사는 설정 검색에서 `CA 인증서` 또는 `인증서 설치`를 찾습니다.
3. Chrome 또는 Samsung Internet에서 HTTPS 주소를 엽니다.
4. 사이트의 카메라 권한을 `허용`합니다.
5. Android 12 이상에서 브라우저 앱의 카메라 권한과 시스템의 `카메라 액세스` 빠른 설정이 모두 켜져 있는지 확인합니다.

Android Chrome에서는 iOS의 `DeviceOrientationEvent.requestPermission()` 방식 대신 방향 이벤트를 직접 구독합니다. 현재 클라이언트는 두 방식을 분기 처리하므로 별도 코드 변경이 필요하지 않습니다. 카메라 조건은 강제값이 아닌 `ideal` 값으로 지정되어 있어 960×540 또는 15 FPS를 정확히 지원하지 않는 기기도 브라우저가 가능한 값으로 조정합니다.

공용 또는 관리형 학교 기기는 사용자 CA 설치가 정책으로 차단될 수 있습니다. 이 경우 학교 IT 관리자가 CA를 배포하거나, 추후 공인 도메인과 공인 인증서를 사용하는 구성이 필요합니다.

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