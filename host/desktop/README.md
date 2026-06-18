# host/desktop — Backyard Hero desktop bundle

A single, self-contained installer for the Backyard Hero host on
**macOS** and **Windows** (and Linux AppImage). No Docker, no system
Python, no WSL, no manual COM-port config — double-click to install,
launch, and the UI opens.

## What it is

An Electron app that supervises the same processes the Docker image runs,
but natively:

| Process | What | Port |
| --- | --- | --- |
| `app` | Next.js UI (standalone build, run on Electron's bundled Node) | 1776 |
| `ws` | `ws_server.py` websocket server | 8090 |
| `daemon` | `pc_daemon.py` firing daemon | — |
| `bridge` | `tcp_serial_bridge.py` + `flash_server` (direct USB serial) | 9000 |

The Electron main process (`src/main.js`) replaces `supervisord`: it spawns,
logs, and restarts these, and tears them down on quit.

### Where data lives

Mutable state goes in the per-user app-data dir (never the read-only app
bundle). The supervisor exports these to every child:

| Env var | macOS | Windows |
| --- | --- | --- |
| `BYH_DATA_DIR` | `~/Library/Application Support/Backyard Hero/data` | `%APPDATA%\Backyard Hero\data` |
| `BYH_CONFIG_DIR` | `…/Backyard Hero/config` | `…\Backyard Hero\config` |
| `BYH_RUN_DIR` | `…/Backyard Hero/run` | `…\Backyard Hero\run` |

So the SQLite DB is `…/data/backyardhero.db` and config is
`…/config/systemcfg.json` (seeded from the bundled default on first run).
These same env vars default to `/data`, `/config`, `/tmp` when unset, so the
**Docker image and Raspberry Pi deployment are unchanged**.

### Serial auto-detection

On launch the app probes the bundled Python's `pyserial` for the dongle
(Espressif VID `0x303A` first, then common USB-serial chips) and exports
`SERIAL_PORT`. The daemon can still override it from the UI.

## Building an installer

Prereqs: Node 20+, plus a C toolchain for the one native module
(`better-sqlite3`) — Xcode CLT on macOS, MSVC Build Tools on Windows. The
build downloads its own Python; you do **not** need Python installed (a
Python 3.x is only used by `node-gyp`).

```bash
cd host/desktop
npm ci
npm run dist          # assemble resources + build installer for this OS
```

Outputs land in `host/desktop/dist/` (`.dmg` on macOS, `.exe` on Windows).

`npm run dist` runs two phases:

1. `scripts/build-resources.mjs` — builds the Next standalone app (rebuilding
   `better-sqlite3` for Electron's ABI), downloads
   [python-build-standalone](https://github.com/astral-sh/python-build-standalone),
   `pip install`s the Python requirements into it, and copies the service
   sources + a default `systemcfg.json` into `resources/`.
2. `electron-builder` — packages `resources/` + the Electron glue into the
   platform installer.

### Build flags

| Env | Default | Effect |
| --- | --- | --- |
| `BYH_INCLUDE_AUDIO` | `1` | `0` omits the heavy `librosa`/`numpy`/`scipy`/`yt-dlp` firing-profile stack (smaller install; the "reprocess profile from YouTube" feature is then unavailable). |
| `BYH_PYTHON_VERSION` / `BYH_PYTHON_BUILD_TAG` | pinned | Pick a different embedded CPython release. |
| `BYH_PYTHON_URL` | — | Fully override the python-build-standalone tarball URL. |

> The firing-profile feature also needs an `ffmpeg` binary. Drop one at
> `resources/ffmpeg/ffmpeg(.exe)` before packaging to bundle it; otherwise the
> app falls back to an `ffmpeg` on the system `PATH`.

## CI

`.github/workflows/build-desktop.yml` builds all three targets on matching
runners (macOS arm64, macOS x64, Windows x64 — native bits can't
cross-compile) and uploads the installers. Trigger via **workflow_dispatch**
or by pushing a `desktop-v*` tag.

### Signing / notarization

Unsigned builds are fine as CI artifacts but get blocked by Gatekeeper /
SmartScreen on end-user machines. Provide these repo secrets to get clean,
installable builds:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` (Developer ID cert) and
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (notarization).
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (code-signing cert; OV/EV).

## Dev run

```bash
cd host/desktop
npm ci
npm run build:resources   # one-time (or after changing the app / services)
npm start                 # launches Electron against ./resources
```

## Icons (optional)

Drop `build/icon.icns` (macOS) and `build/icon.ico` (Windows) for app icons,
and `build/trayTemplate.png` / `build/tray.ico` for the tray. Missing icons
fall back to the Electron default (and the tray is skipped).
