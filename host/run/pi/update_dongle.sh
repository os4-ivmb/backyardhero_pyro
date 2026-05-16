#!/usr/bin/env bash
# update_dongle.sh -- one-button "update my dongle from the Pi" workflow.
#
# Run this on the Pi when you want to push the latest dongle firmware
# from the upstream repo onto the physical dongle that's currently
# plugged into the Pi.
#
# What it does:
#   1. Stop byh-host.service so it releases the dongle's USB-CDC port
#      (the running daemon holds /dev/byh_dongle open).
#   2. `git pull` in the repo so we're building the latest sketch.
#   3. devices/utils/build_dongle.sh -- compile, drop versioned
#      artifacts into devices/os4_dongle/bin/.
#   4. devices/utils/flash_dongle.py -- flash the freshly-built app
#      (and boot_app0 pointer) to the dongle. Auto-picks
#      /dev/byh_dongle thanks to the install_pi.sh udev rule.
#   5. Restart byh-host.service so the daemon reconnects to the
#      newly-flashed dongle.
#
# Flags:
#   --no-pull          Skip the git pull (use whatever's checked out now).
#   --no-service       Don't stop/start byh-host (use if you've already
#                      stopped it, or aren't running it as a service).
#   --full             First-time / recovery flash (bootloader +
#                      partitions + boot_app0 + app). Use for a brand-
#                      new dongle. Routine updates don't need this.
#   --port PATH        Force a specific serial port (otherwise we use
#                      /dev/byh_dongle when present, or auto-detect).
#   --branch BRANCH    git pull this branch instead of the current one.
#   -y, --yes          Non-interactive: never prompt for port/branch.
#   -h, --help         Show this.
#
# Exit codes:
#   0   success
#   1   anything else (logs explain)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# host/run/pi/update_dongle.sh -> host/run -> host -> <repo root>
REPO_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BUILD_SCRIPT="${REPO_DIR}/devices/utils/build_dongle.sh"
FLASH_SCRIPT="${REPO_DIR}/devices/utils/flash_dongle.py"

SERVICE_NAME="byh-host.service"

DO_PULL=1
DO_SERVICE=1
DO_FULL=0
ASSUME_YES=0
PORT=""
BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pull)    DO_PULL=0; shift ;;
    --no-service) DO_SERVICE=0; shift ;;
    --full)       DO_FULL=1; shift ;;
    --port)       PORT="$2"; shift 2 ;;
    --branch)     BRANCH="$2"; shift 2 ;;
    -y|--yes)     ASSUME_YES=1; shift ;;
    -h|--help)    sed -n '2,40p' "$0"; exit 0 ;;
    *)            echo "[update_dongle] unknown arg: $1" >&2; exit 1 ;;
  esac
done

log()  { printf "\033[1;36m[update_dongle]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[update_dongle] WARN:\033[0m %s\n" "$*" >&2; }
err()  { printf "\033[1;31m[update_dongle] ERROR:\033[0m %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }
git_repo() { git -c safe.directory="${REPO_DIR}" "$@"; }

ensure_git_safe_directory() {
  if git config --global --get-all safe.directory 2>/dev/null | grep -Fxq "${REPO_DIR}"; then
    return
  fi
  git config --global --add safe.directory "${REPO_DIR}" 2>/dev/null \
    || warn "couldn't add Git safe.directory for ${REPO_DIR}; continuing with per-command override"
}

section() { printf "\n\033[1;35m==[ %s ]==\033[0m\n" "$*"; }

[[ -x "${BUILD_SCRIPT}" ]] || die "build script not found / not executable: ${BUILD_SCRIPT}"
[[ -x "${FLASH_SCRIPT}" ]] || die "flash script not found / not executable: ${FLASH_SCRIPT}"

# We need root for the service stop/start. The build + flash steps work
# fine as the invoking user as long as they're in the dialout group
# (which install_pi.sh sets up automatically).
SUDO=""
if [[ "${DO_SERVICE}" -eq 1 ]] && [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    warn "no sudo available; will skip service stop/start. Stop byh-host"
    warn "manually before running this if it's currently driving the dongle."
    DO_SERVICE=0
  fi
fi

# Confirmation prompt before we start ripping things up.
if [[ "${ASSUME_YES}" -ne 1 ]]; then
  echo ""
  log "About to:"
  if [[ "${DO_SERVICE}" -eq 1 ]]; then
    log "  - stop ${SERVICE_NAME}"
  fi
  if [[ "${DO_PULL}" -eq 1 ]]; then
    log "  - git pull in ${REPO_DIR}${BRANCH:+ (branch ${BRANCH})}"
  fi
  log "  - build dongle firmware (devices/utils/build_dongle.sh)"
  if [[ "${DO_FULL}" -eq 1 ]]; then
    log "  - FULL flash to dongle (bootloader + partitions + app)"
  else
    log "  - app-only flash to dongle"
  fi
  if [[ "${DO_SERVICE}" -eq 1 ]]; then
    log "  - restart ${SERVICE_NAME}"
  fi
  read -r -p "Continue? [Y/n] " ans
  case "${ans}" in
    ""|y|Y|yes|YES) : ;;
    *) die "aborted by user" ;;
  esac
