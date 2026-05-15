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

# Bridge venv (one-time). Use absolute paths to the venv's pip/python
# so dash's lack of `source` doesn't matter and pip can't accidentally
# fall through to the PEP 668-protected system pip.
if [ ! -d "${BRIDGE_VENV}" ]; then
  echo "Creating bridge venv at ${BRIDGE_VENV}..."
  python3 -m venv "${BRIDGE_VENV}"
fi
"${BRIDGE_VENV}/bin/pip" install -q -r "${REQUIREMENTS}"

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
