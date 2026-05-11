@echo off
REM Doppelklick oder:  odin\build_engine.bat
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_engine.ps1"
if errorlevel 1 pause
exit /b %ERRORLEVEL%