fi

# ---------------------------------------------------------------------------
# Step 1: free the dongle
# ---------------------------------------------------------------------------

WAS_RUNNING=0
if [[ "${DO_SERVICE}" -eq 1 ]]; then
  section "Stopping ${SERVICE_NAME} so the dongle's serial port is free"
  # is-active returns "active" / "inactive" / "failed" -- we only care
  # whether we need to restart it at the end.
  if ${SUDO} systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    WAS_RUNNING=1
  fi
  ${SUDO} systemctl stop "${SERVICE_NAME}" 2>/dev/null || warn "couldn't stop ${SERVICE_NAME} (continuing anyway)"
  # Give the host-side TCP-serial bridge time to actually close the fd
  # so esptool doesn't trip over a 'Device or resource busy'.
  sleep 1
fi

# ---------------------------------------------------------------------------
# Step 2: pull
# ---------------------------------------------------------------------------

if [[ "${DO_PULL}" -eq 1 ]]; then
  section "Pulling latest from git"
  cd "${REPO_DIR}"
  ensure_git_safe_directory
  if [[ -n "${BRANCH}" ]]; then
    git_repo fetch --depth 1 origin "${BRANCH}" || die "git fetch failed"
    git_repo checkout "${BRANCH}" || die "git checkout ${BRANCH} failed"
  fi
  # Tolerate dirty working tree but warn about it -- the most common
  # cause is the operator hand-editing the dongle .ino, which we should
  # NOT silently revert. `pull --ff-only` will refuse a merge.
  if [[ -n "$(git_repo status --porcelain)" ]]; then
    warn "working tree has local changes; git pull --ff-only may fail."
  fi
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
    git_repo pull --ff-only || die "git pull failed (use --no-pull to skip)"
fi

# ---------------------------------------------------------------------------
# Step 3: build
# ---------------------------------------------------------------------------

section "Building dongle firmware"
"${BUILD_SCRIPT}"

# ---------------------------------------------------------------------------
# Step 4: flash
# ---------------------------------------------------------------------------

section "Flashing dongle"
FLASH_ARGS=()
[[ "${DO_FULL}" -eq 1 ]] && FLASH_ARGS+=(--full)
[[ -n "${PORT}" ]]       && FLASH_ARGS+=(--port "${PORT}")
[[ "${ASSUME_YES}" -eq 1 ]] && FLASH_ARGS+=(--yes)

# flash_dongle.py self-bootstraps its own venv, so we just invoke it.
"${FLASH_SCRIPT}" "${FLASH_ARGS[@]}"

# ---------------------------------------------------------------------------
# Step 5: bring the host back up
# ---------------------------------------------------------------------------

if [[ "${DO_SERVICE}" -eq 1 ]]; then
  section "Restarting ${SERVICE_NAME}"
  if [[ "${WAS_RUNNING}" -eq 1 ]]; then
    ${SUDO} systemctl start "${SERVICE_NAME}" \
      || warn "couldn't start ${SERVICE_NAME}; check 'journalctl -u ${SERVICE_NAME}'"
  else
    log "${SERVICE_NAME} wasn't running before -- leaving stopped."
    log "Start it with: sudo systemctl start ${SERVICE_NAME}"
  fi
fi

section "Done"
log "Dongle updated. Tail logs with:  journalctl -u ${SERVICE_NAME} -f"
