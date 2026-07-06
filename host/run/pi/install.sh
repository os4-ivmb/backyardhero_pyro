#!/usr/bin/env bash
# install_pi.sh -- one-shot installer for Backyard Hero on a Raspberry Pi
# (or any aarch64/amd64 Debian/Ubuntu host).
#
# Tested target: Raspberry Pi 5, Raspberry Pi OS Bookworm 64-bit.
# Also supported: Raspberry Pi OS Bullseye 64-bit, Ubuntu Server 22.04+/24.04
# on Pi, generic Debian 12 on amd64/arm64.
#
# What it does, in order, from a bare OS install:
#   1. Sanity-check OS/arch and apt-update.
#   2. Install runtime deps (docker + compose plugin, python3, hostapd,
#      dnsmasq, iw, rfkill, git, curl, jq).
#   3. Make sure the invoking user is in the `docker` and `dialout` groups
#      so they can talk to the dongle and run docker without sudo.
#   4. Locate (or clone) the backyardhero repo. If the installer is being
#      run from inside an existing checkout we use that in place. Otherwise
#      we clone into /opt/backyardhero.
#   5. Drop a udev rule that creates a stable /dev/byh_dongle symlink for
#      any USB-CDC device with the Espressif vendor ID (0x303a). The dongle
#      is built on an ESP32-S2 with native USB so this matches it reliably.
#   6. Best-effort detect the dongle right now (before reboot) and write
#      the result into host/config/systemcfg.json so the daemon picks it up
#      on first boot. /dev/byh_dongle is preferred (survives reboot/replug)
#      with /dev/ttyACM* as a fallback when udev hasn't reloaded yet.
#   7. Pre-pull the production docker image so the first boot is fast.
#   8. Install a systemd unit `byh-host.service` that wraps host/run/pi/start.sh,
#      so the whole stack comes up on power-on with no operator action.
#   9. Configure the on-board WiFi as an isolated WPA2 access point using
#      hostapd + dnsmasq. SSID + password are configurable; defaults are
#      printed at the end. The AP runs on a separate /24 (default
#      192.168.42.0/24) and the web UI is reachable at the gateway IP.
#      Any conflicting network managers (NetworkManager, dhcpcd) are
#      politely told to leave wlan0 alone.
#
# By default the script is interactive only where it has to be. Pass `-y`
# to accept every default. Pass `--help` for a full flag list.
#
# Re-running is safe -- every step is idempotent. Use --uninstall to tear
# the install back down (service, AP, udev rule; the repo and docker image
# are left in place).
#
# Hardware notes:
#   * The Pi must have working WiFi for the AP path to do anything. On a
#     fresh image you may need to set the regulatory domain first; we do
#     `rfkill unblock wlan` and `raspi-config nonint do_wifi_country` (when
#     raspi-config is present) but on plain Ubuntu Server you may need to
#     set `country=US` in /etc/wpa_supplicant/... by hand. We default to
#     US; override with --country.
#   * The dongle is an ESP32-S2 board (lolin_s2_mini) using native USB
#     CDC. It enumerates as /dev/ttyACM* with USB VID 0x303a. The udev
#     rule keys off the vendor ID; if you happen to have a *second*
#     Espressif device plugged in it will also get the symlink, which
#     will then be ambiguous -- unplug the extra device or edit the rule
#     to add a product/serial filter.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults / config knobs
# ---------------------------------------------------------------------------

DEFAULT_REPO_URL="https://github.com/os4-ivmb/backyardhero_pyro.git"
DEFAULT_REPO_DIR="/opt/backyardhero"
DEFAULT_BRANCH="main"

DEFAULT_AP_IFACE="wlan0"
DEFAULT_AP_IP="192.168.42.1"
DEFAULT_AP_CIDR="24"
DEFAULT_AP_DHCP_START="192.168.42.50"
DEFAULT_AP_DHCP_END="192.168.42.150"
DEFAULT_AP_CHANNEL="6"
DEFAULT_AP_COUNTRY="US"
DEFAULT_AP_PASSWORD="backyardhero"
# Port the Next.js app listens on inside the docker container (and that
# docker-compose publishes on the host). The AP NAT script adds a port 80
# -> this port REDIRECT so AP clients can hit the UI without a port suffix.
DEFAULT_AP_APP_PORT="1776"
# SSID gets a hostname-derived suffix appended at runtime so two Pis on
# the same bench don't collide.
DEFAULT_AP_SSID_PREFIX="BackyardHero"

SERVICE_NAME="byh-host.service"
AP_IFACE_SERVICE_NAME="byh-ap-iface.service"
AP_APPLY_SERVICE_NAME="byh-ap-apply.service"
AP_APPLY_PATH_NAME="byh-ap-apply.path"
AP_APPLY_SCRIPT_PATH="/usr/local/sbin/byh-ap-apply.py"
AP_NAT_SERVICE_NAME="byh-ap-nat.service"
AP_NAT_SCRIPT_PATH="/usr/local/sbin/byh-ap-nat.sh"
AP_NAT_SYSCTL_PATH="/etc/sysctl.d/99-byh-ap-nat.conf"
# UI-driven system update plumbing. Same shape as the AP apply units
# above: a .path watches a request file the in-container Next.js writes
# into the shared host/data volume, the .service runs the apply script
# as a oneshot. The script then drives host/run/pi/update.sh and writes
# back to /data/byh_update_status.json so the UI can render progress.
UPDATE_APPLY_SERVICE_NAME="byh-update.service"
UPDATE_APPLY_PATH_NAME="byh-update.path"
UPDATE_APPLY_SCRIPT_PATH="/usr/local/sbin/byh-update.py"
# Show-state-aware NTP guard. The daemon writes /data/byh_show_state
# ("idle" | "loaded" | "running") on transitions. A .path unit fires
# the .service which pauses or resumes systemd-timesyncd accordingly,
# so a mid-show NTP step can't yank the wall clock under a running
# show. See setup_timesync_guard() below.
TIMESYNC_GUARD_SERVICE_NAME="byh-timesync-guard.service"
TIMESYNC_GUARD_PATH_NAME="byh-timesync-guard.path"
TIMESYNC_GUARD_SCRIPT_PATH="/usr/local/sbin/byh-timesync-guard.sh"
UDEV_RULE_PATH="/etc/udev/rules.d/99-byh-dongle.rules"
HOSTAPD_CONF_PATH="/etc/hostapd/hostapd.conf"
HOSTAPD_DEFAULT_PATH="/etc/default/hostapd"
DNSMASQ_CONF_PATH="/etc/dnsmasq.d/backyardhero.conf"

# Filled in by parse_args / runtime detection.
REPO_URL="${DEFAULT_REPO_URL}"
REPO_DIR=""
BRANCH="${DEFAULT_BRANCH}"
AP_IFACE="${DEFAULT_AP_IFACE}"
AP_IP="${DEFAULT_AP_IP}"
AP_CIDR="${DEFAULT_AP_CIDR}"
AP_DHCP_START="${DEFAULT_AP_DHCP_START}"
AP_DHCP_END="${DEFAULT_AP_DHCP_END}"
AP_CHANNEL="${DEFAULT_AP_CHANNEL}"
AP_COUNTRY="${DEFAULT_AP_COUNTRY}"
AP_SSID=""
AP_PASSWORD="${DEFAULT_AP_PASSWORD}"
AP_APP_PORT="${DEFAULT_AP_APP_PORT}"
ASSUME_YES=0
DO_AP=1
DO_NAT=1
DO_SERVICE=1
DO_DOCKER_PULL=1
DO_UNINSTALL=0
TARGET_USER=""

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

log()  { printf "\033[1;36m[byh-install]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[byh-install] WARN:\033[0m %s\n" "$*" >&2; }
err()  { printf "\033[1;31m[byh-install] ERROR:\033[0m %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }

section() {
  printf "\n\033[1;35m==[ %s ]==\033[0m\n" "$*"
}

usage() {
  cat <<EOF
Usage: sudo $0 [options]

WiFi access point:
  --ssid NAME             AP SSID (default: ${DEFAULT_AP_SSID_PREFIX}-<hostsuffix>)
  --password PASS         WPA2 passphrase, 8+ chars (default: ${DEFAULT_AP_PASSWORD})
  --wifi-iface IFACE      Wireless interface (default: ${DEFAULT_AP_IFACE})
  --ap-ip IP              Gateway IP for the AP (default: ${DEFAULT_AP_IP})
  --ap-cidr N             Netmask in CIDR bits (default: ${DEFAULT_AP_CIDR})
  --ap-dhcp-start IP      First DHCP lease (default: ${DEFAULT_AP_DHCP_START})
  --ap-dhcp-end IP        Last DHCP lease (default: ${DEFAULT_AP_DHCP_END})
  --ap-channel N          2.4 GHz channel 1-13 (default: ${DEFAULT_AP_CHANNEL})
  --country CC            WiFi regulatory country (default: ${DEFAULT_AP_COUNTRY})
  --no-ap                 Skip all AP configuration.
  --no-nat                Skip the NAT step that routes AP clients out
                          via the Pi's other uplink (e.g. eth0). With
                          --no-nat, AP clients can still reach the
                          Backyard Hero UI on the Pi but won't have
                          general internet access.

Repo / service:
  --repo-url URL          Git clone URL (default: ${DEFAULT_REPO_URL})
  --repo-dir DIR          Where to clone if not run from inside a checkout
                          (default: ${DEFAULT_REPO_DIR})
  --branch BRANCH         Branch / tag to check out (default: ${DEFAULT_BRANCH})
  --user USER             User to add to docker+dialout groups
                          (default: \$SUDO_USER or first non-root login user)
  --no-service            Don't install the systemd auto-start unit.
  --no-docker-pull        Don't pre-pull the image (deferred to first boot).

General:
  -y, --yes               Non-interactive, accept every default.
  --uninstall             Remove services + AP config (keeps repo & image).
  -h, --help              Show this message.

Examples:
  sudo $0 -y
  sudo $0 --ssid PyroPi --password 'longerthan8' --country GB
  sudo $0 --no-ap --repo-dir /home/pi/backyardhero
EOF
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ssid)            AP_SSID="$2"; shift 2 ;;
      --password)        AP_PASSWORD="$2"; shift 2 ;;
      --wifi-iface)      AP_IFACE="$2"; shift 2 ;;
      --ap-ip)           AP_IP="$2"; shift 2 ;;
      --ap-cidr)         AP_CIDR="$2"; shift 2 ;;
      --ap-dhcp-start)   AP_DHCP_START="$2"; shift 2 ;;
      --ap-dhcp-end)     AP_DHCP_END="$2"; shift 2 ;;
      --ap-channel)      AP_CHANNEL="$2"; shift 2 ;;
      --country)         AP_COUNTRY="$2"; shift 2 ;;
      --no-ap)           DO_AP=0; shift ;;
      --no-nat)          DO_NAT=0; shift ;;
      --repo-url)        REPO_URL="$2"; shift 2 ;;
      --repo-dir)        REPO_DIR="$2"; shift 2 ;;
      --branch)          BRANCH="$2"; shift 2 ;;
      --user)            TARGET_USER="$2"; shift 2 ;;
      --no-service)      DO_SERVICE=0; shift ;;
      --no-docker-pull)  DO_DOCKER_PULL=0; shift ;;
      -y|--yes)          ASSUME_YES=1; shift ;;
      --uninstall)       DO_UNINSTALL=1; shift ;;
      -h|--help)         usage; exit 0 ;;
      *)                 err "unknown arg: $1"; usage; exit 1 ;;
    esac
  done

  # Derive an SSID suffix from /etc/machine-id so it's stable across reboots
  # but unique per Pi.
  if [[ -z "${AP_SSID}" ]]; then
    local suffix=""
    if [[ -r /etc/machine-id ]]; then
      suffix="$(cut -c1-5 /etc/machine-id 2>/dev/null || true)"
    fi
    if [[ -z "${suffix}" ]]; then
      suffix="$(hostname | tr -cd 'a-zA-Z0-9' | tail -c5)"
    fi
    AP_SSID="${DEFAULT_AP_SSID_PREFIX}-${suffix}"
  fi
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

require_root() {
  if [[ $EUID -ne 0 ]]; then
    die "this installer must run as root (try: sudo $0 $*)"
  fi
}

