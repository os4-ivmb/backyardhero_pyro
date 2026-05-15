# host/run/

Platform-specific launchers, compose files, and (where applicable)
install scripts. **Find your platform and follow its README.**

| Folder | When to use |
| --- | --- |
| [`pi/`](./pi/README.md) | Raspberry Pi running as the firework controller (typically AP-only on a Pi 5 with the dongle plugged in). Includes a one-shot installer, WiFi AP setup, NAT for AP clients, dongle udev rules, and the `byh-host` systemd unit. |
| [`osx/`](./osx/README.md) | macOS development on a laptop with the dongle plugged into USB. Docker Desktop-based. |
| [`windows/`](./windows/README.md) | Windows development on a laptop with the dongle plugged into USB. Docker Desktop-based. |

## Why this layout

Each platform has its own folder with its own compose files and
launchers. **No platform conditionals in any of these scripts.** Pi
binds port 80 because nothing else is on the box; mac doesn't because
it would risk colliding with whatever the dev has running. Pi uses
`docker compose` plugin only; mac and Windows do the same because
Docker Desktop ships it. Each compose file says exactly what it does
for its target.

The cost is a small amount of duplication between e.g. `osx/start.sh`
and `windows/start.bat`. The win is that each file is short, says
"here is what this platform does", and can be edited without worrying
about the other platforms.

## What lives at `host/` (the parent) instead

Anything genuinely cross-platform stays at the `host/` root:

- `Dockerfile` -- one container image works on any host OS that runs
  Docker. The compose files here reference it via `build.context: ../..`.
- `supervisord.conf` / `supervisord.dev.conf` -- run *inside* the
  container, so the container OS (Debian) is the only thing that matters.
- `byh_app/`, `pythings/`, `tcp_serial_bridge/`, `config/`, `data/` --
  source code and runtime state. Not platform-specific.

## Adding a new platform

Drop a new folder under `host/run/` with the conventions used by the
existing ones:

- `docker-compose.yml`     (prod)
- `docker-compose-dev.yml` (dev, optional)
- `start.sh` / `start.bat` (prod launcher)
- `start-dev.sh` (dev launcher, optional)
- `README.md` explaining quirks of that platform

Don't add knobs to existing platforms to "support" the new one. The
whole point is that each platform is its own file.
