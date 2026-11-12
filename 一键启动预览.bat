@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WordVault Preview

rem ============================================================
rem  WordVault one-click preview
rem
rem  Double-click  : check Node.js -> install deps on first run
rem                  -> start Vite dev server -> open browser
rem  With "build"  : build the single-file version and open
rem                  dist-single\index.html directly
rem
rem  Example:  one-click-preview.bat build
rem
rem  IMPORTANT: keep this file ASCII-only. cmd.exe parses .bat files
rem  using the system ANSI code page, so UTF-8 Chinese text here
rem  corrupts command lines before chcp can take effect.
rem ============================================================

cd /d "%~dp0"
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo ============================================
echo    WordVault - local preview
echo    %ROOT%
echo ============================================
echo.

rem ---------- 1. sanity checks ----------
if not exist "package.json" (
    echo [ERROR] package.json not found in this folder.
    echo         Please put this .bat in the WordVault project root.
    goto :fail
)

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Install Node.js 20 or newer: https://nodejs.org/
    goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found. Please reinstall Node.js with npm included.
    goto :fail
)

for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo [1/3] Node.js %NODE_VER%

rem ---------- 2. install dependencies on first run ----------
if not exist "node_modules\" (
    echo [2/3] First run: installing dependencies, please wait...
    echo       Slow network? Run this first, then retry:
    echo       set NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Check network or proxy and retry.
        goto :fail
    )
    echo.
) else (
    echo [2/3] node_modules found, skip install.
)

rem ---------- 3. start preview ----------
if /i "%~1"=="build" goto :build

echo [3/3] Starting dev server, browser will open automatically...
echo       Default URL: http://localhost:5173
echo       Hot reload is on. Close this window to stop the server.
echo.
call npm run dev -- --open
echo.
echo Dev server stopped.
goto :done

:build
echo [3/3] Building single-file version...
call npm run build:single
if errorlevel 1 goto :fail
if not exist "dist-single\index.html" (
    echo [ERROR] Build finished but dist-single\index.html was not found.
    goto :fail
)
echo.
echo Build done: %ROOT%\dist-single\index.html
echo Opening it with the default browser...
start "" "%ROOT%\dist-single\index.html"
goto :done

:fail
echo.
echo Preview failed to start. Read the messages above and retry.
:done
echo.
pause
endlocal
