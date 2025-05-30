@echo off
setlocal

REM Check for Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not found in PATH.
    echo Please install Python (e.g., from python.org) and ensure it's added to your system PATH.
    goto :eof
)
echo Python found.

REM Check for Docker
docker --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not installed or not found in PATH.
    echo Please install Docker (e.g., Docker Desktop for Windows) and ensure it's running.
    goto :eof
)
echo Docker found.

set VERSION=0.08WIN

set BRIDGE_DIR=tcp_serial_bridge
set BRIDGE_SCRIPT=%BRIDGE_DIR%\tcp_serial_bridge.py
set BRIDGE_VENV=%BRIDGE_DIR%\venv
set REQUIREMENTS=%BRIDGE_DIR%\requirements.txt

echo BACKYARD HERO HOST --- VERSION: %VERSION%
echo Working directory is %CD%

if not exist "%BRIDGE_DIR%" (
    echo ERROR: Bridge directory %BRIDGE_DIR% does not exist.
    goto :eof
)

if not exist "%BRIDGE_SCRIPT%" (
    echo ERROR: Bridge script %BRIDGE_SCRIPT% does not exist.
    goto :eof
)

if not exist "%BRIDGE_VENV%\Scripts\activate.bat" (
    echo Creating virtual environment in %BRIDGE_VENV%...
    python -m venv "%BRIDGE_VENV%"
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment.
        goto :eof
    )
)

echo Activating virtual environment and installing requirements...
call "%BRIDGE_VENV%\Scripts\activate.bat"

if not exist "%REQUIREMENTS%" (
    echo WARNING: Requirements file %REQUIREMENTS% does not exist.
) else (
    pip install -r "%REQUIREMENTS%"
    if errorlevel 1 (
        echo ERROR: Failed to install requirements.
        goto :eof
    )
)

echo Starting TCP to Serial link...
start "TCPBridge" /B python "%BRIDGE_SCRIPT%"
timeout /t 2 /nobreak > nul
tasklist /FI "IMAGENAME eq python.exe" /FI "WINDOWTITLE eq TCPBridge*" | find "python.exe" > nul
if errorlevel 1 (
    echo ERROR: TCP to Serial bridge failed to start or exited prematurely.
    goto cleanup_docker
)
echo TCP to Serial bridge started.

echo Starting Backyard Hero Docker stack...
start "DockerCompose" /B docker-compose up

timeout /t 5 /nobreak > nul
echo Docker Compose starting...

echo All services started. Press Ctrl+C in this window to stop Docker Compose (other services may need manual stopping via Task Manager if not handled by docker-compose down).

echo.
echo To stop all services, run 'docker-compose down' in this directory
echo and manually stop the 'python %BRIDGE_SCRIPT%' process if it's still running (e.g., via Task Manager).

goto :eof

:cleanup_docker
echo Attempting to stop Docker Compose if it was started...
docker-compose down
goto :eof

endlocal 