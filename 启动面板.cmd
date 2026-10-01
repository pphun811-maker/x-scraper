@echo off
chcp 65001 >nul
title X Scraper Control Panel
cd /d "%~dp0"

rem Trace every launch: if the window flashes and closes, this file is the only clue.
set "LAUNCH_LOG=%~dp0logs\launcher-trace.log"
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul
>>"%LAUNCH_LOG%" echo [%date% %time%] launcher invoked (args: %*)

rem Find node: prefer PATH, fall back to the default install path.
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE (
  echo.
  echo Node.js not found. Please install Node.js 22 or newer: https://nodejs.org/
  >>"%LAUNCH_LOG%" echo [%date% %time%] node not found
  pause
  exit /b 1
)

rem Let Node fetch use the system proxy too (fallback channel for image downloads).
set "SYSPROXY="
for /f "tokens=3" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer 2^>nul ^| findstr /i ProxyServer') do set "SYSPROXY=%%a"
if defined SYSPROXY (
  set "HTTP_PROXY=http://%SYSPROXY%"
  set "HTTPS_PROXY=http://%SYSPROXY%"
  set "NODE_USE_ENV_PROXY=1"
  rem Keep loopback (panel <-> shadow Chrome CDP) out of the proxy, or Node 24 env-proxy
  rem makes the panel blind to its own debug port.
  set "NO_PROXY=127.0.0.1,localhost"
  set "no_proxy=127.0.0.1,localhost"
  echo System proxy detected: %SYSPROXY% (image downloads will use it)
)

echo Starting control panel ...
>>"%LAUNCH_LOG%" echo [%date% %time%] starting app\server.js with "%NODE_EXE%"
"%NODE_EXE%" "app\server.js"
set "EXITCODE=%errorlevel%"
echo.
echo Panel exited ^(exit code %EXITCODE%^).
>>"%LAUNCH_LOG%" echo [%date% %time%] node exited with code %EXITCODE%
pause
exit /b %EXITCODE%
