param(
    [switch]$Clean
)

if ($Clean) {
    Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
}

python -m PyInstaller --noconfirm titration.spec

if ($LASTEXITCODE -ne 0) {
    throw "실행 파일 빌드에 실패했습니다."
}

Write-Host "완료: dist\SmartTitration\SmartTitration.exe"