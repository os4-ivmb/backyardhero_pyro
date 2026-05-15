#!/usr/bin/env bash
# start.sh -- production launcher for macOS (Docker Desktop).
#
# Pulls the prebuilt Backyard Hero image from Docker Hub
# (os4ivmb/backyardhero) and starts:
#   1. The TCP-to-serial bridge (host-native Python; talks to the dongle
#      at /dev/tty.usbmodem*).
#   2. The Backyard Hero docker stack via docker-compose.yml in this dir.
#
# To pin an image tag:
#   BYH_IMAGE=os4ivmb/backyardhero:v0.08 ./start.sh
#
# Ctrl-C cleanly stops both.

set -e

VERSION="0.08OSX-PROD"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${HOST_DIR}"

BRIDGE_DIR="tcp_serial_bridge"
BRIDGE_SCRIPT="${BRIDGE_DIR}/tcp_serial_bridge.py"
BRIDGE_VENV="${BRIDGE_DIR}/venv"
REQUIREMENTS="${BRIDGE_DIR}/requirements.txt"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

echo "BACKYARD HERO HOST (osx/prod) --- VERSION: ${VERSION}"
echo "Host dir: ${HOST_DIR}"

command -v docker  >/dev/null 2>&1 || { echo "ERROR: docker not installed. See https://docs.docker.com/desktop/"; exit 1; }
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

echo "Pulling latest Backyard Hero image..."
docker compose -f "${COMPOSE_FILE}" pull
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
echo "  Open: http://localhost:1776"
echo "  Press Ctrl-C in this window to stop everything."
echo "------------------------------------------------------------"

wait "${BRIDGE_PID}" "${DOCKER_PID}"
