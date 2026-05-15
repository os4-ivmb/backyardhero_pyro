@echo off
REM build_and_push_docker.bat -- Windows wrapper around docker buildx for the
REM Backyard Hero host image. Mirrors the unix script's defaults:
REM   - target image:     os4ivmb/backyardhero
REM   - target platforms: linux/amd64,linux/arm64
REM   - tags:             :latest and :v<host_version>
REM
REM Usage:
REM   build_and_push_docker.bat                 (build + push)
REM   build_and_push_docker.bat --no-push       (local build only, host arch)

setlocal enabledelayedexpansion

set IMAGE=os4ivmb/backyardhero
set PLATFORMS=linux/amd64,linux/arm64
set PUSH=1

:parseargs
if "%~1"=="" goto afterargs
if /I "%~1"=="--no-push" ( set PUSH=0 & shift & goto parseargs )
if /I "%~1"=="--single-arch" ( set PLATFORMS= & shift & goto parseargs )
if /I "%~1"=="--image" ( set IMAGE=%~2 & shift & shift & goto parseargs )
if /I "%~1"=="--platforms" ( set PLATFORMS=%~2 & shift & shift & goto parseargs )
echo Unknown arg: %~1
exit /b 1
:afterargs

REM Pull "host_version" out of systemcfg.json with PowerShell (no jq dependency).
for /f "usebackq tokens=*" %%v in (`powershell -NoProfile -Command "(Get-Content config/systemcfg.json -Raw | ConvertFrom-Json).host_version"`) do (
  set VERSION=%%v
)
if "%VERSION%"=="" set VERSION=dev
set VERSION_TAG=v%VERSION%

echo [build] image:    %IMAGE%
echo [build] version:  %VERSION_TAG%
echo [build] platforms: %PLATFORMS%

where docker >nul 2>nul
if errorlevel 1 (
  echo [build] ERROR: docker not found in PATH.
  exit /b 1
)

if not "%PLATFORMS%"=="" (
  docker buildx inspect byh-builder >nul 2>nul
  if errorlevel 1 (
    echo [build] creating buildx builder 'byh-builder'...
    docker buildx create --name byh-builder --use >nul
  ) else (
    docker buildx use byh-builder >nul
  )
  docker buildx inspect --bootstrap >nul
)

if not "%PLATFORMS%"=="" (
  if "%PUSH%"=="1" (
    echo [build] building + pushing multi-arch...
    docker buildx build --platform %PLATFORMS% -t %IMAGE%:latest -t %IMAGE%:%VERSION_TAG% --push .
  ) else (
    echo [build] --no-push set; building for host arch only and loading locally.
    docker buildx build -t %IMAGE%:latest -t %IMAGE%:%VERSION_TAG% --load .
  )
) else (
  if "%PUSH%"=="1" (
    echo [build] building + pushing single-arch (host)...
    docker buildx build -t %IMAGE%:latest -t %IMAGE%:%VERSION_TAG% --push .
  ) else (
    echo [build] building single-arch (host) into local docker...
    docker buildx build -t %IMAGE%:latest -t %IMAGE%:%VERSION_TAG% --load .
  )
)

echo [build] done.
endlocal
