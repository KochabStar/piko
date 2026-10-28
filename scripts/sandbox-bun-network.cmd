@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0bun-network.ps1"
set "CHECK_EXIT=%ERRORLEVEL%"
echo.
echo Diagnostic finished. Logs: C:\PikoSandboxResults\bun-network-report.json
pause
exit /b %CHECK_EXIT%
