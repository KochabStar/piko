@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0rerun-fixed.ps1"
set "CHECK_EXIT=%ERRORLEVEL%"
echo.
echo Fixed-report verification finished. Logs: C:\PikoSandboxResults\report.json
pause
exit /b %CHECK_EXIT%