detect_target_user() {
  if [[ -n "${TARGET_USER}" ]]; then
    id -u "${TARGET_USER}" >/dev/null 2>&1 || die "user '${TARGET_USER}' does not exist"
    return
  fi
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    TARGET_USER="${SUDO_USER}"
    return
  fi
  # Fall back to the first /home/* user with UID >= 1000.
  local candidate
  candidate="$(awk -F: '$3>=1000 && $3<65000 {print $1; exit}' /etc/passwd || true)"
  if [[ -n "${candidate}" ]]; then
    TARGET_USER="${candidate}"
  fi
}

detect_os() {
  if [[ ! -r /etc/os-release ]]; then
    die "can't read /etc/os-release; this installer is Debian/Ubuntu only"
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    raspbian:*|*:debian*|debian:*|ubuntu:*|*:ubuntu*) : ;;
    *) warn "untested distro (${ID:-unknown}); will attempt anyway" ;;
  esac
  local arch
  arch="$(uname -m)"
  case "${arch}" in
    aarch64|arm64|x86_64|amd64) : ;;
    armv7l|armv6l)
      warn "32-bit ARM detected (${arch}); docker hub images are multi-arch"
      warn "but the firmware/build pipeline is only tested on 64-bit."
      ;;
    *) warn "unusual architecture: ${arch}" ;;
  esac
  log "OS: ${PRETTY_NAME:-unknown} | arch: ${arch}"
}

confirm() {
  # confirm "prompt"; returns 0 on yes, 1 on no.
  if [[ "${ASSUME_YES}" -eq 1 ]]; then return 0; fi
  local prompt="$1"
  local ans
  read -r -p "${prompt} [Y/n] " ans || true
  case "${ans}" in
    ""|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

git_repo() {
  git -c safe.directory="${REPO_DIR}" -C "${REPO_DIR}" "$@"
}

ensure_git_safe_directory() {
  # The installer often runs as root, then hands the checkout to TARGET_USER.
  # Record the repo as safe for the current account before any follow-up pull.
  if git config --global --get-all safe.directory 2>/dev/null | grep -Fxq "${REPO_DIR}"; then
    return
  fi
  git config --global --add safe.directory "${REPO_DIR}" 2>/dev/null \
    || warn "couldn't add Git safe.directory for ${REPO_DIR}; continuing with per-command override"
}

# ---------------------------------------------------------------------------
# Step 1: apt deps
# ---------------------------------------------------------------------------

apt_install() {
  section "Installing apt packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  # Core tooling. Note we deliberately *don't* `apt install docker.io` --
  # debian's docker.io is fine but lacks the modern `compose` plugin on
  # some releases. We install docker.io + docker-compose-plugin from the
  # distro repo where possible, falling back to docker's official repo.
  local pkgs=(
    ca-certificates
    curl
    git
    jq
    python3
    python3-venv
    python3-pip
    iw
    rfkill
    hostapd
    dnsmasq
    iptables
    net-tools
    avahi-daemon
    # ALSA userspace tools. The container plays show audio through the Pi's
    # sound hardware; alsa-utils on the host lets an operator set the default
    # output + volume (alsamixer / amixer) and inspect cards (aplay -l), which
    # the "System default" output option follows.
    alsa-utils
    # Time sync stack -- see setup_time_sync() for the rationale.
    # systemd-timesyncd ships on Bookworm/Bullseye/Ubuntu but isn't
    # always installed on minimal Debian; pull it explicitly. fake-hwclock
    # keeps the wall clock approximately right across reboots when the
    # Pi has no real RTC and no upstream NTP (the AP-only deployment).
    systemd-timesyncd
    fake-hwclock
  )
  apt-get install -y --no-install-recommends "${pkgs[@]}"

  # Docker: prefer the distro packages; only reach for the upstream repo
  # if the distro doesn't ship docker-compose-plugin.
  if ! command -v docker >/dev/null 2>&1; then
    log "installing docker from distro repo..."
    if ! apt-get install -y --no-install-recommends docker.io docker-compose-plugin 2>/dev/null; then
      log "distro docker-compose-plugin not available; installing docker upstream repo..."
      install_docker_upstream
    fi
  fi

  # Some distros (older Bullseye) only ship `docker-compose` (the v1 python
  # tool). Backyard Hero's start.sh uses `docker compose` (plugin); the legacy
  # back gracefully -- log a notice if v2 isn't available.
  if ! docker compose version >/dev/null 2>&1; then
    if command -v docker-compose >/dev/null 2>&1; then
      warn "docker compose plugin v2 not installed; falling back to docker-compose v1"
    else
      warn "neither 'docker compose' nor 'docker-compose' available; installing plugin..."
      apt-get install -y --no-install-recommends docker-compose-plugin || install_docker_upstream
    fi
  fi

  systemctl enable --now docker.service || warn "couldn't enable docker.service"
}

install_docker_upstream() {
  # Pulled straight from https://docs.docker.com/engine/install/debian/.
  # Only invoked when the distro repo is too old.
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/debian/gpg \
      -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  local codename arch_id
  # shellcheck disable=SC1091
  . /etc/os-release
  codename="${VERSION_CODENAME:-bookworm}"
  case "$(dpkg --print-architecture)" in
    arm64)  arch_id="arm64"  ;;
    amd64)  arch_id="amd64"  ;;
    armhf)  arch_id="armhf"  ;;
    *)      arch_id="$(dpkg --print-architecture)" ;;
  esac
  # Pi OS reports ID=debian so this works on both Pi OS and Debian/Ubuntu.
  local repo_id="${ID}"
  case "${repo_id}" in raspbian) repo_id="debian" ;; esac
  cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${arch_id} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${repo_id} ${codename} stable
EOF
  apt-get update -y
  apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

add_user_to_groups() {
  if [[ -z "${TARGET_USER}" ]]; then
    warn "no non-root user found; skipping docker/dialout group setup"
    return
  fi
  log "adding ${TARGET_USER} to groups: docker, dialout"
  usermod -aG docker   "${TARGET_USER}" || true
  usermod -aG dialout  "${TARGET_USER}" || true
}

# ---------------------------------------------------------------------------
# Step 2: repo
# ---------------------------------------------------------------------------

locate_repo() {
  section "Locating backyardhero repo"

  # 1) If REPO_DIR was passed and looks like a checkout, use it.
  if [[ -n "${REPO_DIR}" && -d "${REPO_DIR}/host" && -f "${REPO_DIR}/host/Dockerfile" ]]; then
    log "using existing checkout at ${REPO_DIR}"
    return
  fi

  # 2) If the installer is running from inside a checkout (the common case
  #    when somebody clones and runs host/run/pi/install.sh), use that.
  #    Walk three levels up: host/run/pi/install.sh -> host/run -> host -> <repo>.
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local maybe_repo_root
  maybe_repo_root="$(cd "${script_dir}/../../.." && pwd)"
  if [[ -f "${maybe_repo_root}/host/Dockerfile" && -d "${maybe_repo_root}/.git" ]]; then
    REPO_DIR="${maybe_repo_root}"
    log "detected running from inside checkout: ${REPO_DIR}"
    return
  fi

  # 3) Otherwise clone. We force `GIT_TERMINAL_PROMPT=0` and an empty
  #    askpass so a bad URL fails immediately with a "could not read
  #    Username" error instead of stalling forever on a TTY credential
  #    prompt -- the install script may well be running under sudo from
  #    a wrapper that has no interactive stdin.
  REPO_DIR="${REPO_DIR:-${DEFAULT_REPO_DIR}}"
  if [[ -d "${REPO_DIR}/.git" ]]; then
    log "updating existing clone at ${REPO_DIR}"
    ensure_git_safe_directory
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
      git_repo fetch --depth 1 origin "${BRANCH}" || true
    git_repo checkout "${BRANCH}" || true
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
      git_repo pull --ff-only || true
  else
    log "cloning ${REPO_URL} -> ${REPO_DIR} (branch ${BRANCH})"
    mkdir -p "$(dirname "${REPO_DIR}")"
    if ! GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
         git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${REPO_DIR}"; then
      err "git clone of ${REPO_URL} failed."
      err ""
      err "Common causes:"
      err "  * The URL is wrong or the repo is private."
      err "  * No network on this Pi yet (need internet to clone)."
      err ""
      err "Workarounds:"
      err "  * Pass a different URL:    sudo $0 --repo-url <url>"
      err "  * Use SSH (if you have a deploy key on this box):"
      err "      sudo $0 --repo-url git@github.com:os4-ivmb/backyardhero_pyro.git"
      err "  * Or clone manually first and re-run from inside the checkout:"
      err "      git clone ${REPO_URL} ~/backyardhero"
      err "      sudo ~/backyardhero/host/run/pi/install.sh -y"
      die "aborting install"
    fi
  fi

  # Hand the checkout over to TARGET_USER so they can iterate on it
  # without sudo -- routine `git pull`, rsync from a dev box,
  # devices/utils/build_dongle.sh, etc. The byh-host systemd unit
  # still runs as root and reads the files fine regardless of owner.
  # We skip this for repos that live under /root/ (where keeping
  # root ownership is the more conservative default).
  if [[ -n "${TARGET_USER}" && "${REPO_DIR}" != "/root/"* ]]; then
    chown -R "${TARGET_USER}":"${TARGET_USER}" "${REPO_DIR}" || true
  fi
}

# ---------------------------------------------------------------------------
# Step 3: udev rule + dongle detection
# ---------------------------------------------------------------------------

install_udev_rule() {
  section "Installing dongle udev rule"
  # ESP32-S2 native USB CDC: vendor 0x303a (Espressif). The arduino-esp32
  # core uses the Espressif default VID for the CDC interface. We expose
  # a stable symlink at /dev/byh_dongle so systemcfg.json never has to
  # care which ttyACM the kernel picked this boot.
  cat >"${UDEV_RULE_PATH}" <<'EOF'
# Backyard Hero dongle: ESP32-S2 (lolin_s2_mini) native USB-CDC.
# Espressif vendor ID is 0x303a. Any tty-class USB-CDC device from
# Espressif gets a stable /dev/byh_dongle symlink. If you happen to have
# a second Espressif USB device plugged in this rule will match both --
# unplug it or add an ATTRS{idProduct} / ATTRS{serial} qualifier here.
SUBSYSTEM=="tty", SUBSYSTEMS=="usb", ATTRS{idVendor}=="303a", \
  SYMLINK+="byh_dongle", MODE="0660", GROUP="dialout", TAG+="systemd"
EOF
  chmod 0644 "${UDEV_RULE_PATH}"
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=tty || true
  sleep 1
}

