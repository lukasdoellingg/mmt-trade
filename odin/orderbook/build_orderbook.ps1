# Build Odin orderbook mesh helper to WebAssembly
# Usage: powershell ./odin/orderbook/build_orderbook.ps1

$ErrorActionPreference = "Stop"

$ODIN_ROOT = "C:\Odin\Odin-master"
$OUT_DIR = Join-Path $PSScriptRoot "..\..\web\frontend\public"
$OUT = Join-Path $OUT_DIR "orderbook_engine.wasm"

if (!(Test-Path $OUT_DIR)) { New-Item -ItemType Directory -Path $OUT_DIR -Force | Out-Null }

$ODIN_EXE = if (Test-Path (Join-Path $ODIN_ROOT "bin\odin.exe")) { Join-Path $ODIN_ROOT "bin\odin.exe" }
  elseif (Test-Path (Join-Path $ODIN_ROOT "odin.exe")) { Join-Path $ODIN_ROOT "odin.exe" }
  elseif (Get-Command odin -ErrorAction SilentlyContinue) { "odin" }
  else { $null }
if (!$ODIN_EXE) {
  Write-Host "Odin nicht gefunden. ODIN_ROOT in build_orderbook.ps1 anpassen." -ForegroundColor Red
  exit 1
}

Write-Host "Building orderbook_engine.wasm..." -ForegroundColor Cyan
& $ODIN_EXE build $PSScriptRoot `
  -target:js_wasm32 `
  -o:speed `
  -out:$OUT `
  -no-entry-point

if ($LASTEXITCODE -eq 0) {
  $kb = [math]::Round((Get-Item $OUT).Length / 1024, 1)
  Write-Host "OK: $OUT ($kb KB)" -ForegroundColor Green
} else {
  exit 1
}
