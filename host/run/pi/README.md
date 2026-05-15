# host/run/pi -- Raspberry Pi deployment

Turnkey install + run for a Raspberry Pi acting as the firework
controller. Tested on Pi 5 (Bookworm 64-bit) but works on most modern
Pis and on generic Ubuntu/Debian with minor variations.

## Files in this folder

| File | What it does |
| --- | --- |
| `install.sh` | One-shot bare-OS installer. Installs Docker, hostapd, dnsmasq, udev rules, the dongle stable symlink, the `byh-host` systemd unit, WiFi AP, NAT for AP clients. |
| `start.sh` | Prod launcher (invoked by the systemd unit). Brings up the host-side TCP-to-serial bridge + the Docker stack via `docker-compose.yml`. |
| `start-dev.sh` | Dev launcher. Same as `start.sh` but builds the image locally and bind-mounts source for hot reload. |
| `docker-compose.yml` | Prod compose: pulls `os4ivmb/backyardhero:latest`, binds host ports 80+1776+8090, wires `host.docker.internal` for the bridge, tolerant of being offline. |
| `docker-compose-dev.yml` | Dev compose: builds locally, bind-mounts source. Same port + extra_hosts behavior as prod. |
| `update_dongle.sh` | One-button "pull latest -> build -> flash" for the ESP32-S2 dongle plugged into the Pi. |

## First-time install

On a fresh Pi OS (or Ubuntu) install:

```bash
# Clone somewhere convenient (the installer defaults to /opt/backyardhero
# if you don't pass --repo-dir):
sudo apt update && sudo apt install -y git
git clone https://github.com/os4-ivmb/backyardhero_pyro.git ~/backyardhero
sudo ~/backyardhero/host/run/pi/install.sh
```

The installer:
1. Installs apt deps (Docker, hostapd, dnsmasq, etc.).
2. Adds your user to `docker` and `dialout` groups.
3. Sets up the `/dev/byh_dongle` udev rule so the dongle has a
   stable name regardless of what `/dev/ttyACM*` slot it lands on.
4. Pre-pulls the Backyard Hero Docker image.
5. Installs `byh-host.service` (this file's `start.sh` is the ExecStart).
6. Configures the Pi's WiFi as an AP (`hostapd` + `dnsmasq` + NAT so
   AP clients can reach the internet via the Pi's Ethernet uplink).
7. Hands `/opt/backyardhero` over to your user so you can `git pull`
   / rsync changes in without sudo.

Reboot once when it's done so udev + group memberships take effect.

Once up, the UI is at:

- `http://backyardhero/` (from any client on the Pi's WiFi AP -- mDNS)
- `http://<pi-ip>/`
- `http://<pi-ip>:1776/` (historical port)

## Routine ops

```bash
sudo systemctl status byh-host         # is it running?
sudo systemctl restart byh-host        # restart after config changes
sudo journalctl -u byh-host -f         # tail the stack logs
sudo journalctl -u hostapd -u dnsmasq -f   # tail the AP logs

# Pull a newer image and restart:
cd /opt/backyardhero/host/run/pi
sudo docker compose pull
sudo systemctl restart byh-host

# Flash the dongle from this Pi (pull latest firmware -> build -> flash):
sudo /opt/backyardhero/host/run/pi/update_dongle.sh
```

## Iterating on the Pi (dev mode)

When you want to iterate on source code that's been rsync'd over from
a dev box:

```bash
sudo systemctl stop byh-host         # free up ports 80/1776/8090 and the dongle
cd /opt/backyardhero/host/run/pi
./start-dev.sh                       # build + start dev stack in foreground
```

While `start-dev.sh` is running, source changes hot-reload:

- **Frontend / Next.js API routes** -- HMR picks them up automatically
  (~1s after save).
- **Python daemon** --
  `docker exec firework-system supervisorctl restart firework-daemon`
- **WebSocket server** --
  `docker exec firework-system supervisorctl restart websock`
- **Bridge changes** -- Ctrl-C `start-dev.sh` and re-run it.
- **Dockerfile / supervisord changes** -- Ctrl-C and re-run (it rebuilds
  changed layers).

When done iterating, Ctrl-C, then bring prod back:

```bash
sudo systemctl start byh-host
```

First time `start-dev.sh` runs on a Pi the build takes 10-15 min
(`npm ci` dominates); subsequent runs are ~30s thanks to Docker layer
caching.

## Uninstall

```bash
sudo /opt/backyardhero/host/run/pi/install.sh --uninstall
```

Removes the systemd units, the udev rule, the AP setup, NAT rules, and
the dnsmasq/hostapd configs. Leaves the repo and the Docker image
behind for you to clean up manually if you want.
