# Build Odin chart engine to WebAssembly
# Usage: ./build_engine.ps1
# Odin-Pfad: C:\Odin\Odin-master (anpassen falls noetig)

$ErrorActionPreference = "Stop"

$ODIN_ROOT = "C:\Odin\Odin-master"
$SRC = Join-Path $PSScriptRoot "engine.odin"
$OUT_DIR = Join-Path $PSScriptRoot "..\web\frontend\public"
$OUT = Join-Path $OUT_DIR "engine.wasm"

if (!(Test-Path $OUT_DIR)) { New-Item -ItemType Directory -Path $OUT_DIR -Force | Out-Null }

$ODIN_EXE = if (Test-Path (Join-Path $ODIN_ROOT "bin\odin.exe")) { Join-Path $ODIN_ROOT "bin\odin.exe" }
  elseif (Test-Path (Join-Path $ODIN_ROOT "odin.exe")) { Join-Path $ODIN_ROOT "odin.exe" }
  elseif (Get-Command odin -ErrorAction SilentlyContinue) { "odin" }
  else { $null }
if (!$ODIN_EXE) {
  Write-Host "Odin nicht gefunden unter $ODIN_ROOT\bin\odin.exe" -ForegroundColor Red
  Write-Host "ODIN_ROOT in Zeile 8 anpassen oder Odin in PATH aufnehmen." -ForegroundColor Yellow
  exit 1
}

Write-Host "Building Odin WASM chart engine..." -ForegroundColor Cyan
Write-Host "  Source: $SRC" -ForegroundColor Gray
Write-Host "  Output: $OUT" -ForegroundColor Gray

& $ODIN_EXE build $PSScriptRoot `
  -target:js_wasm32 `
  -o:speed `
  -out:$OUT `
  -no-entry-point

if ($LASTEXITCODE -eq 0) {
    $size = (Get-Item $OUT).Length
    $sizeKB = [math]::Round($size / 1024, 1)
    Write-Host "OK: $OUT ($sizeKB KB)" -ForegroundColor Green
} else {
    Write-Host "BUILD FAILED (exit code $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}
