param(
    [string]$IpAddress
)

$ErrorActionPreference = "Stop"

function Find-Mkcert {
    $command = Get-Command mkcert -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $packageRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path $packageRoot) {
        return Get-ChildItem $packageRoot -Filter "mkcert.exe" -Recurse -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName -First 1
    }

    return $null
}

$mkcert = Find-Mkcert
if (-not $mkcert) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "mkcert is missing and winget is unavailable. Install mkcert, then run this script again."
    }

    Write-Host "Installing mkcert with winget..."
    winget install --id FiloSottile.mkcert --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget failed to install mkcert."
    }

    $mkcert = Find-Mkcert
    if (-not $mkcert) {
        throw "mkcert was installed but its executable could not be found. Open a new PowerShell window and retry."
    }
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
    throw "Local IPv4 address was not found. Specify it with -IpAddress."
}

$certificateDirectory = Join-Path $env:LOCALAPPDATA "SmartTitration\certs"
New-Item -ItemType Directory -Path $certificateDirectory -Force | Out-Null

& $mkcert -install
if ($LASTEXITCODE -ne 0) {
    throw "mkcert failed to install its local certificate authority."
}

& $mkcert `
    -cert-file (Join-Path $certificateDirectory "titration.pem") `
    -key-file (Join-Path $certificateDirectory "titration-key.pem") `
    $IpAddress localhost 127.0.0.1 ::1
if ($LASTEXITCODE -ne 0) {
    throw "mkcert failed to create the HTTPS certificate."
}

$certificateAuthorityDirectory = & $mkcert -CAROOT
$mobileCertificate = Join-Path $certificateDirectory "SmartTitration-RootCA.crt"
Copy-Item (Join-Path $certificateAuthorityDirectory "rootCA.pem") $mobileCertificate -Force
$env:TITRATION_SSL_CERT = Join-Path $certificateDirectory "titration.pem"
$env:TITRATION_SSL_KEY = Join-Path $certificateDirectory "titration-key.pem"
Write-Host ""
Write-Host "HTTPS certificate setup completed."
Write-Host "Transfer this file to the mobile device: $mobileCertificate"
Write-Host "Server URL: https://${IpAddress}:8000"
Write-Host "The EXE will discover the certificate automatically."