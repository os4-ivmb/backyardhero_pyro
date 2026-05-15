# host/run/windows -- Windows development

Local development on Windows with Docker Desktop and the ESP32-S2
dongle plugged into USB (typically `COM3` / `COM4`).

## Files in this folder

| File | What it does |
| --- | --- |
| `start.bat` | Prod launcher: pulls `os4ivmb/backyardhero:latest`, starts the bridge + Docker stack. |
| `docker-compose.yml` | Prod compose. Maps host port 1776 (not 80 -- avoids collisions with IIS or other Windows services). |
| `build_and_push_docker.bat` | Multi-arch build + push to Docker Hub (mirror of the osx script). |

There's no `start-dev.bat` yet -- if you need hot-reload dev on
Windows, run WSL2 and use the `osx/` flow from there (Linux paths
work the same as the mac scripts and Docker Desktop integrates with
WSL2).

## Prereqs

- Windows 10/11 with Docker Desktop installed and running.
- Python 3 in `PATH`. Install from <https://python.org>; check
  "Add Python to PATH" during install.
- The dongle plugged into USB. It'll show up as `COM<N>` in Device
  Manager.

## Run it

```cmd
cd host\run\windows
start.bat
```

The script opens a separate window for the TCP-to-serial bridge
(close it to stop the bridge) and runs `docker compose up` in the
main window (Ctrl-C to stop the stack).

Open <http://localhost:1776/> in your browser.

## Why no port 80?

Same reason as macOS: Windows dev boxes often have IIS, other
services, or just-in-case dev servers on port 80. Binding it from
Docker risks "port already in use" errors. The Pi compose binds 80
because the Pi is dedicated hardware; on a Windows dev box you're
just hitting localhost so :1776 is fine.

## Cutting a new image for the Pi

```cmd
cd host\run\windows
build_and_push_docker.bat
build_and_push_docker.bat --no-push
```

You'll need `docker login` first. The script pulls `host_version`
from `host\config\systemcfg.json` via PowerShell.
