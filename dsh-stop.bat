@echo off
setlocal enabledelayedexpansion
title DSH QQ - stop and shutdown

rem ============================================================
rem  Stop the QQ chat stack, then shut the machine down.
rem
rem  Flow: confirm dialog -> farewell message -> stop services -> shutdown.
rem  Declining the dialog exits without touching anything.
rem
rem  Usage:
rem    dsh-stop.bat               confirm, farewell, stop, shutdown in 60s (cancel: shutdown /a)
rem    dsh-stop.bat noshutdown    confirm, farewell, stop services only
rem    dsh-stop.bat 0             shutdown immediately after confirm
rem    dsh-stop.bat 300           shutdown 300s after confirm
rem    dsh-stop.bat --yes         skip the confirm dialog (for scripts/tests)
rem
rem  Implementation notes (learned the hard way):
rem   * NEVER use "taskkill /IM node.exe": SnowLuma's bundled runtime is also
rem     node.exe, so an image-name kill takes it down too. Resolve the PID from
rem     the listening port instead and kill only that PID.
rem   * taskkill WITHOUT /F does not terminate a windowless node process
rem     (observed: still alive after 15s). Use /F on the resolved PID, then
rem     clean the stale state\bridge.lock if the process could not flush it.
rem   * NEVER use `timeout` here: it aborts with "Input redirection is not
rem     supported" whenever stdin is redirected. ping-based delay works everywhere.
rem   * KEEP THIS FILE PURE ASCII: cmd.exe parses .bat byte by byte using the
rem     ANSI code page, so UTF-8 comments get misread as commands.
rem ============================================================

rem CONFIGURE: path to the node.exe that DSH uses (only if yours differs)
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
rem Bridge directory = the folder this script lives in (no need to edit)
set "BRIDGE=%~dp0"
if "%BRIDGE:~-1%"=="\" set "BRIDGE=%BRIDGE:~0,-1%"
set "BRIDGE_STATE=%BRIDGE%\state"
set "DELAY=%~1"
set "SKIP_CONFIRM="
if /I "%DELAY%"=="--yes" (
  set "SKIP_CONFIRM=1"
  set "DELAY=%~2"
)
if "%DELAY%"=="" set "DELAY=60"
set "DO_SHUTDOWN=1"
if /I "%DELAY%"=="noshutdown" set "DO_SHUTDOWN="
if /I "%DELAY%"=="no" set "DO_SHUTDOWN="

echo ================================================================
echo   DSH QQ chat - stopping
echo ================================================================
echo.

rem ---------- 0. confirm ----------
rem The dialog lives in tools\scripts\confirm-close.mjs on purpose: cmd.exe parses
rem .bat byte by byte with the ANSI code page, so Chinese dialog text must not be
rem embedded here. Node keeps this file pure ASCII.
if defined SKIP_CONFIRM goto confirmed
echo Asking for confirmation - check the dialog box...
if not exist "%NODE%" (
  echo ERROR: node not found, cannot confirm. Aborting without changes.
  exit /b 1
)
"%NODE%" "%BRIDGE%\tools\scripts\confirm-close.mjs"
if errorlevel 1 (
  echo Cancelled. Nothing was changed.
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)
:confirmed
echo   Confirmed, proceeding.
echo.

rem ---------- 1. farewell message (before stopping, while OneBot is alive) ----------
if exist "%NODE%" (
  "%NODE%" "%BRIDGE%\tools\scripts\farewell.mjs"
) else (
  echo   [farewell] skipped: node not found
)

rem ---------- 2. bridge (PID resolved from port 3100) ----------
call :pid_on_port 3100 BR_PID
if not defined BR_PID (
  echo [1/3] qq-bridge not running - skip
  goto snowluma_step
)
echo [1/3] Stopping qq-bridge ^(PID %BR_PID%^) ...
taskkill /PID %BR_PID% /T /F >nul 2>&1
ping -n 3 127.0.0.1 >nul
call :pid_on_port 3100 BR_LEFT
if defined BR_LEFT (
  echo       WARNING: PID %BR_LEFT% still listening on 3100.
) else (
  echo       qq-bridge stopped.
)
rem A forced kill skips the exit handler, so the lock file can survive.
if exist "%BRIDGE_STATE%\bridge.lock" (
  del /F /Q "%BRIDGE_STATE%\bridge.lock" >nul 2>&1
  echo       cleaned stale bridge.lock
)

rem ---------- 3. SnowLuma (PID resolved from port 5099) ----------
:snowluma_step
call :pid_on_port 5099 SL_PID
if not defined SL_PID (
  echo [2/3] SnowLuma not running - skip
  goto shutdown_step
)
echo [2/3] Stopping SnowLuma ^(PID %SL_PID%^) ...
taskkill /PID %SL_PID% /T /F >nul 2>&1
ping -n 3 127.0.0.1 >nul
call :pid_on_port 5099 SL_LEFT
if defined SL_LEFT (
  echo       WARNING: PID %SL_LEFT% still listening on 5099.
) else (
  echo       SnowLuma stopped.
)

rem ---------- 4. shutdown ----------
:shutdown_step
if not defined DO_SHUTDOWN (
  echo [3/3] shutdown skipped ^(noshutdown^).
  echo.
  echo Done. The QQ client itself is left running.
  exit /b 0
)
echo [3/3] Shutting down in %DELAY% second^(s^) ...
echo       Cancel with:  shutdown /a
echo.
shutdown /s /t %DELAY% /c "DSH QQ chat stopped. Shutting down."
if errorlevel 1 (
  echo.
  echo       WARNING: shutdown command failed ^(policy or permission^).
  echo       Services are stopped; please shut down manually.
  exit /b 1
)
exit /b 0

rem ---------- helper: resolve the PID listening on a local port ----------
rem Sets %2 to the PID, or leaves it undefined when nothing is listening.
:pid_on_port
set "%~2="
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /R /C:":%~1 .*LISTENING"') do set "%~2=%%p"
exit /b 0
