# Backyard Hero

An open-source 2.4 GHz wireless fireworks firing system: custom hardware, a
web-based show builder, and sub-10 ms cross-receiver sync. The schematics,
firmware, and host app are all public.

## Documentation

- **[backyard-hero.com](https://backyard-hero.com)**: an overview of the
  system, its hardware, and what it can do. Start here if you're new to the
  project.
- **[Project wiki](https://github.com/os4-ivmb/backyardhero_pyro/wiki)**: how
  to build, flash, and run it. Covers getting started, architecture, the wire
  protocol, firmware, and the REST API.

Good places to start in the wiki:

- [Getting Started](https://github.com/os4-ivmb/backyardhero_pyro/wiki/Getting-Started)
- [System Architecture](https://github.com/os4-ivmb/backyardhero_pyro/wiki/System-Architecture)
- [Flashing a Receiver](https://github.com/os4-ivmb/backyardhero_pyro/wiki/Flashing-a-Receiver)

## Repository layout

- `host/`: the Next.js show builder, Python daemon, WebSocket server, and
  serial bridge. Per-platform run scripts are in `host/run/`.
- `devices/`: firmware for the receiver, dongle, omni, and cue modules, plus
  PCB notes and enclosure CAD.

## License

[DBAD](https://dbad-license.org/): don't be a dick.
