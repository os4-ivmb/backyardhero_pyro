#!/usr/bin/env bash
# start-dev.sh -- dev launcher for Raspberry Pi.
#
# Same shape as start.sh but uses docker-compose-dev.yml (build locally
# + bind-mount source) so rsync'd code changes hot-reload via Next.js
# HMR for the frontend / API routes, and via supervisorctl restart for
# the Python daemon.
#
# Before running this, stop the prod systemd unit so it isn't holding
# the ports or the dongle:
#
#     sudo systemctl stop byh-host
#
# Then bring this up here in the foreground. Ctrl-C tears it down.
# When you're done iterating, sudo systemctl start byh-host puts the
# prod stack back.

set -e

VERSION="0.08PI-DEV"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${HOST_DIR}"

BRIDGE_DIR="tcp_serial_bridge"
BRIDGE_SCRIPT="${BRIDGE_DIR}/tcp_serial_bridge.py"
BRIDGE_VENV="${BRIDGE_DIR}/venv"
REQUIREMENTS="${BRIDGE_DIR}/requirements.txt"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose-dev.yml"

echo "BACKYARD HERO HOST (pi/dev) --- VERSION: ${VERSION}"
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

# `docker compose up --build` will rebuild any changed layers. First
# run on a Pi is ~10-15 min (npm ci dominates); subsequent runs are
# ~30s because of layer caching.
echo "Starting Backyard Hero docker stack (will rebuild if needed)..."
docker compose -f "${COMPOSE_FILE}" up --build &
DOCKER_PID=$!

sleep 5
if ! ps -p "${DOCKER_PID}" >/dev/null 2>&1; then
  echo "ERROR: docker compose up exited prematurely."
  exit 1
fi

echo ""
echo "------------------------------------------------------------"
echo "  Backyard Hero (dev) is running."
echo "  Open: http://backyardhero/  or  http://localhost:1776"
echo ""
echo "  Source-change refresh:"
echo "    Frontend / API routes -> Next.js HMR (automatic)"
echo "    Python daemon         -> docker exec firework-system \\"
echo "                                supervisorctl restart firework-daemon"
echo "    WebSocket server      -> docker exec firework-system \\"
echo "                                supervisorctl restart websock"
echo "------------------------------------------------------------"

wait "${BRIDGE_PID}" "${DOCKER_PID}"
