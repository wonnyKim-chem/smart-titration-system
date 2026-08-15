param(
    [string]$IpAddress
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
    throw "mkcert가 필요합니다. 먼저 'winget install FiloSottile.mkcert'를 실행하세요."
}

if (-not $IpAddress) {
    $defaultRoute = Get-NetRoute -DestinationPrefix "0.0.0.0/0" |
        Sort-Object RouteMetric |
        Select-Object -First 1
    $IpAddress = Get-NetIPAddress -InterfaceIndex $defaultRoute.InterfaceIndex -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike "169.254.*" } |
        Select-Object -ExpandProperty IPAddress -First 1
}

if (-not $IpAddress) {
    throw "로컬 IPv4 주소를 찾지 못했습니다. -IpAddress 매개변수로 직접 지정하세요."
}

$certificateDirectory = Join-Path $PSScriptRoot "certs"
New-Item -ItemType Directory -Path $certificateDirectory -Force | Out-Null

mkcert -install
mkcert `
    -cert-file (Join-Path $certificateDirectory "titration.pem") `
    -key-file (Join-Path $certificateDirectory "titration-key.pem") `
    $IpAddress localhost 127.0.0.1 ::1

$certificateAuthorityDirectory = mkcert -CAROOT
Write-Host ""
Write-Host "인증서 생성 완료"
Write-Host "iPhone으로 전송할 파일: $certificateAuthorityDirectory\rootCA.pem"
Write-Host "서버 접속 주소: https://${IpAddress}:8000"
Write-Host "README의 iPhone 인증서 신뢰 설정을 완료한 뒤 HTTPS로 서버를 실행하세요."