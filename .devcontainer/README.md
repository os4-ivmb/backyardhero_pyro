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

## Claude Code CLI

The [`claude`](https://claude.com/claude-code) CLI is added via the
`ghcr.io/anthropics/devcontainer-features/claude-code` feature, so it's on
`PATH` inside the container when you launch through the Dev Containers
extension or `devcontainer up`. Run `claude` from any terminal in here and
sign in on first use.

> Features are **not** applied by a plain `docker compose up`. If you brought
> the stack up that way, install it manually:
> `docker compose -f .devcontainer/docker-compose.yml exec -u root firework-system npm install -g @anthropic-ai/claude-code`

## Hardware / the dongle

There's no USB dongle inside the container. In the real dev flow the
in-container daemon talks to the dongle over a **host-side TCP↔serial
bridge** (`host/tcp_serial_bridge/`), which you run on the host, not in
here. Without it, the builder/UI and everything non-hardware still work.
Set `SERIAL_PORT` in the environment before `up` if you wire one in.

## Rebuild triggers

`Dockerfile`, `supervisord*.conf`, or `package.json` dep changes need a
rebuild: *Dev Containers: Rebuild Container* (or
`devcontainer up --build`). Source and Python edits do not.
