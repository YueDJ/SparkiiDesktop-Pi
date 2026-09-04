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
        goto :fail
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
        goto :fail
    )
)

if "%SKIP_BUILD%"=="1" goto :launch

echo [0/3] Installing workspace dependencies...
cd /d "%ROOT%"
if errorlevel 1 (
    echo [ERROR] Cannot change to %ROOT%
    goto :fail
)
call pnpm install
if errorlevel 1 (
    echo [ERROR] pnpm install failed. From the repo root run: pnpm install
    goto :fail
)

cd /d "%APP_DIR%"
if errorlevel 1 (
    echo [ERROR] Cannot change to %APP_DIR%
    goto :fail
)

echo [1/3] Building renderer...
call pnpm build:renderer
if errorlevel 1 goto :fail

echo [2/3] Building main/preload/pi-runtime...
call pnpm build:main
if errorlevel 1 goto :fail

goto :start_electron

:launch
cd /d "%APP_DIR%"
if errorlevel 1 (
    echo [ERROR] Cannot change to %APP_DIR%
    goto :fail
)

:start_electron
if not exist "dist-electron\main\index.js" (
    echo [ERROR] Missing dist-electron\main\index.js. Run start.cmd without --no-build.
    goto :fail
)
if not exist "dist\index.html" (
    echo [ERROR] Missing dist\index.html. Run start.cmd without --no-build.
    goto :fail
)
echo [3/3] Starting Electron...
call pnpm exec electron .
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo [ERROR] start.cmd stopped. Scroll up for the first [ERROR] or build output.
if /I not "%SPARKII_NO_PAUSE%"=="1" pause
exit /b 1
