# .devcontainer — Backyard Hero host

A [Dev Container](https://containers.dev) that runs the full host stack
(Next.js show builder + Python firework daemon + WebSocket server) with
hot reload. It reuses the same image and dev config as
`host/run/osx/docker-compose-dev.yml`.

## Prereqs

- Docker (Docker Desktop with **WSL integration enabled** for this distro,
  or a native Docker Engine reachable from this shell).
- VS Code with the **Dev Containers** extension, or the
  [`devcontainer` CLI](https://github.com/devcontainers/cli).

> Check Docker is reachable first: `docker info` should succeed. If you're on
> WSL2 and it says "daemon not reachable", turn on
> *Docker Desktop → Settings → Resources → WSL Integration* for this distro.

## Open it

**VS Code:** open the repo, then *Dev Containers: Reopen in Container*
(Command Palette). First build runs `npm ci` + `next build` inside the
image — a few minutes; later starts are ~10s.

**CLI:**

```bash
devcontainer up --workspace-folder .
```

When it's up, the app is on <http://localhost:1776> and the WebSocket
server on `8090` (both auto-forwarded).

## What runs where

| Process | How | Restart after edits |
| --- | --- | --- |
| Next.js app (`byh_app`) | `npm run dev` under supervisord | HMR, automatic (~1s) |
| Python daemon (`pc_daemon`) | supervisord `firework-daemon` | `supervisorctl restart firework-daemon` |
| WebSocket server (`ws_server`) | supervisord `websock` | `supervisorctl restart websock` |

Run the `supervisorctl` commands from a terminal **inside** the container
(the VS Code integrated terminal), or from the host via Compose:

```bash
docker compose -f .devcontainer/docker-compose.yml exec firework-system \
  supervisorctl restart firework-daemon
```

Both Python services have `autorestart=true`, so if `supervisorctl` can't
reach the socket you can also just `pkill -f pc_daemon.py` and supervisor
respawns it.

> The container has no fixed name (see the compose file for why), so address
> it by the **service** name `firework-system`, not a container name.

## Editing source

The whole repo is mounted at `/workspaces/backyardhero_pyro` and the
workspace opens there (the repo root), so the `.git` dir and everything
else are visible and VS Code's Git integration works. `git` itself is
installed via the `ghcr.io/devcontainers/features/git` feature (the
`node:22-slim` base image doesn't ship it), and the repo is marked a
`safe.directory` on create. The app source
(`host/byh_app/backyardhero`) and `host/pythings` are *also* bind-mounted
into `/app`, so edits there hot-reload regardless of which path you open.

`node_modules` and `.next` live in **named volumes** (`byh_node_modules`,
`byh_next`) so the container keeps its Linux-built binaries instead of
inheriting host-built ones (which crash with "invalid ELF header"). Reset
them if deps get weird:

```bash
docker compose -f .devcontainer/docker-compose.yml down --volumes
```

## Hardware / the dongle

There's no USB dongle inside the container.

**By default the container fires nothing.** `supervisord.devcontainer.conf`
runs an in-container **mock bridge** (`host/pythings/mock_bridge/`) and points
the daemon at it (`BYH_BRIDGE_HOST=127.0.0.1`). The mock reports a healthy
dongle and **silently swallows every fire command** — the UI shows CONNECTED
and firing "succeeds" on the wire, but nothing physically fires. This is what
lets the builder/UI and everything non-hardware work with no dongle attached.

### Using real hardware from the dev container

Because the daemon is wired to the mock by default, you must explicitly take
the mock out of the loop and re-point the daemon at the **host-side TCP↔serial
bridge** (`host/tcp_serial_bridge/`, run on the host with `SERIAL_PORT` set to
your dongle's port):

1. Start the host-side bridge on the host (not in the container).
2. Stop the mock so it isn't holding the port / answering as a fake dongle:
   `supervisorctl stop mock-bridge`.
3. Re-point the daemon at the host bridge instead of `127.0.0.1`: set
   `BYH_BRIDGE_HOST=host.docker.internal` (and `BYH_BRIDGE_PORT` if you changed
   it) for `firework-daemon`, then `supervisorctl restart firework-daemon`.

Until you do all three, "CONNECTED" and successful fires in the UI are the
**mock** — no receiver will actually fire.

## Rebuild triggers

`Dockerfile`, `supervisord*.conf`, or `package.json` dep changes need a
rebuild: *Dev Containers: Rebuild Container* (or
`devcontainer up --build`). Source and Python edits do not.
