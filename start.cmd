@echo off
setlocal EnableExtensions

rem ===== Sparkii Desktop local launcher =====
rem Usage:
rem   start.cmd               install deps, build, then launch
rem   start.cmd --no-build    launch only (skip install and rebuild)

set "SKIP_BUILD=0"
if /I "%~1"=="--no-build" set "SKIP_BUILD=1"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "APP_DIR=%ROOT%\apps\desktop"

rem Node fallback for this machine (used only if node is not already on PATH).
if not defined SPARKII_NODE_DIR set "SPARKII_NODE_DIR=%LOCALAPPDATA%\hermes\node"

where node >nul 2>nul
if errorlevel 1 (
    if exist "%SPARKII_NODE_DIR%\node.exe" (
        set "PATH=%SPARKII_NODE_DIR%;%PATH%"
    ) else (
        echo [ERROR] Node.js not found. Install Node.js v22 or newer and add it to PATH.
        exit /b 1
    )
)

where pnpm >nul 2>nul
if errorlevel 1 (
    where corepack >nul 2>nul
    if not errorlevel 1 (
        echo [INFO] pnpm not found, enabling pnpm via corepack...
        call corepack enable
        call corepack prepare pnpm@9.15.0 --activate
    )
)
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [INFO] pnpm not found, installing pnpm@9 once...
    call npm install -g pnpm@9
    if errorlevel 1 (
        echo [ERROR] Failed to install pnpm. Run "npm install -g pnpm@9" or "corepack enable" manually.
        exit /b 1
    )
)

if "%SKIP_BUILD%"=="1" goto :launch

echo [0/3] Installing workspace dependencies...
cd /d "%ROOT%"
if errorlevel 1 (
    echo [ERROR] Cannot change to %ROOT%
    exit /b 1
)
call pnpm install
if errorlevel 1 (
    echo [ERROR] pnpm install failed. From the repo root run: pnpm install
    exit /b 1
)

cd /d "%APP_DIR%"
if errorlevel 1 (
    echo [ERROR] Cannot change to %APP_DIR%
    exit /b 1
)

echo [1/3] Building renderer...
call pnpm build:renderer
if errorlevel 1 exit /b 1

echo [2/3] Building main/preload/pi-runtime...
call pnpm build:main
if errorlevel 1 exit /b 1

goto :start_electron

:launch
cd /d "%APP_DIR%"
if errorlevel 1 (
    echo [ERROR] Cannot change to %APP_DIR%
    exit /b 1
)

:start_electron
echo [3/3] Starting Electron...
call pnpm exec electron .
exit /b %ERRORLEVEL%
