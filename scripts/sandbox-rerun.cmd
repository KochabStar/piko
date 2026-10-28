@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0rerun.ps1"
set "CHECK_EXIT=%ERRORLEVEL%"
echo.
echo Verification finished. Logs: C:\PikoSandboxResults\report.json
pause
exit /b %CHECK_EXIT%
