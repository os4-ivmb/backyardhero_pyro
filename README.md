# Backyard Hero

An open-source 2.4 GHz wireless fireworks firing system. Custom hardware, a
web-based show builder, sub-10 ms cross-receiver sync — schematics, firmware,
and the host app all public.

<div align="center">
  <img src="doc_img/PXL_20250430_043232515.jpg" alt="Backyard Hero — receivers, dongle, and cue modules" width="800">
</div>

## Docs live elsewhere

This README is intentionally short. There are two places to look:

- **[backyard-hero.com](https://backyard-hero.com)** — overview, hardware
  walkthrough, what the system can do, how it gets run, photos. Start here if
  you've just landed on the repo.
- **[Project wiki](https://github.com/os4-ivmb/backyardhero_pyro/wiki)** —
  getting started by OS, system architecture, wire protocol, firmware
  deep-dives, REST API reference, and everything else you need to actually
  build, flash, and run the system.

A few jumping-off points in the wiki:

- [Getting Started](https://github.com/os4-ivmb/backyardhero_pyro/wiki/Getting-Started)
  ([macOS](https://github.com/os4-ivmb/backyardhero_pyro/wiki/Getting-Started-macOS)
  · [Linux](https://github.com/os4-ivmb/backyardhero_pyro/wiki/Getting-Started-Linux)
  · [Windows](https://github.com/os4-ivmb/backyardhero_pyro/wiki/Getting-Started-Windows))
- [System Architecture](https://github.com/os4-ivmb/backyardhero_pyro/wiki/System-Architecture)
  and [Glossary & Terms](https://github.com/os4-ivmb/backyardhero_pyro/wiki/Glossary-and-Terms)
- [Connecting the Dongle](https://github.com/os4-ivmb/backyardhero_pyro/wiki/Connecting-the-Dongle)
  · [Flashing a Receiver](https://github.com/os4-ivmb/backyardhero_pyro/wiki/Flashing-a-Receiver)

## Running it locally

Each platform has its own folder under `host/run/`. Pick yours, follow the
README inside.

| Platform | Folder | Quickstart |
| --- | --- | --- |
| **Raspberry Pi** (controller / AP) | [`host/run/pi/`](host/run/pi/README.md) | `sudo host/run/pi/install.sh` |
| **macOS** (dev) | [`host/run/osx/`](host/run/osx/README.md) | `host/run/osx/start.sh` (prod) or `start-dev.sh` (hot reload) |
| **Windows** (dev) | [`host/run/windows/`](host/run/windows/README.md) | `host\run\windows\start.bat` |

Then open `http://localhost:1776` (or `http://backyardhero/` on the Pi's AP).

## Repository layout

- `host/` — Next.js show builder, Python firework daemon, WebSocket server,
  serial bridge.
- `devices/` — receiver, dongle, and cue-module firmware, plus PCB design
  notes and enclosure CAD.

## License

[DBAD](https://dbad-license.org/) — don't be a dick.
