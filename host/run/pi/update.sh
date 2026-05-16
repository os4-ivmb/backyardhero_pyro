#!/usr/bin/env bash
# update.sh -- bring a Pi up to the latest Backyard Hero from the
# upstream repo + Docker Hub.
#
# By default does all of the following, in order:
#   1. git pull --ff-only         (host-side source: install.sh, start.sh,
#                                  AP scripts, configs, dev source)
#   2. docker compose pull        (latest prebuilt app image -- this is
#                                  where the running app code actually
#                                  lives in prod mode)
#   3. install.sh -y              (re-apply system-level state: systemd
#                                  unit, udev rule, hostapd/dnsmasq, NAT.
#                                  Idempotent.)
#   4. systemctl restart byh-host (swap to the new image)
#
# Flags (use to skip parts you know you don't need):
#   --no-source        Skip step 1 (use what's already on disk)
#   --no-image         Skip step 2 (don't pull a new Docker image)
#   --no-install       Skip step 3 (assume nothing system-level changed)
#   --no-restart       Skip step 4 (leave new image queued for next boot)
#   --reboot           Replace step 4 with a full `reboot` of the Pi.
#                      Use when systemd units / udev rules / sysctls
#                      changed and a clean reboot is the surest way to
#                      pick them up. Mutually exclusive with --no-restart.
#   --branch BRANCH    Switch to BRANCH before pulling (default: current)
#   -y, --yes          Non-interactive: no confirmation prompt
#   -h, --help         Show this
#
# Examples:
#   sudo ./update.sh                  # full update, prompted
#   sudo ./update.sh -y               # full update, no prompts
#   sudo ./update.sh --no-image       # source-only (host scripts changed, image is fine)
#   sudo ./update.sh --no-source      # image-only (just want a new app)
#   sudo ./update.sh --no-install --no-source   # fastest "pull new app & restart"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# host/run/pi/update.sh -> host/run -> host -> <repo root>
REPO_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
INSTALL_SCRIPT="${SCRIPT_DIR}/install.sh"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

SERVICE_NAME="byh-host.service"

DO_SOURCE=1
DO_IMAGE=1
DO_INSTALL=1
DO_RESTART=1
DO_REBOOT=0
ASSUME_YES=0
BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-source)  DO_SOURCE=0;  shift ;;
    --no-image)   DO_IMAGE=0;   shift ;;
    --no-install) DO_INSTALL=0; shift ;;
    --no-restart) DO_RESTART=0; shift ;;
    --reboot)     DO_REBOOT=1;  shift ;;
    --branch)     BRANCH="$2";  shift 2 ;;
    -y|--yes)     ASSUME_YES=1; shift ;;
    -h|--help)    sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "[update] unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ "${DO_REBOOT}" -eq 1 && "${DO_RESTART}" -eq 0 ]]; then
  echo "[update] --reboot and --no-restart are mutually exclusive" >&2
  exit 1
fi

log()     { printf "\033[1;36m[update]\033[0m %s\n" "$*"; }
warn()    { printf "\033[1;33m[update] WARN:\033[0m %s\n" "$*" >&2; }
err()     { printf "\033[1;31m[update] ERROR:\033[0m %s\n" "$*" >&2; }
die()     { err "$*"; exit 1; }
section() { printf "\n\033[1;35m==[ %s ]==\033[0m\n" "$*"; }
git_repo() { git -c safe.directory="${REPO_DIR}" "$@"; }

ensure_git_safe_directory() {
  # UI-triggered updates run from a root systemd oneshot against a checkout
  # owned by the install target user. Persist the trust entry for that account
  # before Git has a chance to reject the repo as "dubious ownership".
  if git config --global --get-all safe.directory 2>/dev/null | grep -Fxq "${REPO_DIR}"; then
    return
  fi
  git config --global --add safe.directory "${REPO_DIR}" 2>/dev/null \
    || warn "couldn't add Git safe.directory for ${REPO_DIR}; continuing with per-command override"
}

[[ -f "${INSTALL_SCRIPT}" ]] || die "install.sh not found at ${INSTALL_SCRIPT}"
[[ -f "${COMPOSE_FILE}"   ]] || die "compose file not found at ${COMPOSE_FILE}"

# Selective sudo for the steps that need it. git pull + docker compose
# pull run as the invoking user (the repo is now owned by TARGET_USER
# after install.sh; docker group membership lets non-root run docker).
SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    warn "no sudo available; install.sh re-run and systemctl restart may fail"
  fi
fi

