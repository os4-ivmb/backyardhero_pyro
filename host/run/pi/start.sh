#!/usr/bin/env bash
# start.sh -- production launcher for Raspberry Pi.
#
# Invoked by byh-host.service. Boots:
#   1. The TCP-to-serial bridge (host-native Python; talks to the dongle).
#   2. The Backyard Hero docker stack (web app, websocket, daemon)
#      using the Pi-flavored docker-compose.yml in this directory.
#
# Pi-specific behavior:
#   * Tolerates `docker compose pull` failure -- a stand-alone Pi AP may
#     have no upstream connectivity at boot. The pull_policy: missing
#     setting in docker-compose.yml means the cached image is used.
#   * Assumes `docker compose` plugin (what apt install docker.io ships
#     these days). No legacy `docker-compose` fallback.

set -e

VERSION="0.08PI-PROD"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${HOST_DIR}"

BRIDGE_DIR="tcp_serial_bridge"
BRIDGE_SCRIPT="${BRIDGE_DIR}/tcp_serial_bridge.py"
BRIDGE_VENV="${BRIDGE_DIR}/venv"
REQUIREMENTS="${BRIDGE_DIR}/requirements.txt"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

echo "BACKYARD HERO HOST (pi/prod) --- VERSION: ${VERSION}"
echo "Host dir: ${HOST_DIR}"
echo "Compose:  ${COMPOSE_FILE}"

# Post-update reconciliation: if a previous run of byh-update.py left
# the status file stuck on phase=restarting / phase=rebooting (because
# the apply script got killed by the very restart it ordered before it
# could write phase=done), flip it to "done" now that we're back up.
# Without this the UI would render "Rebooting…" forever after a
# successful reboot-style update. The check is deliberately narrow:
# only flips successful exit_code=0 jobs, never an in-flight one.
UPDATE_STATUS_FILE="${HOST_DIR}/data/byh_update_status.json"
if [ -f "${UPDATE_STATUS_FILE}" ]; then
  python3 - "${UPDATE_STATUS_FILE}" <<'PY' || true
import json, os, sys, time
path = sys.argv[1]
try:
    with open(path) as f:
        s = json.load(f)
except Exception:
    sys.exit(0)
if not isinstance(s, dict):
    sys.exit(0)
if s.get("phase") in ("restarting", "rebooting") and s.get("exit_code", -1) == 0:
    s["phase"] = "done"
    s["ended_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    s["updated_at"] = s["ended_at"]
    s.setdefault("log_tail", []).append(
        "[start.sh] post-boot: byh-host is up; marking update as done."
    )
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    print(f"[start.sh] post-update reconciliation: {path} -> phase=done")
PY
fi

command -v docker  >/dev/null 2>&1 || { echo "ERROR: docker not installed.";  exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not installed."; exit 1; }

cleanup() {
  echo "Shutting down services..."
  if [ -n "${BRIDGE_PID:-}" ] && ps -p "${BRIDGE_PID}" >/dev/null 2>&1; then
    echo "Stopping TCP-to-serial bridge (PID: ${BRIDGE_PID})"
    kill "${BRIDGE_PID}" 2>/dev/null || true
  fi
  echo "Stopping docker stack..."
  docker compose -f "${COMPOSE_FILE}" down || true
  echo "Cleanup complete."
}
trap cleanup INT TERM EXIT

bridge_deps_ready() {
  [ -x "${BRIDGE_VENV}/bin/python" ] || return 1
  "${BRIDGE_VENV}/bin/python" <<'PY' >/dev/null 2>&1
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

ensure_bridge_venv() {
  # Normal boot must work without internet. install.sh pre-populates this
  # venv; only hit pip when the venv is missing or stale.
  if [ ! -x "${BRIDGE_VENV}/bin/python" ]; then
    echo "Creating bridge venv at ${BRIDGE_VENV}..."
    python3 -m venv "${BRIDGE_VENV}"
  fi

  if bridge_deps_ready; then
    echo "Bridge Python dependencies ready (offline-safe)."
    return 0
  fi

  echo "Bridge Python dependencies missing/stale; installing from ${REQUIREMENTS}..."
  if ! "${BRIDGE_VENV}/bin/pip" install -q -r "${REQUIREMENTS}"; then
    echo "ERROR: Bridge dependencies are missing and pip install failed."
    echo "       If this Pi is offline, reconnect temporarily or rerun install.sh"
    echo "       while online so ${BRIDGE_VENV} can be populated."
    exit 1
  fi

  if ! bridge_deps_ready; then
    echo "ERROR: Bridge dependencies still not usable after pip install."
    exit 1
  fi
}

ensure_bridge_venv

# Bind the host-native bridge (TCP :9000) and flash server (HTTP :9001)
# to the docker bridge gateway only, NOT 0.0.0.0 (C4.1). The container
# reaches the host via host.docker.internal -> host-gateway, which is the
# docker bridge gateway IP (typically 172.17.0.1). Binding there keeps
# the serial-injection + flash ports reachable from the container while
# unreachable from wlan0 AP clients. Falls back to 172.17.0.1 if docker
# can't be queried (offline boot races), and can be overridden by
# pre-setting BYH_BRIDGE_BIND in the environment.
if [ -z "${BYH_BRIDGE_BIND:-}" ]; then
  BYH_BRIDGE_BIND="$(docker network inspect bridge \
    -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
  if [ -z "${BYH_BRIDGE_BIND}" ]; then
    BYH_BRIDGE_BIND="172.17.0.1"
    echo "WARN: could not query docker bridge gateway; defaulting bind to ${BYH_BRIDGE_BIND}"
  fi
fi
export BYH_BRIDGE_BIND
echo "Bridge/flash-server bind address: ${BYH_BRIDGE_BIND}"

echo "Starting TCP-to-serial bridge..."
"${BRIDGE_VENV}/bin/python" "${BRIDGE_SCRIPT}" &
BRIDGE_PID=$!
sleep 2
if ! ps -p "${BRIDGE_PID}" >/dev/null 2>&1; then
  echo "ERROR: Bridge failed to start."
  exit 1
fi
echo "Bridge running (PID: ${BRIDGE_PID})"

echo "Pulling latest Backyard Hero image..."
docker compose -f "${COMPOSE_FILE}" pull \
  || echo "Pull failed (offline?); will use cached image."
echo "Starting Backyard Hero docker stack..."
docker compose -f "${COMPOSE_FILE}" up &
DOCKER_PID=$!

sleep 5
if ! ps -p "${DOCKER_PID}" >/dev/null 2>&1; then
  echo "ERROR: docker compose up exited prematurely."
  exit 1
fi

echo ""
echo "------------------------------------------------------------"
echo "  Backyard Hero is running."
echo "  Open: http://backyardhero/  or  http://localhost:1776"
echo "  Press Ctrl-C in this window to stop everything."
echo "------------------------------------------------------------"

wait "${BRIDGE_PID}" "${DOCKER_PID}"
