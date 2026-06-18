@echo off
REM start.bat -- production launcher for Windows (Docker Desktop).
REM
REM Pulls the prebuilt Backyard Hero image from Docker Hub and starts:
REM   1. The TCP-to-serial bridge (host-native Python; talks to the
REM      dongle on COM<N>).
REM   2. The Backyard Hero docker stack via docker-compose.yml in this dir.
REM
REM Open http://localhost:1776 once both are up.

setlocal

set VERSION=0.08WIN-PROD

REM Resolve paths relative to this script regardless of where it's invoked from.
set SCRIPT_DIR=%~dp0
REM Strip trailing backslash for cleaner echo output.
if "%SCRIPT_DIR:~-1%"=="\" set SCRIPT_DIR=%SCRIPT_DIR:~0,-1%
set HOST_DIR=%SCRIPT_DIR%\..\..
pushd "%HOST_DIR%"

set BRIDGE_DIR=tcp_serial_bridge
set BRIDGE_SCRIPT=%BRIDGE_DIR%\tcp_serial_bridge.py
set BRIDGE_VENV=%BRIDGE_DIR%\venv
set REQUIREMENTS=%BRIDGE_DIR%\requirements.txt
set COMPOSE_FILE=%SCRIPT_DIR%\docker-compose.yml

echo BACKYARD HERO HOST (windows/prod) --- VERSION: %VERSION%
echo Host dir: %CD%
echo Compose:  %COMPOSE_FILE%

where python >nul 2>nul
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH.
    echo Install from https://python.org and ensure Python is added to PATH.
    goto :end
)
where docker >nul 2>nul
if errorlevel 1 (
    echo ERROR: Docker is not installed or not in PATH.
    echo Install Docker Desktop from https://www.docker.com/products/docker-desktop and start it.
    goto :end
)

REM The docker CLI lands in PATH even when the Docker Desktop engine is
REM stopped or still booting (the WSL2 backend takes a while). Talking to a
REM dead daemon makes "docker compose pull" hang indefinitely instead of
REM erroring out -- so wait for the engine to actually answer first.
echo Waiting for Docker engine to be ready...
set DOCKER_WAIT=0
:waitdocker
docker info >nul 2>nul
if not errorlevel 1 goto dockerready
set /a DOCKER_WAIT+=1
if %DOCKER_WAIT% geq 60 (
    echo ERROR: Docker engine did not respond after ~120 seconds.
    echo Start Docker Desktop ^(whale icon in the system tray^), wait for it
    echo to report "running", then run start.bat again.
    goto :end
)
timeout /t 2 /nobreak > nul
goto waitdocker
:dockerready
echo Docker engine is ready.

if not exist "%BRIDGE_VENV%\Scripts\activate.bat" (
    echo Creating bridge venv at %BRIDGE_VENV%...
    python -m venv "%BRIDGE_VENV%"
    if errorlevel 1 (
        echo ERROR: Failed to create venv.
        goto :end
    )
)
call "%BRIDGE_VENV%\Scripts\activate.bat"
pip install -q -r "%REQUIREMENTS%"

echo Starting TCP-to-serial bridge...
start "BYH-Bridge" cmd /k python "%BRIDGE_SCRIPT%"

REM Give the bridge a moment to listen on TCP 9000.
timeout /t 3 /nobreak > nul

echo Pulling latest Backyard Hero image...
docker compose -f "%COMPOSE_FILE%" pull
if errorlevel 1 (
    echo ERROR: Failed to pull the Backyard Hero image.
    echo Check your internet connection and that you can reach Docker Hub.
    echo If the image is private, run "docker login" first.
    goto :end
)

echo Starting Backyard Hero docker stack...
echo.
echo ------------------------------------------------------------
echo   Backyard Hero is starting.
echo   Open: http://localhost:1776
echo   Close this window or press Ctrl-C to stop the docker stack.
echo   The bridge runs in a separate window -- close it to stop.
echo ------------------------------------------------------------
echo.

docker compose -f "%COMPOSE_FILE%" up

echo.
echo Stopping docker stack...
docker compose -f "%COMPOSE_FILE%" down

:end
popd
endlocal
