@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0network.ps1"
set "CHECK_EXIT=%ERRORLEVEL%"
echo.
echo Network diagnostic finished. Logs: C:\PikoSandboxResults\network-report.json
pause
exit /b %CHECK_EXIT%
