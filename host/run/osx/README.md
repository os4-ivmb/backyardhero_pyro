# host/run/osx -- macOS development

Local development on a mac with Docker Desktop and the ESP32-S2 dongle
plugged into USB.

## Files in this folder

| File | What it does |
| --- | --- |
| `start.sh` | Prod launcher: pulls `os4ivmb/backyardhero:latest`, starts the bridge + Docker stack. |
| `start-dev.sh` | Dev launcher: builds locally from `host/Dockerfile`, bind-mounts source for hot reload. |
| `docker-compose.yml` | Prod compose. Maps host port 1776 (not 80 -- mac dev boxes often have other things on 80). |
| `docker-compose-dev.yml` | Dev compose. Same port layout, source bind-mounted, builds from `host/Dockerfile`. |
| `build_and_push_docker.sh` | Multi-arch (`linux/amd64,linux/arm64`) build + push to Docker Hub. This is how the prebuilt image the Pi consumes gets cut. |

## Prereqs

- macOS with Docker Desktop running.
- Python 3 (system Python is fine -- the launcher creates its own venv
  under `host/tcp_serial_bridge/venv` on first run).
- The dongle plugged into USB. It'll show up as `/dev/tty.usbmodem*`.

## Run it

```bash
# Production: pulls latest image, runs against it.
cd host/run/osx
./start.sh

# Development: builds locally, hot-reloads source.
./start-dev.sh
```

Open <http://localhost:1776/> when it's up.

Ctrl-C in the launcher terminal stops both the bridge and the Docker
stack.

## Refresh loop in dev

While `start-dev.sh` is running:

- **Frontend / Next.js API routes** -- HMR picks up edits in ~1s.
- **Python daemon** --
  `docker exec firework-system supervisorctl restart firework-daemon`
- **WebSocket server** --
  `docker exec firework-system supervisorctl restart websock`
- **Bridge (`host/tcp_serial_bridge/`)** -- Ctrl-C the launcher and
  re-run.
- **Dockerfile / supervisord / package.json deps** -- Ctrl-C and
  re-run; `docker compose up --build` will rebuild changed layers.

## Cutting a new image for the Pi

`build_and_push_docker.sh` is the source of truth for what goes onto
the Pi:

```bash
cd host/run/osx
./build_and_push_docker.sh                  # multi-arch, :latest + :v<host_version>
./build_and_push_docker.sh --no-push        # local build only
./build_and_push_docker.sh --tag rc1        # extra :rc1 tag
```

The version comes from `host_version` in `host/config/systemcfg.json`.
You'll need to `docker login` first for the push step. The Pi pulls
`os4ivmb/backyardhero:latest` by default.

## Why no port 80?

Docker Desktop will happily bind host port 80, but doing so on a dev
mac risks colliding with anything else listening there (apache, nginx,
a local dev server you forgot about, etc.). The Pi compose binds 80
because the Pi is a dedicated device and the friendly URL
(`http://backyardhero/`) only matters when a phone is connecting via
the AP. On a mac you're just hitting localhost, so :1776 is fine.

## Why no `extra_hosts`?

Docker Desktop on macOS resolves `host.docker.internal` automatically.
The Pi compose has to wire it up explicitly because Docker Engine on
Linux doesn't. Both compose files do the right thing for their
target without conditionals.
