@echo off
setlocal enabledelayedexpansion
title DSH QQ - start

rem ============================================================
rem  One-click start: SnowLuma + qq-bridge
rem
rem  Order matters: wait until SnowLuma's OneBot endpoints are up
rem  before starting the bridge, otherwise the bridge's first WS
rem  attempt fails and it has to run its token self-heal path.
rem
rem  NOTE: never use `timeout` in this script. It aborts with
rem  "Input redirection is not supported" whenever stdin is redirected
rem  (Task Scheduler, piped output, unattended runs). ping-based delay
rem  works everywhere and needs no stdin.
rem ============================================================

rem ============================================================
rem  CONFIGURE THESE PATHS BEFORE FIRST RUN
rem  (only NODE and SNOWLUMA usually need editing)
rem ============================================================
rem Path to the node.exe that DSH uses. Leave as-is only if your DSH
rem runtime lives at this exact location; otherwise point it at any node.
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "DSH_HOME=%USERPROFILE%\.dsh"
rem SnowLuma install directory (third-party QQ client with OneBot support)
set "SNOWLUMA=C:\SnowLuma"
rem Bridge directory = the folder this script lives in (no need to edit)
set "BRIDGE=%~dp0"
if "%BRIDGE:~-1%"=="\" set "BRIDGE=%BRIDGE:~0,-1%"
set "QQBIN=%~dp0"

echo ================================================================
echo   DSH QQ chat - starting
echo ================================================================
echo.

rem ---------- 1. QQ client ----------
tasklist /FI "IMAGENAME eq QQ.exe" 2>nul | find /I "QQ.exe" >nul
if errorlevel 1 (
  echo [1/3] QQ.exe is NOT running.
  echo       Sign in to QQ first, then run this again.
  echo       SnowLuma attaches to a running QQ process.
  echo.
  pause
  exit /b 1
) else (
  echo [1/3] QQ.exe running - OK
)

rem ---------- 2. SnowLuma ----------
set "SL_UP="
for /f "tokens=*" %%i in ('netstat -ano -p TCP ^| findstr /R /C:"127.0.0.1:5099 .*LISTENING"') do set "SL_UP=1"
if defined SL_UP (
  echo [2/3] SnowLuma already listening on 5099 - skip
  goto bridge_step
)
echo [2/3] Starting SnowLuma...
start "SnowLuma" /D "%SNOWLUMA%" cmd /c launcher.bat
echo       waiting for port 5099 ...
set "WAITED=0"
:wait_sl
set "SL_NOW="
for /f "tokens=*" %%i in ('netstat -ano -p TCP ^| findstr /R /C:"127.0.0.1:5099 .*LISTENING"') do set "SL_NOW=1"
if defined SL_NOW goto sl_ready
set /a WAITED+=2
if !WAITED! GEQ 60 (
  echo       WARNING: 5099 not up after 60s. Continuing anyway.
  goto sl_ready
)
ping -n 3 127.0.0.1 >nul
goto wait_sl
:sl_ready
echo       SnowLuma is up.

rem ---------- 3. qq-bridge ----------
:bridge_step
set "BR_UP="
for /f "tokens=*" %%i in ('netstat -ano -p TCP ^| findstr /R /C:"127.0.0.1:3100 .*LISTENING"') do set "BR_UP=1"
if defined BR_UP (
  echo [3/3] qq-bridge already listening on 3100 - skip
  goto done
)
echo [3/3] Starting qq-bridge...
set "QQ_BRIDGE_SKIP_STATE_ACL=1"
set "PATH=%BRIDGE%\node_modules\.bin;%QQBIN%;%PATH%"
start "qq-bridge" /D "%BRIDGE%" cmd /c ""%NODE%" src\bridge.js & echo. & echo [bridge exited] & pause"
ping -n 7 127.0.0.1 >nul

:done
echo.
echo ================================================================
echo   Started.  Bridge console : http://127.0.0.1:3100
echo   SnowLuma WebUI         : http://127.0.0.1:5099
echo   Stop and shutdown      : dsh-stop.bat
echo ================================================================
echo.
ping -n 9 127.0.0.1 >nul
exit /b 0