# Confirmation prompt before we start.
if [[ "${ASSUME_YES}" -ne 1 ]]; then
  echo ""
  log "About to update Backyard Hero on this Pi:"
  [[ "${DO_SOURCE}"  -eq 1 ]] && log "  - git pull in ${REPO_DIR}${BRANCH:+ (branch ${BRANCH})}"
  [[ "${DO_IMAGE}"   -eq 1 ]] && log "  - docker compose pull (latest os4ivmb/backyardhero image)"
  [[ "${DO_INSTALL}" -eq 1 ]] && log "  - re-run install.sh -y (re-apply system state, idempotent)"
  if [[ "${DO_REBOOT}" -eq 1 ]]; then
    log "  - reboot (full Pi reboot)"
  elif [[ "${DO_RESTART}" -eq 1 ]]; then
    log "  - systemctl restart ${SERVICE_NAME}"
  fi
  if [[ "${DO_SOURCE}" -eq 0 && "${DO_IMAGE}" -eq 0 && "${DO_INSTALL}" -eq 0 \
        && "${DO_RESTART}" -eq 0 && "${DO_REBOOT}" -eq 0 ]]; then
    die "all steps disabled; nothing to do"
  fi
  read -r -p "Continue? [Y/n] " ans
  case "${ans}" in
    ""|y|Y|yes|YES) : ;;
    *) die "aborted by user" ;;
  esac
fi

# ---------------------------------------------------------------------------
# Step 1: source
# ---------------------------------------------------------------------------

if [[ "${DO_SOURCE}" -eq 1 ]]; then
  section "Pulling latest source"
  cd "${REPO_DIR}"
  ensure_git_safe_directory

  if [[ -n "${BRANCH}" ]]; then
    log "switching to branch ${BRANCH}"
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
      git_repo fetch --depth 1 origin "${BRANCH}" || die "git fetch failed"
    git_repo checkout "${BRANCH}" || die "git checkout ${BRANCH} failed"
  fi

  if [[ -n "$(git_repo status --porcelain)" ]]; then
    warn "working tree has local changes; git pull --ff-only may fail."
    warn "If it does, either commit/stash them or rsync them onto the Pi"
    warn "AFTER this update finishes."
  fi

  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
    git_repo pull --ff-only || die "git pull failed (resolve and retry, or pass --no-source)"
fi

# ---------------------------------------------------------------------------
# Step 2: docker image
# ---------------------------------------------------------------------------

if [[ "${DO_IMAGE}" -eq 1 ]]; then
  section "Pulling latest Docker image"
  cd "${SCRIPT_DIR}"
  if ! docker compose -f "${COMPOSE_FILE}" pull; then
    warn "docker compose pull failed (offline?); keeping cached image"
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: re-apply system state
# ---------------------------------------------------------------------------

if [[ "${DO_INSTALL}" -eq 1 ]]; then
  section "Re-running install.sh (idempotent re-apply)"
  # install.sh self-elevates with sudo if needed; passing -y to suppress its
  # confirmation prompt (we already prompted at the top of this script).
  ${SUDO} "${INSTALL_SCRIPT}" -y || die "install.sh failed (see output above)"
fi

# ---------------------------------------------------------------------------
# Step 4: restart the service (or reboot the whole Pi)
# ---------------------------------------------------------------------------
#
# We always print the section header for the chosen path before doing
# anything, so a UI driver parsing stdout (host/run/pi/byh-update.py)
# can flip its phase to "restarting" / "rebooting" before the next
# command actually severs its log stream.

if [[ "${DO_REBOOT}" -eq 1 ]]; then
  section "Rebooting Pi"
  log "issuing 'reboot' -- this stream will end momentarily."
  # Small grace so the apply script and any UI poll have a chance to
  # observe the section header before init kills our pipe.
  sleep 1
  ${SUDO} systemctl reboot \
    || ${SUDO} reboot \
    || warn "reboot command failed; check 'systemctl status' on the Pi"
elif [[ "${DO_RESTART}" -eq 1 ]]; then
  section "Restarting ${SERVICE_NAME}"
  if ! ${SUDO} systemctl list-unit-files --no-legend "${SERVICE_NAME}" \
       | grep -q "${SERVICE_NAME}"; then
    warn "${SERVICE_NAME} not installed; skipping restart"
  elif ${SUDO} systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null \
       || ${SUDO} systemctl is-active  --quiet "${SERVICE_NAME}" 2>/dev/null; then
    ${SUDO} systemctl restart "${SERVICE_NAME}" \
      || warn "couldn't restart ${SERVICE_NAME}; check 'journalctl -u ${SERVICE_NAME}'"
  else
    log "${SERVICE_NAME} not enabled or active; new image will be used on next start"
  fi
fi

section "Done"
log "Tail logs with:  journalctl -u ${SERVICE_NAME} -f"
log "UI:              http://backyardhero/  or  http://localhost:1776"