detect_dongle_port() {
  # Echoes the best-guess dongle port to stdout, or empty if not found.
  # Preference order:
  #   1. /dev/byh_dongle (set by our udev rule)
  #   2. /dev/serial/by-id/* matching Espressif/ESP32/LOLIN
  #   3. /dev/ttyACM* with USB VID 303a
  #   4. First /dev/ttyACM*

  if [[ -e /dev/byh_dongle ]]; then
    echo "/dev/byh_dongle"
    return
  fi

  local entry
  if compgen -G "/dev/serial/by-id/*" >/dev/null; then
    for entry in /dev/serial/by-id/*; do
      case "$(basename "${entry}")" in
        *Espressif*|*ESP32*|*ESP_*|*LOLIN*|*usb-Espressif*)
          # Resolve through the symlink so we get e.g. /dev/ttyACM0.
          readlink -f "${entry}"
          return
          ;;
      esac
    done
  fi

  local tty
  if compgen -G "/dev/ttyACM*" >/dev/null; then
    for tty in /dev/ttyACM*; do
      local props
      props="$(udevadm info --query=property --name="${tty}" 2>/dev/null || true)"
      if echo "${props}" | grep -q '^ID_VENDOR_ID=303a'; then
        echo "${tty}"
        return
      fi
    done
    # Fallback: just take the first one and hope it's right.
    for tty in /dev/ttyACM*; do
      echo "${tty}"
      return
    done
  fi
  echo ""
}

update_systemcfg() {
  section "Updating systemcfg.user.json with dongle port"
  local cfg_dir="${REPO_DIR}/host/config"
  # Operator overrides live in systemcfg.user.json (NOT git-tracked), layered
  # on top of the git-tracked systemcfg.json at read time. Writing the dongle
  # port here keeps the base file pristine so `git pull` in update.sh never
  # conflicts on a locally-mutated config.
  local user_cfg="${cfg_dir}/systemcfg.user.json"
  if [[ ! -d "${cfg_dir}" ]]; then
    warn "config dir not found at ${cfg_dir}; skipping"
    return
  fi

  local detected
  detected="$(detect_dongle_port)"
  local target_port
  # Prefer the stable symlink even if it doesn't resolve yet -- udev will
  # create it the moment the dongle is plugged.
  target_port="/dev/byh_dongle"
  if [[ -n "${detected}" ]]; then
    log "detected dongle at ${detected} (will use ${target_port} for stability)"
  else
    warn "no dongle currently plugged in -- systemcfg.user.json will still"
    warn "point at ${target_port}; udev creates it on first hot-plug."
  fi

  python3 - "$user_cfg" "$target_port" <<'PY'
import json, os, sys
path, port = sys.argv[1], sys.argv[2]
# Merge into any existing user overrides rather than clobbering them.
cfg = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            cfg = json.load(f)
    except (ValueError, OSError):
        cfg = {}
if not isinstance(cfg, dict):
    cfg = {}
cfg.setdefault("system", {})
cfg["system"]["dongle_port"] = port
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"[byh-install] systemcfg.user.json: system.dongle_port = {port}")
PY
}

# ---------------------------------------------------------------------------
# Step 3.5: bridge venv
# ---------------------------------------------------------------------------

bridge_deps_ready() {
  local venv="${REPO_DIR}/host/tcp_serial_bridge/venv"
  [[ -x "${venv}/bin/python" ]] || return 1
  "${venv}/bin/python" <<'PY' >/dev/null 2>&1
import sys
try:
    import serial  # pyserial
    import esptool
except Exception:
    sys.exit(1)

version = getattr(esptool, "__version__", "0")
parts = []
for chunk in version.split("."):
    try:
        parts.append(int(chunk.split("-", 1)[0]))
    except ValueError:
        parts.append(0)
while len(parts) < 2:
    parts.append(0)
sys.exit(0 if tuple(parts[:2]) >= (4, 9) else 1)
PY
}

install_bridge_venv() {
  section "Preparing TCP-to-serial bridge Python venv"
  local bridge_dir="${REPO_DIR}/host/tcp_serial_bridge"
  local venv="${bridge_dir}/venv"
  local requirements="${bridge_dir}/requirements.txt"

  [[ -f "${requirements}" ]] || die "bridge requirements not found at ${requirements}"

  if [[ ! -x "${venv}/bin/python" ]]; then
    log "creating bridge venv at ${venv}"
    python3 -m venv "${venv}"
  fi

  if bridge_deps_ready; then
    log "bridge dependencies already installed"
  else
    log "installing bridge dependencies into ${venv}"
    "${venv}/bin/pip" install -q -r "${requirements}" \
      || die "failed to install bridge Python dependencies"
    bridge_deps_ready || die "bridge Python dependencies failed validation after install"
  fi

  if [[ -n "${TARGET_USER}" && "${REPO_DIR}" != "/root/"* ]]; then
    chown -R "${TARGET_USER}":"${TARGET_USER}" "${venv}" || true
  fi
}

# ---------------------------------------------------------------------------
# Step 4: docker image
# ---------------------------------------------------------------------------

prepull_image() {
  [[ "${DO_DOCKER_PULL}" -eq 1 ]] || { log "skipping docker pull"; return; }
  section "Pre-pulling Backyard Hero docker image"
  # host/run/pi/docker-compose.yml uses ${BYH_IMAGE:-os4ivmb/backyardhero:latest}.
  # Mirror that convention here so a) the installer agrees with what the
  # service will actually run, and b) operators can override with one
  # env var: `sudo BYH_IMAGE=foo/bar:tag ./install_pi.sh`.
  local image="${BYH_IMAGE:-os4ivmb/backyardhero:latest}"
  log "pulling ${image}..."
  docker pull "${image}" || warn "pull failed; will retry on first service start"
}

# ---------------------------------------------------------------------------
# Step 5: systemd auto-start
# ---------------------------------------------------------------------------

install_host_service() {
  [[ "${DO_SERVICE}" -eq 1 ]] || { log "skipping systemd service install"; return; }
  section "Installing systemd unit ${SERVICE_NAME}"
  local unit_path="/etc/systemd/system/${SERVICE_NAME}"
  cat >"${unit_path}" <<EOF
[Unit]
Description=Backyard Hero firework control host
Documentation=https://github.com/Os4ivmb/backyardhero
# Intentionally NOT waiting on network-online.target -- a stand-alone Pi
# running as its own AP may never have an upstream link, and the
# NetworkManager-wait-online stall (30s default) would push every boot
# back that far. docker.service + the AP iface service are enough: the
# host bridge talks to the dongle locally, and the AP itself only needs
# wlan0 to be up.
After=docker.service ${AP_IFACE_SERVICE_NAME}
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}/host
ExecStart=${REPO_DIR}/host/run/pi/start.sh
Restart=on-failure
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=30
# start.sh hands off to docker compose which manages its own
# subprocesses; we just need stdout/stderr to land in journald.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=byh-host

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${unit_path}"
  chmod +x "${REPO_DIR}/host/run/pi/start.sh"

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  log "${SERVICE_NAME} enabled. Start now with: sudo systemctl start ${SERVICE_NAME}"
}

# ---------------------------------------------------------------------------
# Step 6: WiFi access point (hostapd + dnsmasq)
# ---------------------------------------------------------------------------

iface_exists() {
  ip link show "$1" >/dev/null 2>&1
}

handoff_wlan_from_manager() {
  # Make sure NetworkManager / dhcpcd / wpa_supplicant aren't fighting us
  # for the AP interface. Each is independent -- a Pi OS Bookworm box has
  # NetworkManager; a Pi OS Bullseye box has dhcpcd + wpa_supplicant; an
  # Ubuntu Server box has netplan -> systemd-networkd (which usually
  # doesn't bind to wlan0 unless you told it to).
  local iface="$1"

  # NetworkManager: tell it to stop managing the AP iface.
  if systemctl is-active --quiet NetworkManager 2>/dev/null; then
    log "handing ${iface} off from NetworkManager"
    mkdir -p /etc/NetworkManager/conf.d
    cat >/etc/NetworkManager/conf.d/99-byh-unmanaged.conf <<EOF
# Backyard Hero: hostapd owns ${iface}.
[keyfile]
unmanaged-devices=interface-name:${iface}
EOF
    nmcli device set "${iface}" managed no 2>/dev/null || true
    systemctl reload NetworkManager 2>/dev/null || systemctl restart NetworkManager 2>/dev/null || true
  fi

  # dhcpcd (Pi OS Bullseye and earlier).
  if [[ -f /etc/dhcpcd.conf ]] && systemctl is-active --quiet dhcpcd 2>/dev/null; then
    if ! grep -q "^denyinterfaces .*${iface}" /etc/dhcpcd.conf; then
      log "telling dhcpcd to leave ${iface} alone"
      printf '\n# Added by byh-install\ndenyinterfaces %s\n' "${iface}" \
        >> /etc/dhcpcd.conf
      systemctl restart dhcpcd 2>/dev/null || true
    fi
  fi

  # wpa_supplicant on the AP iface would re-associate as a client. Kill any
  # interface-specific unit if present.
  systemctl disable --now "wpa_supplicant@${iface}.service" 2>/dev/null || true

  # Unblock the radio (fresh images often arrive rfkill-soft-blocked until
  # a country code is set).
  rfkill unblock wlan 2>/dev/null || true

  # Set the regulatory domain. raspi-config knows the right magic on Pi OS;
  # everywhere else we drop the country code into a config file.
  if command -v raspi-config >/dev/null 2>&1; then
    raspi-config nonint do_wifi_country "${AP_COUNTRY}" 2>/dev/null || true
  fi
  if [[ -d /etc/wpa_supplicant ]]; then
    local wpa_conf="/etc/wpa_supplicant/wpa_supplicant.conf"
    if [[ -f "${wpa_conf}" ]] && ! grep -qE '^country=' "${wpa_conf}"; then
      printf 'country=%s\n' "${AP_COUNTRY}" >> "${wpa_conf}"
    fi
  fi
  iw reg set "${AP_COUNTRY}" 2>/dev/null || true
}

write_iface_service() {
  # Assigns the static IP on the AP interface before hostapd binds. Using
  # a dedicated oneshot unit is the simplest approach that works regardless
  # of whether the underlying network manager is NetworkManager,
  # systemd-networkd, or dhcpcd.
  local iface="$1"
  local unit_path="/etc/systemd/system/${AP_IFACE_SERVICE_NAME}"
  cat >"${unit_path}" <<EOF
[Unit]
Description=Backyard Hero AP interface bring-up
Before=hostapd.service dnsmasq.service
After=sys-subsystem-net-devices-${iface}.device
Wants=sys-subsystem-net-devices-${iface}.device

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/ip link set ${iface} up
ExecStart=-/usr/sbin/ip addr flush dev ${iface}
ExecStart=/usr/sbin/ip addr add ${AP_IP}/${AP_CIDR} dev ${iface}
ExecStop=-/usr/sbin/ip addr flush dev ${iface}
ExecStop=-/usr/sbin/ip link set ${iface} down

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${unit_path}"
}

write_hostapd_conf() {
  cat >"${HOSTAPD_CONF_PATH}" <<EOF
# Backyard Hero AP -- generated by install_pi.sh.
interface=${AP_IFACE}
driver=nl80211
ssid=${AP_SSID}
country_code=${AP_COUNTRY}
hw_mode=g
channel=${AP_CHANNEL}
ieee80211n=1
wmm_enabled=1
ieee80211d=1
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
wpa_passphrase=${AP_PASSWORD}
# Hard-stop association from clients that pick a different band/mode.
macaddr_acl=0
EOF
  chmod 0600 "${HOSTAPD_CONF_PATH}"

  # /etc/default/hostapd -- the legacy "where is my config file" hint.
  # Setting this is harmless on systems that don't read it.
  if [[ -f "${HOSTAPD_DEFAULT_PATH}" ]]; then
    if grep -qE '^#?DAEMON_CONF=' "${HOSTAPD_DEFAULT_PATH}"; then
      sed -i 's|^#\?DAEMON_CONF=.*|DAEMON_CONF="'"${HOSTAPD_CONF_PATH}"'"|' "${HOSTAPD_DEFAULT_PATH}"
    else
      printf '\nDAEMON_CONF=%s\n' "\"${HOSTAPD_CONF_PATH}\"" \
        >>"${HOSTAPD_DEFAULT_PATH}"
    fi
  else
    printf 'DAEMON_CONF="%s"\n' "${HOSTAPD_CONF_PATH}" > "${HOSTAPD_DEFAULT_PATH}"
  fi
}

write_dnsmasq_conf() {
  cat >"${DNSMASQ_CONF_PATH}" <<EOF
# Backyard Hero AP DHCP -- generated by install_pi.sh.
# Only listen on the AP interface so we don't conflict with whatever
# upstream resolver / DHCP server may exist on Ethernet.
interface=${AP_IFACE}
bind-interfaces
except-interface=lo
listen-address=${AP_IP}
dhcp-range=${AP_DHCP_START},${AP_DHCP_END},255.255.255.0,12h
dhcp-option=3,${AP_IP}
dhcp-option=6,${AP_IP}
domain-needed
bogus-priv
# Friendly hostnames so AP clients can punch in a name instead of an
# IP. Modern browsers (Chrome, Safari, Firefox) treat single-word
# inputs like "backyardhero" as search queries unless the hostname
# either has a dot or a trailing slash, so the .local variants are
# what we point operators at -- mDNS handles .local on macOS/iOS/Linux
# natively, and we publish a regular A-record here for Windows /
# Android clients that aren't reading our mDNS responder.
# The bare names ("backyardhero", "byh", "pyro") still resolve here
# for clients that DO try direct DNS lookup -- they just won't be
# the first thing a browser tries.
address=/byh.local/${AP_IP}
address=/backyardhero.local/${AP_IP}
address=/pyro.local/${AP_IP}
address=/byh/${AP_IP}
address=/backyardhero/${AP_IP}
address=/pyro/${AP_IP}
EOF
  chmod 0644 "${DNSMASQ_CONF_PATH}"
}

write_ap_apply_script() {
  # Python helper that the UI invokes (indirectly, via a request file on
  # the shared /data volume) to change the AP SSID / password / channel
  # at runtime. See `install_ap_apply_service` below for the wiring.
  cat >"${AP_APPLY_SCRIPT_PATH}" <<'PY'
#!/usr/bin/env python3
"""byh-ap-apply.py -- apply an AP configuration change requested by the
Backyard Hero web UI.

Triggered by byh-ap-apply.path when the UI (running inside the docker
container) writes a request file into the host/data volume that the
container also has mounted at /data. We validate the request, rewrite
/etc/hostapd/hostapd.conf, persist the new state, and schedule a
deferred hostapd restart so the API response can reach the client
*before* their WiFi association dies.

Files (all on the host, under $BYH_DATA_DIR):
  byh_ap_request.json  - written by the UI; what to apply.
  byh_ap_status.json   - written by us; outcome of the last apply.
  byh_ap_current.json  - written by us; authoritative current state
                         that the UI reads to pre-fill its form.
"""

from __future__ import annotations
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

DATA_DIR     = Path(os.environ.get("BYH_DATA_DIR", "/opt/backyardhero/host/data"))
HOSTAPD_CONF = Path(os.environ.get("BYH_HOSTAPD_CONF", "/etc/hostapd/hostapd.conf"))
HOSTAPD_BAK  = HOSTAPD_CONF.with_suffix(HOSTAPD_CONF.suffix + ".byh.bak")

REQ_PATH     = DATA_DIR / "byh_ap_request.json"
STATUS_PATH  = DATA_DIR / "byh_ap_status.json"
CURRENT_PATH = DATA_DIR / "byh_ap_current.json"

# WPA2 passphrase length per IEEE 802.11i: 8..63 printable ASCII chars.
SSID_RE     = re.compile(r"^[\x20-\x7e]{1,32}$")
PASSWORD_RE = re.compile(r"^[\x20-\x7e]{8,63}$")
COUNTRY_RE  = re.compile(r"^[A-Z]{2}$")

# How long we wait after restarting hostapd before declaring it healthy.
# Long enough for nl80211 to bring the AP back up, short enough that an
# operator stuck on the rollback path isn't waiting forever.
RESTART_VERIFY_SLEEP_S = 4.0
# Time between the success status being written and the actual hostapd
# restart. Gives the API POST response a chance to flush to the UI
# before the WiFi association drops.
DEFER_RESTART_S = 3


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def write_status(request_id: str, ok: bool, error: str | None = None, **extra) -> None:
    out = {
        "request_id": request_id,
        "ok": bool(ok),
        "error": error,
        "applied_at": now_iso(),
    }
    out.update(extra)
    write_json(STATUS_PATH, out)


def read_current_hostapd() -> dict:
    """Parse the live hostapd.conf so the UI can show "current" values
    even if /data/byh_ap_current.json was wiped."""
    out = {}
    if not HOSTAPD_CONF.exists():
        return out
    keys = {"ssid", "wpa_passphrase", "channel", "country_code", "interface"}
    for raw in HOSTAPD_CONF.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if k in keys:
            out[k] = v
    return out


def write_hostapd_conf(ssid: str, password: str, channel: int, country: str, interface: str) -> None:
    body = (
        "# Backyard Hero AP -- managed by byh-ap-apply.py.\n"
        f"interface={interface}\n"
        "driver=nl80211\n"
        f"ssid={ssid}\n"
        f"country_code={country}\n"
        "hw_mode=g\n"
        f"channel={channel}\n"
        "ieee80211n=1\n"
        "wmm_enabled=1\n"
        "ieee80211d=1\n"
        "auth_algs=1\n"
        "ignore_broadcast_ssid=0\n"
        "wpa=2\n"
        "wpa_key_mgmt=WPA-PSK\n"
        "rsn_pairwise=CCMP\n"
        f"wpa_passphrase={password}\n"
        "macaddr_acl=0\n"
    )
    tmp = HOSTAPD_CONF.with_suffix(HOSTAPD_CONF.suffix + ".tmp")
    tmp.write_text(body)
    os.chmod(tmp, 0o600)
    os.replace(tmp, HOSTAPD_CONF)


def systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["systemctl", *args], check=check, capture_output=True, text=True)


def hostapd_active() -> bool:
    r = systemctl("is-active", "hostapd.service", check=False)
    return r.stdout.strip() == "active"


def schedule_deferred_restart() -> None:
    """Use systemd-run to restart hostapd a few seconds from now so the
    UI's HTTP response has time to land before the WiFi association
    dies. The transient unit re-invokes this script with
    --restart-and-verify, which also handles the rollback path."""
    subprocess.run(
        [
            "systemd-run",
            f"--on-active={DEFER_RESTART_S}s",
            "--unit=byh-ap-apply-restart.service",
            "--description=Backyard Hero deferred hostapd restart + verify",
            sys.executable, str(Path(__file__).resolve()), "--restart-and-verify",
        ],
        check=True,
    )


def update_current(ssid: str, password: str, channel: int, country: str, interface: str) -> None:
    # Preserve any fields the install script wrote that we don't manage
    # here (gateway_ip, cidr, web_url, etc.) -- the UI uses those to
    # render reconnect instructions.
    try:
        prev = json.loads(CURRENT_PATH.read_text())
        if not isinstance(prev, dict):
            prev = {}
    except Exception:
        prev = {}
    prev.update({
        "interface": interface,
        "ssid": ssid,
        "password": password,
        "channel": int(channel),
        "country": country,
        "updated_at": now_iso(),
    })
    write_json(CURRENT_PATH, prev)


def apply_request() -> int:
    if not REQ_PATH.exists():
        return 0
    try:
        with open(REQ_PATH) as f:
            req = json.load(f)
    except Exception as e:
        write_status("unknown", False, f"failed to parse request: {e}")
        return 1

    request_id = str(req.get("request_id") or f"unsolicited-{int(time.time())}")

    # Idempotency: if the last successful status matches, no-op. Keeps
    # path-watcher event storms (e.g. a copy-into-place that fires multiple
    # IN_MODIFY events) from each triggering a hostapd restart.
    if STATUS_PATH.exists():
        try:
            prev = json.loads(STATUS_PATH.read_text())
            if prev.get("request_id") == request_id and prev.get("ok"):
                return 0
        except Exception:
            pass

    cur = read_current_hostapd()
    ssid      = str(req.get("ssid", cur.get("ssid", "")))
    password  = str(req.get("password", cur.get("wpa_passphrase", "")))
    channel   = req.get("channel", cur.get("channel", 6))
    country   = str(req.get("country", cur.get("country_code", "US"))).upper()
    interface = cur.get("interface", "wlan0")

    if not SSID_RE.match(ssid):
        write_status(request_id, False, "SSID must be 1-32 printable ASCII characters")
        return 1
    if not PASSWORD_RE.match(password):
        write_status(request_id, False, "Password must be 8-63 printable ASCII characters")
        return 1
    try:
        channel_n = int(channel)
        if not 1 <= channel_n <= 14:
            raise ValueError
    except (TypeError, ValueError):
        write_status(request_id, False, "Channel must be an integer 1-14")
        return 1
    if not COUNTRY_RE.match(country):
        write_status(request_id, False, "Country must be a 2-letter ISO code (e.g. US)")
        return 1

    # Snapshot so we can roll back if hostapd refuses to come back up.
    if HOSTAPD_CONF.exists():
        try:
            shutil.copy2(HOSTAPD_CONF, HOSTAPD_BAK)
        except Exception as e:
            write_status(request_id, False, f"failed to back up hostapd.conf: {e}")
            return 1

    try:
        write_hostapd_conf(ssid, password, channel_n, country, interface)
    except Exception as e:
        write_status(request_id, False, f"failed to write hostapd.conf: {e}")
        return 1

    update_current(ssid, password, channel_n, country, interface)

    # Optimistically report success: the UI gets the response and the
    # operator gets reconnect instructions BEFORE the radio resets. The
    # deferred --restart-and-verify path will update the status (and roll
    # back) if hostapd actually refuses the new config.
    write_status(
        request_id, True, error=None,
        ssid=ssid, channel=channel_n, country=country, interface=interface,
        phase="scheduled_restart",
        restart_in_s=DEFER_RESTART_S,
    )

    try:
        schedule_deferred_restart()
    except subprocess.CalledProcessError as e:
        # Couldn't schedule -- fall back to an immediate restart in-band.
        write_status(
            request_id, True, error=f"deferred restart failed to schedule; restarting now: {e}",
            ssid=ssid, channel=channel_n, country=country, interface=interface,
            phase="immediate_restart",
        )
        return restart_and_verify(request_id)
    return 0


def restart_and_verify(request_id: str | None = None) -> int:
    """Restart hostapd and, if it doesn't come back, roll the config
    back. Always invoked from a transient unit -- never blocks the
    original path-trigger service."""
    if request_id is None:
        # Recover the request_id from the most recently written status,
        # so the UI's status poll continues to see consistent IDs.
        try:
            request_id = json.loads(STATUS_PATH.read_text()).get("request_id", "unknown")
        except Exception:
            request_id = "unknown"

    try:
        systemctl("restart", "hostapd.service")
    except subprocess.CalledProcessError as e:
        return _rollback(request_id, f"hostapd restart failed: {e.stderr or e.stdout}")

    time.sleep(RESTART_VERIFY_SLEEP_S)
    if hostapd_active():
        # Re-write success status with the final phase so the UI's next
        # poll (or first poll after reconnect) sees a definitive answer.
        try:
            cur = json.loads(CURRENT_PATH.read_text())
            write_status(
                request_id, True, error=None,
                ssid=cur.get("ssid"), channel=cur.get("channel"),
                country=cur.get("country"), interface=cur.get("interface"),
                phase="active",
            )
        except Exception:
            pass
        return 0

    return _rollback(request_id, "hostapd did not come up with the new config")


def _rollback(request_id: str, reason: str) -> int:
    if HOSTAPD_BAK.exists():
        try:
            shutil.copy2(HOSTAPD_BAK, HOSTAPD_CONF)
            systemctl("restart", "hostapd.service", check=False)
        except Exception:
            pass
        # Refresh the current-state file from the restored config so the
        # UI re-displays what's actually live.
        cur = read_current_hostapd()
        if cur:
            update_current(
                cur.get("ssid", ""),
                cur.get("wpa_passphrase", ""),
                int(cur.get("channel", 6)),
                cur.get("country_code", "US"),
                cur.get("interface", "wlan0"),
            )
    write_status(request_id, False, f"rolled back: {reason}", phase="rolled_back")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply Backyard Hero AP config change")
    parser.add_argument("--restart-and-verify", action="store_true",
                        help="Restart hostapd and roll back if it fails to come up.")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.restart_and_verify:
        return restart_and_verify()
    return apply_request()


if __name__ == "__main__":
    sys.exit(main())
PY
  chmod 0755 "${AP_APPLY_SCRIPT_PATH}"
}

write_ap_apply_units() {
  local data_dir="${REPO_DIR}/host/data"
  mkdir -p "${data_dir}"

  # The service is a oneshot driven by the .path unit below. We pass
  # the data dir + hostapd conf path explicitly so the apply script is
  # decoupled from any layout choice we change later.
  cat >"/etc/systemd/system/${AP_APPLY_SERVICE_NAME}" <<EOF
[Unit]
Description=Apply Backyard Hero AP configuration change requested by the UI
Documentation=https://github.com/Os4ivmb/backyardhero
After=hostapd.service

[Service]
Type=oneshot
ExecStart=${AP_APPLY_SCRIPT_PATH}
Environment=BYH_DATA_DIR=${data_dir}
Environment=BYH_HOSTAPD_CONF=${HOSTAPD_CONF_PATH}
# Keep the script's exit code visible in journalctl without retrying;
# the .path unit will fire again on the next request file write.
SuccessExitStatus=0
EOF

  # The path unit watches the request file the UI writes into the
  # shared /data volume. PathChanged covers both create and modify, and
  # fires exactly once per write event (inotify-coalesced by systemd).
  cat >"/etc/systemd/system/${AP_APPLY_PATH_NAME}" <<EOF
[Unit]
Description=Watch for Backyard Hero AP config change requests
After=local-fs.target

[Path]
PathChanged=${data_dir}/byh_ap_request.json
Unit=${AP_APPLY_SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

  chmod 0644 "/etc/systemd/system/${AP_APPLY_SERVICE_NAME}"
  chmod 0644 "/etc/systemd/system/${AP_APPLY_PATH_NAME}"
}

write_initial_ap_current() {
  # Seed the "current state" file with whatever we just configured so
  # the UI has something to display on first boot, before the operator
  # has triggered any change. `gateway_ip` is captured here (and only
  # here -- the apply script preserves it across SSID/password changes)
  # so the UI can show clients the right reconnect URL without having
  # to scrape /etc/hostapd/hostapd.conf.
  local data_dir="${REPO_DIR}/host/data"
  local current="${data_dir}/byh_ap_current.json"
  mkdir -p "${data_dir}"
  python3 - "${current}" "${AP_IFACE}" "${AP_SSID}" "${AP_PASSWORD}" \
                         "${AP_CHANNEL}" "${AP_COUNTRY}" "${AP_IP}" \
                         "${AP_CIDR}" <<'PY'
import json, sys, time
path, iface, ssid, password, channel, country, ip, cidr = sys.argv[1:9]
data = {
    "interface": iface,
    "ssid": ssid,
    "password": password,
    "channel": int(channel),
    "country": country,
    "gateway_ip": ip,
    "cidr": int(cidr),
    # The friendly URL the UI surfaces to operators. Port 80 is
    # mapped to the container's 1776 in host/run/pi/docker-compose.yml.
    # backyardhero.local is preferred over the raw IP because
    # mDNS makes it work on any client device on the AP.
    "web_url": "http://backyardhero.local/",
    "fallback_urls": [
        "http://byh.local/",
        f"http://{ip}/",
        f"http://{ip}:1776/",
    ],
    "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
  # World-readable is fine; the file lives in the docker volume and the
  # container reads it through its own /data mount.
  chmod 0644 "${current}"
}

install_ap_apply_service() {
  log "installing AP config apply service (UI-driven SSID/password change)"
  write_ap_apply_script
  write_ap_apply_units
  write_initial_ap_current
  systemctl daemon-reload
  systemctl enable  "${AP_APPLY_PATH_NAME}"
  systemctl restart "${AP_APPLY_PATH_NAME}" || warn "couldn't start ${AP_APPLY_PATH_NAME}"
}

# ---------------------------------------------------------------------------
# UI-driven system update apply service.
# ---------------------------------------------------------------------------
#
# Mirrors the AP apply plumbing above: a path-watcher fires a oneshot
# service when the in-container Next.js app drops a request file onto
# the host/data bind-mount. The oneshot runs an apply script that runs
# update.sh and streams progress back into /data/byh_update_status.json
# so the UI can show a live progress bar.

write_update_apply_script() {
  # Python helper that the UI invokes (indirectly, via a request file
  # on the shared /data volume) to pull the latest source + Docker
  # image and restart the byh-host service. See `install_update_service`
  # below for the wiring.
  cat >"${UPDATE_APPLY_SCRIPT_PATH}" <<'PY'
#!/usr/bin/env python3
"""byh-update.py -- apply a system update requested by the Backyard
Hero web UI.

Triggered by byh-update.path when the UI (running inside the docker
container) writes a request file into the host/data volume that the
container also has mounted at /data. We:

  1. Run a small connectivity preflight (GitHub + Docker Hub).
  2. Drive host/run/pi/update.sh with the requested flags, streaming
     stdout into /data/byh_update_status.json so the UI can show a
     live progress bar.
  3. update.sh's last step restarts byh-host.service (or reboots the
     Pi). That kills the docker container the UI lives in; when it
     comes back up, it reads the same status file (which is on the
     host filesystem via the bind mount) and shows the final result.

Files (all on the host, under $BYH_DATA_DIR):
  byh_update_request.json  - written by the UI; what to do.
  byh_update_status.json   - written by us; current phase + log tail.

The status file is written atomically (tmp + rename) so the UI never
sees a half-written JSON document, even if the container is being
torn down concurrently with our write.
"""

from __future__ import annotations
import argparse
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.error import URLError, HTTPError
from urllib.request import urlopen, Request

DATA_DIR    = Path(os.environ.get("BYH_DATA_DIR", "/opt/backyardhero/host/data"))
REPO_DIR    = Path(os.environ.get("BYH_REPO_DIR", "/opt/backyardhero"))
UPDATE_SH   = Path(os.environ.get("BYH_UPDATE_SH",
                                  str(REPO_DIR / "host" / "run" / "pi" / "update.sh")))

REQ_PATH    = DATA_DIR / "byh_update_request.json"
STATUS_PATH = DATA_DIR / "byh_update_status.json"

# Connectivity probes. Both are deliberately tiny endpoints that:
#   - Return successfully on a correctly-configured network.
#   - Validate DNS + TCP + TLS + HTTP at once.
#   - Don't depend on the Backyard Hero project being well-known to
#     the test endpoint (so they keep working forever).
GITHUB_PROBE_URL    = "https://api.github.com/zen"
DOCKERHUB_PROBE_URL = "https://registry-1.docker.io/v2/"
PROBE_TIMEOUT_S     = 5.0

# How many lines of update.sh stdout we keep in the status file.
# Sized to comfortably cover the longest legible progress dump (git
# pull + docker compose pull + install.sh re-run) without bloating
# the JSON file the UI re-fetches every couple seconds.
LOG_TAIL_LINES      = 200

# Status-file write coalescing. update.sh emits a lot of progress
# lines from `docker compose pull`; we don't want to write the
# status file on every one of them. This caps writes to ~10/s
# regardless of subprocess output rate.
MIN_WRITE_INTERVAL_S = 0.1

# update.sh prints section headers like:
#     ==[ Pulling latest source ]==
# We map those to a 'step' enum the UI can render specifically.
SECTION_RE = re.compile(r"^==\[\s*(.*?)\s*\]==\s*$")
STEP_FROM_SECTION = {
    "Pulling latest source":          "git_pull",
    "Pulling latest Docker image":    "docker_pull",
    "Re-running install.sh (idempotent re-apply)": "install",
    "Restarting byh-host.service":    "restart",
    "Rebooting Pi":                   "reboot",
    "Done":                           "done",
}


# ---------------------------------------------------------------------------
# Shared status-file helpers
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json_atomic(path: Path, data: dict) -> None:
    """Write JSON via tmp + rename so concurrent readers (the Next.js
    GET handler) never see a torn file. Required because the docker
    container restart races with our final phase=done write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Connectivity preflight
# ---------------------------------------------------------------------------

def probe_url(url: str, timeout: float = PROBE_TIMEOUT_S) -> tuple[bool, str]:
    """Return (ok, detail). ok=True iff we got an HTTP response (even 4xx);
    a 401 from registry-1.docker.io is fine -- it means we reached the
    server. Network-level failures (DNS, refused, TLS) return ok=False."""
    try:
        req = Request(url, headers={"User-Agent": "byh-update/1.0"})
        ctx = ssl.create_default_context()
        with urlopen(req, timeout=timeout, context=ctx) as r:
            return True, f"HTTP {r.status}"
    except HTTPError as e:
        # Reached the server, server returned a status. Good enough --
        # registry-1.docker.io v2/ returns 401 because we didn't send
        # an auth token; that still proves connectivity.
        return True, f"HTTP {e.code}"
    except (URLError, ssl.SSLError, socket.timeout, socket.gaierror, OSError) as e:
        return False, f"{type(e).__name__}: {e}"


def preflight() -> dict:
    """Probe GitHub and Docker Hub. Returns a dict suitable for
    embedding in the status file. internet_ok=True iff both probes
    succeeded; we soft-block updates when either fails because the
    relevant `git pull` / `docker pull` will then hang indefinitely
    or fail with confusing errors."""
    gh_ok,  gh_detail  = probe_url(GITHUB_PROBE_URL)
    dh_ok,  dh_detail  = probe_url(DOCKERHUB_PROBE_URL)
    return {
        "internet_ok": bool(gh_ok and dh_ok),
        "probes": {
            "github":     {"ok": gh_ok, "detail": gh_detail, "url": GITHUB_PROBE_URL},
            "dockerhub":  {"ok": dh_ok, "detail": dh_detail, "url": DOCKERHUB_PROBE_URL},
        },
        "checked_at": now_iso(),
    }


# ---------------------------------------------------------------------------
# Update job state
# ---------------------------------------------------------------------------

class UpdateJob:
    """Mutable state for one in-flight (or finished) update.

    Status-file writes go through `_write()` which always re-serialises
    the full snapshot. Cheap, and means partial-update bugs can't leak
    a stale field into the next phase."""

    def __init__(self, request_id: str, options: dict, do_source: bool, do_image: bool,
                 do_install: bool, restart_mode: str, force: bool):
        self.request_id   = request_id
        self.options      = options          # echoed back in status for the UI
        self.do_source    = do_source
        self.do_image     = do_image
        self.do_install   = do_install
        self.restart_mode = restart_mode      # "service" | "reboot" | "none"
        self.force        = force

        self.phase: str       = "preparing"
        self.step:  str|None  = None
        self.error: str|None  = None
        self.exit_code: int|None = None
        self.started_at: str  = now_iso()
        self.updated_at: str  = self.started_at
        self.ended_at: str|None = None
        self.preflight: dict|None = None
        self._log_tail: list[str] = []
        self._lock = threading.Lock()
        self._last_write_ts = 0.0

    def _snapshot(self) -> dict:
        return {
            "request_id":    self.request_id,
            "phase":         self.phase,
            "step":          self.step,
            "error":         self.error,
            "exit_code":     self.exit_code,
            "started_at":    self.started_at,
            "updated_at":    self.updated_at,
            "ended_at":      self.ended_at,
            "options":       self.options,
            "restart_mode":  self.restart_mode,
            "preflight":     self.preflight,
            "log_tail":      list(self._log_tail),
        }

    def _write(self, *, force: bool = False) -> None:
        """Persist the current snapshot. Coalesces writes to MIN_WRITE_INTERVAL_S
        unless `force=True` (used at phase boundaries so the UI sees
        the new phase immediately)."""
        now = time.monotonic()
        if not force and (now - self._last_write_ts) < MIN_WRITE_INTERVAL_S:
            return
        self._last_write_ts = now
        self.updated_at = now_iso()
        try:
            write_json_atomic(STATUS_PATH, self._snapshot())
        except OSError as e:
            sys.stderr.write(f"[byh-update] failed to write status: {e}\n")

    def set_phase(self, phase: str, *, step: str|None = None, error: str|None = None,
                  exit_code: int|None = None) -> None:
        with self._lock:
            self.phase = phase
            if step is not None:
                self.step = step
            if error is not None:
                self.error = error
            if exit_code is not None:
                self.exit_code = exit_code
            if phase in ("done", "error"):
                self.ended_at = now_iso()
            self._write(force=True)

    def set_preflight(self, pre: dict) -> None:
        with self._lock:
            self.preflight = pre
            self._write(force=True)

    def append_log(self, line: str) -> None:
        line = line.rstrip("\n")
        if not line:
            return
        with self._lock:
            self._log_tail.append(line)
            if len(self._log_tail) > LOG_TAIL_LINES:
                self._log_tail = self._log_tail[-LOG_TAIL_LINES:]
            # Auto-classify section headers so the UI gets phase/step
            # transitions for free.
            m = SECTION_RE.match(line)
            if m:
                section_name = m.group(1)
                step_key = STEP_FROM_SECTION.get(section_name)
                if step_key:
                    self.step = step_key
                    if step_key == "restart":
                        self.phase = "restarting"
                    elif step_key == "reboot":
                        self.phase = "rebooting"
                    elif step_key == "done":
                        # The "Done" section is the last thing
                        # update.sh prints BEFORE issuing the systemctl
                        # restart, so don't flip to "done" here -- the
                        # final phase transition happens after the
                        # subprocess actually exits.
                        pass
            self._write()


# ---------------------------------------------------------------------------
# Driving update.sh
# ---------------------------------------------------------------------------

def ensure_git_safe_directory(job: UpdateJob) -> None:
    """Persist Git's safe.directory for the account running this systemd unit.

    The UI updater runs as root while the checkout is usually owned by
    byhuser. Newer Git rejects that as dubious ownership unless root's config
    explicitly trusts the checkout path.
    """
    repo = str(REPO_DIR)
    try:
        existing = subprocess.run(
            ["git", "config", "--global", "--get-all", "safe.directory"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
        if repo in {line.strip() for line in existing.stdout.splitlines()}:
            return
        added = subprocess.run(
            ["git", "config", "--global", "--add", "safe.directory", repo],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if added.returncode != 0:
            detail = (added.stderr or "").strip()
            job.append_log(
                f"[byh-update] WARN: couldn't add Git safe.directory for {repo}"
                + (f": {detail}" if detail else "")
            )
    except OSError as e:
        job.append_log(f"[byh-update] WARN: couldn't check Git safe.directory: {e}")


def build_update_argv(job: UpdateJob) -> list[str]:
    """Translate the job's high-level toggles to the flags update.sh
    actually understands."""
    argv = [str(UPDATE_SH), "-y"]
    if not job.do_source:  argv.append("--no-source")
    if not job.do_image:   argv.append("--no-image")
    if not job.do_install: argv.append("--no-install")
    if   job.restart_mode == "none":   argv.append("--no-restart")
    elif job.restart_mode == "reboot": argv.append("--reboot")
    # restart_mode == "service" is update.sh's default; no flag needed.
    return argv


def run_update(job: UpdateJob) -> int:
    """Spawn update.sh and stream its stdout into the status file's
    log_tail. Returns the subprocess exit code."""
    if job.do_source:
        ensure_git_safe_directory(job)

    argv = build_update_argv(job)
    job.append_log(f"$ {' '.join(argv)}")

    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    # update.sh uses ANSI colour escapes via printf "\033[...m"; the
    # log_tail UI renders them as raw bytes, which looks like garbage.
    # Easiest fix: ask update.sh nicely to skip them by un-setting
    # TERM and forcing NO_COLOR=1 (curl, git, install.sh respect it;
    # update.sh itself uses unconditional escapes but those are easy
    # to strip on the way past).
    env["NO_COLOR"] = "1"
    env.pop("TERM", None)

    proc = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        text=True,
        env=env,
    )
    assert proc.stdout is not None

    ansi_re = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
    for raw in proc.stdout:
        clean = ansi_re.sub("", raw)
        job.append_log(clean)

    rc = proc.wait()
    return rc


# ---------------------------------------------------------------------------
# Top-level apply path
# ---------------------------------------------------------------------------

def parse_request() -> tuple[dict|None, str|None]:
    """Read /data/byh_update_request.json. Returns (request_dict, error_str)."""
    try:
        with open(REQ_PATH) as f:
            req = json.load(f)
    except FileNotFoundError:
        return None, "no request file (path watcher fired with no request payload)"
    except (json.JSONDecodeError, OSError) as e:
        return None, f"failed to parse request: {e}"
    if not isinstance(req, dict):
        return None, "request must be a JSON object"
    return req, None


def apply_request() -> int:
    req, err = parse_request()
    if req is None:
        # Write a synthetic error status with a stable request_id so
        # the UI's poll has something to display rather than spinning
        # on a stale "preparing" snapshot.
        request_id = f"unsolicited-{int(time.time())}"
        write_json_atomic(STATUS_PATH, {
            "request_id": request_id,
            "phase": "error",
            "error": err,
            "started_at": now_iso(),
            "updated_at": now_iso(),
            "ended_at":   now_iso(),
        })
        return 1

    # Idempotency: if we just successfully serviced this request_id,
    # don't re-run it. systemd .path units can fire multiple times for
    # a single write event (atomic-rename on the request file looks
    # like a CHANGED+CREATED to inotify).
    request_id = str(req.get("request_id") or f"unsolicited-{int(time.time())}")
    if STATUS_PATH.exists():
        try:
            prev = json.loads(STATUS_PATH.read_text())
            if (prev.get("request_id") == request_id
                    and prev.get("phase") in ("done", "error", "restarting", "rebooting")):
                return 0
        except (OSError, json.JSONDecodeError):
            pass

    do_source    = bool(req.get("do_source",  True))
    do_image     = bool(req.get("do_image",   True))
    do_install   = bool(req.get("do_install", True))
    restart_mode = str(req.get("restart_mode", "service")).lower()
    force        = bool(req.get("force",      False))

    if restart_mode not in ("service", "reboot", "none"):
        write_json_atomic(STATUS_PATH, {
            "request_id": request_id,
            "phase": "error",
            "error": f"restart_mode must be one of service/reboot/none (got {restart_mode!r})",
            "started_at": now_iso(),
            "updated_at": now_iso(),
            "ended_at":   now_iso(),
        })
        return 1

    job = UpdateJob(
        request_id=request_id,
        options={
            "do_source": do_source,
            "do_image":  do_image,
            "do_install": do_install,
            "restart_mode": restart_mode,
            "force": force,
        },
        do_source=do_source,
        do_image=do_image,
        do_install=do_install,
        restart_mode=restart_mode,
        force=force,
    )

    # ----- preflight -----
    job.set_phase("preflight")
    pre = preflight()
    job.set_preflight(pre)
    if not pre["internet_ok"] and not force:
        gh = pre["probes"]["github"]["detail"]
        dh = pre["probes"]["dockerhub"]["detail"]
        job.set_phase("error", error=(
            "No internet connectivity (github: " + gh + "; dockerhub: " + dh + "). "
            "Re-run with force=true if you want to attempt an update against "
            "cached state."
        ))
        return 1

    # ----- run update.sh -----
    if not UPDATE_SH.exists():
        job.set_phase("error", error=f"update.sh not found at {UPDATE_SH}")
        return 1
    if not os.access(UPDATE_SH, os.X_OK):
        try:
            os.chmod(UPDATE_SH, 0o755)
        except OSError:
            pass

    job.set_phase("updating")
    try:
        rc = run_update(job)
    except (OSError, subprocess.SubprocessError) as e:
        job.set_phase("error", error=f"update.sh failed to launch: {e}")
        return 1

    # ----- finish up -----
    if rc != 0:
        # Last log line tends to be the most informative ("die ..." line
        # from update.sh). Surface it inline.
        last = ""
        if job._log_tail:
            last = job._log_tail[-1]
        job.set_phase(
            "error",
            error=f"update.sh exited {rc}. Last: {last[-300:]}",
            exit_code=rc,
        )
        return 1

    # update.sh succeeded. The systemctl restart / reboot it issued at
    # the very end is async, so this status write races with the docker
    # container being torn down. write_json_atomic gives us either the
    # old file or the new file -- never a half-written one -- so the
    # post-restart UI poll will see a consistent snapshot regardless.
    #
    # We write phase=done for all three restart_mode values; which
    # method was used is preserved in restart_mode so the UI can render
    # "Service restarted" vs "Pi rebooted" vs "Update staged" in the
    # success message. (Earlier versions wrote phase=rebooting for the
    # reboot case, which left the UI stuck on "Rebooting…" forever
    # once the Pi came back online.)
    job.set_phase("done", exit_code=rc)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply Backyard Hero system update")
    args = parser.parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return apply_request()


if __name__ == "__main__":
    sys.exit(main())
PY
  chmod 0755 "${UPDATE_APPLY_SCRIPT_PATH}"
}

write_update_apply_units() {
  local data_dir="${REPO_DIR}/host/data"
  mkdir -p "${data_dir}"

  cat >"/etc/systemd/system/${UPDATE_APPLY_SERVICE_NAME}" <<EOF
[Unit]
Description=Apply Backyard Hero system update requested by the UI
Documentation=https://github.com/Os4ivmb/backyardhero
After=network.target docker.service

[Service]
Type=oneshot
# Run update.sh from a clean cwd so anything that's relative to \$PWD
# (there shouldn't be any but it's cheap insurance) works the same way
# whether the unit fires on its own or from a manual systemctl start.
WorkingDirectory=${REPO_DIR}
ExecStart=${UPDATE_APPLY_SCRIPT_PATH}
Environment=BYH_DATA_DIR=${data_dir}
Environment=BYH_REPO_DIR=${REPO_DIR}
Environment=BYH_UPDATE_SH=${REPO_DIR}/host/run/pi/update.sh
# Don't retry on its own -- the .path unit will fire again the next
# time the UI writes a request file.
SuccessExitStatus=0

[Install]
WantedBy=multi-user.target
EOF

  cat >"/etc/systemd/system/${UPDATE_APPLY_PATH_NAME}" <<EOF
[Unit]
Description=Watch for Backyard Hero system update requests
After=local-fs.target

[Path]
PathChanged=${data_dir}/byh_update_request.json
Unit=${UPDATE_APPLY_SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

  chmod 0644 "/etc/systemd/system/${UPDATE_APPLY_SERVICE_NAME}"
  chmod 0644 "/etc/systemd/system/${UPDATE_APPLY_PATH_NAME}"
}

install_update_service() {
  log "installing system-update apply service (UI-driven update.sh runner)"
  write_update_apply_script
  write_update_apply_units
  systemctl daemon-reload
  systemctl enable  "${UPDATE_APPLY_PATH_NAME}"
  systemctl restart "${UPDATE_APPLY_PATH_NAME}" \
    || warn "couldn't start ${UPDATE_APPLY_PATH_NAME}"
}

# ---------------------------------------------------------------------------
# NAT: let AP clients reach the internet through the Pi's wired uplink.
# ---------------------------------------------------------------------------
#
# Without this, a phone joining the BackyardHero AP can talk to the
# Pi's web UI on 192.168.42.1 but has no path to anything else -- DNS,
# HTTPS, OS updates, satellite map tiles, etc. all fail.
#
# We do the smallest possible router setup:
#   1. Enable IPv4 forwarding (kernel sysctl).
#   2. MASQUERADE every packet that came from the AP subnet and is
#      leaving on anything other than wlan0. That handles eth0,
#      eth1, USB-tethered cell modems (usb0), ppp0, ... without
#      having to pick a single "upstream" name (Ubuntu's predictable
#      names like enp4s0 don't necessarily match what Pi OS calls
#      the same NIC).
#   3. Allow the matching FORWARD rules in both directions, with
#      conntrack on the return path so unsolicited inbound traffic
#      from upstream is *not* forwarded to AP clients.
#
# The Pi itself is unaffected: this code never touches eth0 or its
# DHCP, only the forwarding/NAT chain. If there's no uplink, the AP
# still works -- clients just won't get past the Pi, which is fine.

ap_network() {
  # Compute the AP subnet (e.g. 192.168.42.0/24) from --ap-ip / --ap-cidr.
  # python3 is always available because apt_install pulls it in for
  # the rest of the installer.
  python3 -c "import ipaddress,sys;
print(str(ipaddress.ip_network(sys.argv[1] + '/' + sys.argv[2], strict=False)))" \
    "${AP_IP}" "${AP_CIDR}"
}

write_nat_script() {
  cat >"${AP_NAT_SCRIPT_PATH}" <<'BASH'
#!/usr/bin/env bash
# byh-ap-nat.sh -- (re-)apply iptables NAT + forwarding rules that let
# Backyard Hero AP clients reach the internet through whatever uplink
# the Pi has (eth0 / usb0 / ...). Intended to be re-run at boot via
# byh-ap-nat.service and idempotently from the installer.
#
# Env knobs (defaults filled in by install_pi.sh in the systemd unit):
#   BYH_AP_NETWORK   e.g. 192.168.42.0/24
#   BYH_AP_IFACE     e.g. wlan0
#   BYH_AP_APP_PORT  e.g. 1776  (port 80 on the AP iface DNATs here)

set -euo pipefail

AP_NETWORK="${BYH_AP_NETWORK:-192.168.42.0/24}"
AP_IFACE="${BYH_AP_IFACE:-wlan0}"
AP_APP_PORT="${BYH_AP_APP_PORT:-1776}"

# Enable IPv4 forwarding at runtime as belt-and-suspenders for the
# sysctl drop-in. Cheap and idempotent.
echo 1 >/proc/sys/net/ipv4/ip_forward 2>/dev/null || true

# Helper: add a rule only if an identical one isn't already there.
# Using -C (check) keeps re-runs from stacking duplicates.
nat_add() {
  iptables -t nat -C "$@" 2>/dev/null || iptables -t nat -A "$@"
}
fwd_add() {
  iptables -C "$@" 2>/dev/null || iptables -A "$@"
}

# NAT: rewrite the AP subnet's source IP to whichever uplink we go out
# on. `! -o ${AP_IFACE}` means "any interface except the AP one", which
# covers eth0, eth1, usb0, ppp0, ... without us having to name them.
nat_add POSTROUTING ! -o "${AP_IFACE}" -s "${AP_NETWORK}" -j MASQUERADE

# Convenience: AP clients hitting http://<gateway>/ (port 80) get
# silently redirected to the Next.js port. Scoped to the AP interface
# only so we don't hijack port 80 on eth0 or any other uplink. REDIRECT
# (vs DNAT) keeps the destination as the local interface IP, which is
# exactly what we want here -- the app is listening on 0.0.0.0 via the
# docker-compose port publish.
nat_add PREROUTING -i "${AP_IFACE}" -p tcp --dport 80 \
        -j REDIRECT --to-ports "${AP_APP_PORT}"

# Forwarding: allow AP -> uplink; allow uplink -> AP only for sessions
# already opened by the AP side (conntrack ESTABLISHED,RELATED). This
# keeps the AP from being exposed to unsolicited inbound traffic from
# whatever's upstream of the Pi.
fwd_add FORWARD -i "${AP_IFACE}" -s "${AP_NETWORK}" -j ACCEPT
fwd_add FORWARD -o "${AP_IFACE}" -d "${AP_NETWORK}" \
        -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

echo "[byh-ap-nat] applied: NAT ${AP_NETWORK} via !${AP_IFACE}, :80 -> :${AP_APP_PORT}"
BASH
  chmod 0755 "${AP_NAT_SCRIPT_PATH}"
}

write_nat_sysctl() {
  cat >"${AP_NAT_SYSCTL_PATH}" <<'EOF'
# Backyard Hero AP NAT: clients on the AP subnet (wlan0) reach the
# internet via the Pi's other uplink (eth0/usb0/...). Forwarding is
# also re-applied at runtime by byh-ap-nat.service in case some other
# sysctl drop-in beats us in load order.
net.ipv4.ip_forward=1
EOF
  chmod 0644 "${AP_NAT_SYSCTL_PATH}"
  # Apply now so we don't need a reboot.
  sysctl --system >/dev/null 2>&1 || sysctl -p "${AP_NAT_SYSCTL_PATH}" >/dev/null 2>&1 || true
}

write_nat_service() {
  local ap_network
  ap_network="$(ap_network)"
  cat >"/etc/systemd/system/${AP_NAT_SERVICE_NAME}" <<EOF
[Unit]
Description=Backyard Hero AP NAT (route AP clients out via uplink)
# Anything that flushes iptables -- e.g. NetworkManager or a manually
# invoked iptables-restore -- runs at "network.target". Ordering after
# both means our rules end up last and stick.
After=network.target hostapd.service
Wants=hostapd.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=BYH_AP_NETWORK=${ap_network}
Environment=BYH_AP_IFACE=${AP_IFACE}
Environment=BYH_AP_APP_PORT=${AP_APP_PORT}
ExecStart=${AP_NAT_SCRIPT_PATH}

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "/etc/systemd/system/${AP_NAT_SERVICE_NAME}"
}

setup_nat() {
  [[ "${DO_NAT}" -eq 1 ]] || { log "skipping NAT setup (--no-nat)"; return; }
  log "configuring NAT so AP clients can reach the internet via the uplink"
  write_nat_sysctl
  write_nat_script
  write_nat_service
  systemctl daemon-reload
  systemctl enable "${AP_NAT_SERVICE_NAME}"
  # Run once now -- the service unit is `RemainAfterExit=yes` so a
  # subsequent `start` is a no-op if the script already succeeded.
  systemctl restart "${AP_NAT_SERVICE_NAME}" \
    || warn "NAT apply failed -- run 'journalctl -u ${AP_NAT_SERVICE_NAME}' to debug"
}

# ---------------------------------------------------------------------------
# Time sync: keep the wall clock close enough for the UI.
# ---------------------------------------------------------------------------
#
# A Raspberry Pi has no battery-backed RTC. By itself that's fine -- once
# the Pi has internet, systemd-timesyncd reaches an NTP server and steps
# the clock to "now" within seconds of boot. The problem is the offline
# / AP-only deployment: on those boxes the wall clock can be hours (or
# years) behind a freshly-charged phone the operator is using to view
# the UI. The web app stamps liveness checks (receiver `lmt`, websocket
# `fw_last_update`) with `time.time()` on the Pi, and the browser
# compares that to its own `Date.now()`. Disagreement of more than a
# few seconds makes everything in the UI look stale even though the
# system is healthy.
#
# We do two things:
#
#   1. Install + enable fake-hwclock. It snapshots the wall clock on
#      shutdown/timer and restores it at next boot, so an offline Pi
#      at least resumes near the time it stopped (instead of 1970 /
#      whatever the kernel default is on the build).
#
#   2. Make systemd-timesyncd step (not slew) and retry aggressively
#      whenever a network DOES appear, so an operator who briefly
#      hands the Pi internet (USB-tethered phone, plug in eth0 for a
#      minute) gets the clock corrected fast.
#
# The UI is ALSO defended in code via `_clockOffsetMs` in
# useStateAppStore -- this section is belt-and-suspenders so the
# offset stays small even before that helper kicks in.

setup_time_sync() {
  section "Configuring time sync (fake-hwclock + timesyncd)"

  # fake-hwclock saves the wall clock on shutdown/halt and on a
  # systemd-timer cadence, then restores it at next boot. Crucial on
  # an offline Pi -- without it the clock returns to whatever date the
  # image was built on after every power cycle.
  if command -v fake-hwclock >/dev/null 2>&1; then
    # Save *now* so the very next boot picks up a sane time even if
    # this install runs from a freshly-flashed image whose previous
    # /etc/fake-hwclock.data is older than the install date.
    fake-hwclock save 2>/dev/null || true
    systemctl enable fake-hwclock.service 2>/dev/null || true
  else
    warn "fake-hwclock not installed; offline reboots may drop the clock to epoch"
  fi

  # systemd-timesyncd is the default time daemon on Bookworm/Bullseye
  # and Ubuntu Server. We override two knobs:
  #   - FallbackNTP=<public pool>  so it can sync even when the local
  #     network has no NTP server of its own (every public Wi-Fi etc.).
  #   - PollIntervalMinSec=16      poll once every 16s right after a
  #     network appears so the first sync is fast. The daemon backs off
  #     on its own once syncs succeed; this is a floor on the *first*
  #     poll interval, not a permanent rate.
  # systemd-timesyncd ALWAYS steps the clock on the first successful
  # sync of a session regardless of offset, so we don't need to ask
  # for a step explicitly -- we just need it to GET a sync.
  if command -v timedatectl >/dev/null 2>&1; then
    mkdir -p /etc/systemd/timesyncd.conf.d
    cat >/etc/systemd/timesyncd.conf.d/00-byh.conf <<'EOF'
# Backyard Hero: aggressive offline-recovery settings.
# See host/run/pi/install.sh setup_time_sync for rationale.
[Time]
# Public NTP pools as fallback -- used when no DHCP-supplied NTP server
# is available (the common case for the AP-only Pi while disconnected).
FallbackNTP=time.cloudflare.com pool.ntp.org time.google.com time.nist.gov
# Poll fast on first sync so the clock corrects within ~30s of any
# transient internet appearance (operator briefly plugs eth0, USB
# tethers a phone, etc.). The daemon backs off naturally to 32 min
# after sustained syncs.
PollIntervalMinSec=16
PollIntervalMaxSec=2048
EOF
    chmod 0644 /etc/systemd/timesyncd.conf.d/00-byh.conf

    # Enable NTP. Also flip on the service explicitly in case some
    # other config disabled it.
    timedatectl set-ntp true 2>/dev/null || true
    systemctl enable --now systemd-timesyncd.service 2>/dev/null \
      || warn "couldn't enable systemd-timesyncd; install chrony manually if needed"
    systemctl restart systemd-timesyncd.service 2>/dev/null || true
  else
    warn "timedatectl not available; skipping systemd-timesyncd config"
  fi
}

# ---------------------------------------------------------------------------
# NTP guard during shows.
# ---------------------------------------------------------------------------
#
# Why this exists: the daemon's run_show() drives the firing schedule on
# `time.monotonic()` now, which is immune to wall-clock jumps. BUT it
# also msyncs the receivers using `time.time()` once, then sends
# `showstart=<epoch_ms>` to the receivers. If systemd-timesyncd steps
# the wall clock between msync and showstart, the receivers (synced to
# the old clock) and the absolute showstart timestamp (stamped on the
# new clock) disagree -- the receivers either fire too early or never.
#
# So: while a show is loaded or running, pause systemd-timesyncd; the
# moment the show ends (or the daemon stops), resume it. The daemon
# stamps /data/byh_show_state on every transition; a systemd .path
# unit watches that file and runs the small script below.
#
# This is defence-in-depth: even if the operator forgets to keep the
# Pi offline during a show, the guard prevents the failure mode.

write_timesync_guard_script() {
  cat >"${TIMESYNC_GUARD_SCRIPT_PATH}" <<'BASH'
#!/usr/bin/env bash
# byh-timesync-guard.sh -- pause/resume systemd-timesyncd based on the
# byh_show_state marker the daemon stamps under host/data.
#
# Fired by byh-timesync-guard.path on every write to that marker. Reads
# it (exactly one of "idle" / "loaded" / "running") and pokes
# systemctl accordingly. Idempotent: a no-op when the service is
# already in the desired state.

set -euo pipefail

MARKER="${BYH_SHOW_STATE_MARKER:-/opt/backyardhero/host/data/byh_show_state}"
SERVICE="systemd-timesyncd.service"

if [[ ! -r "${MARKER}" ]]; then
  # No marker yet -- daemon hasn't finished its first state flush. Leave
  # timesyncd alone; the .path unit will fire again as soon as the
  # daemon writes the file.
  exit 0
fi

state="$(head -c 64 "${MARKER}" | tr -d '[:space:]')"

case "${state}" in
  running|loaded)
    # Pause time sync while a show is loaded or in progress. We use
    # `stop` (not `mask`) so a fresh `systemctl start` from the resume
    # branch below picks it back up without further fanfare.
    if systemctl is-active --quiet "${SERVICE}"; then
      systemctl stop "${SERVICE}" \
        || logger -t byh-timesync-guard "failed to stop ${SERVICE} (state=${state})"
      logger -t byh-timesync-guard "paused ${SERVICE} (show state=${state})"
    fi
    ;;
  idle|"")
    if ! systemctl is-active --quiet "${SERVICE}"; then
      systemctl start "${SERVICE}" \
        || logger -t byh-timesync-guard "failed to start ${SERVICE} (state=${state})"
      logger -t byh-timesync-guard "resumed ${SERVICE} (show state=${state:-idle})"
    fi
    ;;
  *)
    # Unknown content -- err on the side of "let NTP run". This is
    # what we want if the marker gets corrupted; the worst that
    # happens is the wall clock might step during a show. With the
    # daemon's monotonic-clock firing loop, that's bounded damage.
    logger -t byh-timesync-guard "unknown show state '${state}'; leaving ${SERVICE} alone"
    ;;
esac
BASH
  chmod 0755 "${TIMESYNC_GUARD_SCRIPT_PATH}"
}

write_timesync_guard_units() {
  local marker_path="${REPO_DIR}/host/data/byh_show_state"

  cat >"/etc/systemd/system/${TIMESYNC_GUARD_SERVICE_NAME}" <<EOF
[Unit]
Description=Pause systemd-timesyncd while a Backyard Hero show is loaded/running
Documentation=https://github.com/Os4ivmb/backyardhero
# Only meaningful once systemd-timesyncd has been started at least
# once -- we don't want to race with its first activation.
After=systemd-timesyncd.service

[Service]
Type=oneshot
Environment=BYH_SHOW_STATE_MARKER=${marker_path}
ExecStart=${TIMESYNC_GUARD_SCRIPT_PATH}
SuccessExitStatus=0
EOF

  cat >"/etc/systemd/system/${TIMESYNC_GUARD_PATH_NAME}" <<EOF
[Unit]
Description=Watch the Backyard Hero show-state marker for NTP-pause transitions
After=local-fs.target

[Path]
# PathChanged fires on every write; the daemon only rewrites the
# marker on actual state transitions so this stays cheap. PathExists
# covers first-boot when the daemon hasn't started yet.
PathChanged=${marker_path}
Unit=${TIMESYNC_GUARD_SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

  chmod 0644 "/etc/systemd/system/${TIMESYNC_GUARD_SERVICE_NAME}"
  chmod 0644 "/etc/systemd/system/${TIMESYNC_GUARD_PATH_NAME}"
}

setup_timesync_guard() {
  section "Installing NTP-during-show guard"
  # Make sure the marker's parent dir exists before the .path unit
  # tries to watch it; systemd otherwise logs noisy "doesn't exist"
  # warnings until the daemon first writes the file.
  local data_dir="${REPO_DIR}/host/data"
  mkdir -p "${data_dir}"

  write_timesync_guard_script
  write_timesync_guard_units

  systemctl daemon-reload
  systemctl enable "${TIMESYNC_GUARD_PATH_NAME}"
  systemctl restart "${TIMESYNC_GUARD_PATH_NAME}" \
    || warn "couldn't start ${TIMESYNC_GUARD_PATH_NAME}"

  # Run the guard once now so we converge to the right timesyncd
  # state regardless of whether a marker file already exists from a
  # previous boot.
  systemctl start "${TIMESYNC_GUARD_SERVICE_NAME}" 2>/dev/null || true
}

setup_ap() {
  [[ "${DO_AP}" -eq 1 ]] || { log "skipping AP setup"; return; }
  section "Configuring WiFi access point on ${AP_IFACE}"

  if ! iface_exists "${AP_IFACE}"; then
    warn "interface ${AP_IFACE} not found; skipping AP setup."
    warn "(this is normal in VMs/containers without a wireless card.)"
    return
  fi

  if [[ "${#AP_PASSWORD}" -lt 8 ]]; then
    die "WPA2 passphrase must be at least 8 characters (got ${#AP_PASSWORD})"
  fi

  handoff_wlan_from_manager "${AP_IFACE}"
  write_iface_service "${AP_IFACE}"
  write_hostapd_conf
  write_dnsmasq_conf

  # hostapd ships masked on Debian-derived distros; unmask explicitly.
  systemctl unmask hostapd.service 2>/dev/null || true

  systemctl daemon-reload
  systemctl enable "${AP_IFACE_SERVICE_NAME}"
  systemctl enable hostapd.service
  systemctl enable dnsmasq.service

  # Make sure dnsmasq isn't also being driven by NetworkManager's bundled
  # dnsmasq (which binds 127.0.0.1 only and confuses the operator). We
  # disabled NM management of ${AP_IFACE} above, so the system dnsmasq is
  # free to bind ${AP_IFACE}.

  # Restart in the right order so the first run picks up our config.
  systemctl restart "${AP_IFACE_SERVICE_NAME}" || warn "iface service failed"
  systemctl restart hostapd.service           || warn "hostapd failed -- run 'journalctl -u hostapd' to debug"
  systemctl restart dnsmasq.service           || warn "dnsmasq failed -- run 'journalctl -u dnsmasq' to debug"

  # Set up the UI-driven re-config plumbing once the AP itself is live.
  install_ap_apply_service

  # Wire NAT so AP clients can reach the internet through the Pi's
  # wired uplink. This is independent of the AP's own operation -- if
  # disabled (--no-nat) or if there's no uplink, the AP still works,
  # clients just can't get past the Pi.
  setup_nat
}

# ---------------------------------------------------------------------------
# Uninstall path
# ---------------------------------------------------------------------------

uninstall() {
  section "Uninstalling Backyard Hero services"
  systemctl disable --now "${SERVICE_NAME}"            2>/dev/null || true
  systemctl disable --now "${AP_IFACE_SERVICE_NAME}"   2>/dev/null || true
  systemctl disable --now "${AP_APPLY_PATH_NAME}"      2>/dev/null || true
  systemctl disable --now "${AP_APPLY_SERVICE_NAME}"   2>/dev/null || true
  systemctl disable --now "${AP_NAT_SERVICE_NAME}"     2>/dev/null || true
  systemctl disable --now "${UPDATE_APPLY_PATH_NAME}"    2>/dev/null || true
  systemctl disable --now "${UPDATE_APPLY_SERVICE_NAME}" 2>/dev/null || true
  systemctl disable --now "${TIMESYNC_GUARD_PATH_NAME}"    2>/dev/null || true
  systemctl disable --now "${TIMESYNC_GUARD_SERVICE_NAME}" 2>/dev/null || true
  systemctl disable --now hostapd.service              2>/dev/null || true
  systemctl disable --now dnsmasq.service              2>/dev/null || true

  # Best-effort tear-down of the NAT/forwarding rules we added. If
  # the AP_IFACE / AP_IP defaults differ from what was used at install
  # time the iptables -D below just becomes a no-op via `|| true`,
  # which is fine -- a reboot will clear stale rules anyway.
  if [[ -x "${AP_NAT_SCRIPT_PATH}" ]]; then
    local _net
    _net="$(ap_network 2>/dev/null || echo "${AP_IP}/${AP_CIDR}")"
    iptables -t nat -D POSTROUTING ! -o "${AP_IFACE}" -s "${_net}" -j MASQUERADE 2>/dev/null || true
    iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p tcp --dport 80 \
      -j REDIRECT --to-ports "${AP_APP_PORT}" 2>/dev/null || true
    iptables -D FORWARD -i "${AP_IFACE}" -s "${_net}" -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -o "${AP_IFACE}" -d "${_net}" \
      -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
  fi

  rm -f "/etc/systemd/system/${SERVICE_NAME}"
  rm -f "/etc/systemd/system/${AP_IFACE_SERVICE_NAME}"
  rm -f "/etc/systemd/system/${AP_APPLY_SERVICE_NAME}"
  rm -f "/etc/systemd/system/${AP_APPLY_PATH_NAME}"
  rm -f "/etc/systemd/system/${AP_NAT_SERVICE_NAME}"
  rm -f "/etc/systemd/system/${UPDATE_APPLY_SERVICE_NAME}"
  rm -f "/etc/systemd/system/${UPDATE_APPLY_PATH_NAME}"
  rm -f "/etc/systemd/system/${TIMESYNC_GUARD_SERVICE_NAME}"
  rm -f "/etc/systemd/system/${TIMESYNC_GUARD_PATH_NAME}"
  rm -f "${AP_APPLY_SCRIPT_PATH}"
  rm -f "${UPDATE_APPLY_SCRIPT_PATH}"
  rm -f "${TIMESYNC_GUARD_SCRIPT_PATH}"
  rm -f "${AP_NAT_SCRIPT_PATH}"
  rm -f "${AP_NAT_SYSCTL_PATH}"
  rm -f "${UDEV_RULE_PATH}"
  rm -f "${HOSTAPD_CONF_PATH}"
  rm -f "${DNSMASQ_CONF_PATH}"
  rm -f /etc/NetworkManager/conf.d/99-byh-unmanaged.conf
  rm -f /etc/systemd/timesyncd.conf.d/00-byh.conf
  # Leave dhcpcd.conf alone -- removing the denyinterfaces line is
  # delicate and the operator can do it manually if they want wlan0 back.
  # Leave net.ipv4.ip_forward at whatever sysctl says now; reboot will
  # restore the system default once the sysctl drop-in is gone.

  # The NTP guard may have left systemd-timesyncd stopped if the
  # operator was mid-show when they uninstalled. Make sure it's back
  # up so the system's wall clock doesn't drift after teardown.
  systemctl start systemd-timesyncd.service 2>/dev/null || true

  systemctl daemon-reload
  udevadm control --reload-rules 2>/dev/null || true
  log "uninstall complete. The repo at ${REPO_DIR:-?} and the docker image"
  log "are left in place; remove them manually if desired."
}

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------

print_summary() {
  section "Done"
  cat <<EOF

Backyard Hero is installed.

  Repo dir:     ${REPO_DIR}
  Service:      ${SERVICE_NAME} $( [[ ${DO_SERVICE} -eq 1 ]] && echo '(enabled, will start on boot)' || echo '(NOT installed)')
  Dongle port:  $(detect_dongle_port || echo 'not detected (plug it in)') -> /dev/byh_dongle (stable)

EOF
  if [[ ${DO_AP} -eq 1 ]]; then
    cat <<EOF
WiFi access point:
  Interface:    ${AP_IFACE}
  SSID:         ${AP_SSID}
  Password:     ${AP_PASSWORD}
  Channel:      ${AP_CHANNEL} (2.4 GHz)
  Gateway IP:   ${AP_IP}/${AP_CIDR}
  DHCP range:   ${AP_DHCP_START} - ${AP_DHCP_END}

  Connect a phone/laptop to "${AP_SSID}" and open:
    http://backyardhero.local
  (or http://byh.local, http://${AP_IP}, or http://${AP_IP}:${AP_APP_PORT})

  The bare URL (no :${AP_APP_PORT}) works because byh-ap-nat redirects
  port 80 -> ${AP_APP_PORT} on ${AP_IFACE}. If you ran the installer
  with --no-nat, you'll need the explicit :${AP_APP_PORT} suffix.

  SSID and password can be changed at runtime from the web UI under
  Settings -> Network. The change applies a few seconds after you submit
  it, so you'll have time to read the reconnect instructions before the
  WiFi drops; if the new config doesn't bring hostapd back up, the
  installer's apply script rolls back to the previous values.

EOF
    if [[ ${DO_NAT} -eq 1 ]]; then
      cat <<EOF
Internet for AP clients:
  Whichever interface the Pi is using upstream (Ethernet, USB-tethered
  phone, second NIC...) is automatically NAT'd for AP clients. Plug the
  Pi into your router via Ethernet and any phone/laptop joined to
  "${AP_SSID}" will have full internet access via the Pi.

  The Pi's own Ethernet is left under whatever manager (NetworkManager
  / dhcpcd / netplan) already had it -- this installer never touches
  anything but wlan0.

EOF
    fi
  fi

  cat <<EOF
Useful commands:
  Start now:       sudo systemctl start ${SERVICE_NAME}
  Tail host logs:  journalctl -u ${SERVICE_NAME} -f
  Tail AP logs:    journalctl -u hostapd -u dnsmasq -f
  Re-apply NAT:    sudo systemctl restart ${AP_NAT_SERVICE_NAME}
  Show NAT rules:  sudo iptables -t nat -L POSTROUTING -n -v
  Restart stack:   sudo systemctl restart ${SERVICE_NAME}
  Stop stack:      sudo systemctl stop ${SERVICE_NAME}
  Update Pi:       sudo ${REPO_DIR}/host/run/pi/update.sh         (source + image + install + restart)
                   ...or just open Settings -> Network -> System update in the UI.
  Update image:    cd ${REPO_DIR}/host/run/pi && sudo docker compose pull && sudo systemctl restart ${SERVICE_NAME}
  Update dongle:   sudo ${REPO_DIR}/host/run/pi/update_dongle.sh -y
  Uninstall:       sudo $0 --uninstall

Reboot recommended so all group memberships and udev rules apply cleanly.

EOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"
  require_root "$@"

  if [[ "${DO_UNINSTALL}" -eq 1 ]]; then
    uninstall
    return 0
  fi

  detect_os
  detect_target_user
  log "configuration:"
  log "  user:      ${TARGET_USER:-<none>}"
  log "  repo url:  ${REPO_URL}"
  log "  repo dir:  ${REPO_DIR:-<auto>}"
  log "  branch:    ${BRANCH}"
  if [[ ${DO_AP} -eq 1 ]]; then
    log "  ap iface:  ${AP_IFACE}"
    log "  ap ssid:   ${AP_SSID}"
    log "  ap pass:   ${AP_PASSWORD}"
    log "  ap subnet: ${AP_IP}/${AP_CIDR} (channel ${AP_CHANNEL}, country ${AP_COUNTRY})"
    log "  ap nat:    $( [[ ${DO_NAT} -eq 1 ]] && echo 'enabled (AP clients reach internet via uplink)' || echo 'disabled' )"
  else
    log "  ap:        disabled"
  fi

  confirm "Proceed with these settings?" || die "aborted by user"

  apt_install
  add_user_to_groups
  locate_repo
  install_udev_rule
  update_systemcfg
  install_bridge_venv
  prepull_image
  install_host_service
  install_update_service
  setup_time_sync
  setup_timesync_guard
  setup_ap

  print_summary
}

main "$@"
