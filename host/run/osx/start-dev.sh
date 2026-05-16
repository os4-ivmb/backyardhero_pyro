#!/usr/bin/env bash
# start-dev.sh -- dev launcher for macOS (Docker Desktop).
#
# Builds the Backyard Hero image from source and bind-mounts the source
# tree so edits hot-reload:
#   * Frontend / API routes -> Next.js HMR (automatic, ~1s)
#   * Python daemon         -> docker exec firework-system supervisorctl restart firework-daemon
#   * WebSocket server      -> docker exec firework-system supervisorctl restart websock
#
# First run on a clean mac takes a few minutes (npm ci). Subsequent
# runs are ~10s because Docker caches.

set -e

VERSION="0.08OSX-DEV"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${HOST_DIR}"

BRIDGE_DIR="tcp_serial_bridge"
BRIDGE_SCRIPT="${BRIDGE_DIR}/tcp_serial_bridge.py"
BRIDGE_VENV="${BRIDGE_DIR}/venv"
REQUIREMENTS="${BRIDGE_DIR}/requirements.txt"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose-dev.yml"

echo "BACKYARD HERO HOST (osx/dev) --- VERSION: ${VERSION}"
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

echo "Starting Backyard Hero docker stack (will rebuild if needed)..."
docker compose -f "${COMPOSE_FILE}" up --build &
DOCKER_PID=$!

sleep 5
if ! ps -p "${DOCKER_PID}" >/dev/null 2>&1; then
  echo "ERROR: docker compose up exited prematurely."
  exit 1
fi

# LAN URL detection. Docker Desktop already exposes mapped ports
# (1776, 8090) on all host interfaces by default, and both the
# Next.js dev server and the websocket are bound to 0.0.0.0 inside
# the container -- so a phone or laptop on the same LAN can reach
# this stack as soon as we know the Mac's address.
#
# We pick the IP attached to the default-route interface first
# (almost always the right one), and fall back to the first en*
# interface that has an address. Both `route` and `ipconfig` ship
# with macOS so there's nothing to install.
detect_lan_ips() {
  local primary_iface ip ifaces=()
  primary_iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
  if [ -n "${primary_iface}" ]; then
    ifaces+=("${primary_iface}")
  fi
  while IFS= read -r line; do
    ifaces+=("${line}")
  done < <(ifconfig -l 2>/dev/null | tr ' ' '\n' | grep -E '^en[0-9]+$' || true)

  local seen=""
  for iface in "${ifaces[@]}"; do
    case " ${seen} " in *" ${iface} "*) continue ;; esac
    seen="${seen} ${iface}"
    ip="$(ipconfig getifaddr "${iface}" 2>/dev/null || true)"
    if [ -n "${ip}" ]; then
      echo "${ip} ${iface}"
    fi
  done
}

echo ""
echo "------------------------------------------------------------"
echo "  Backyard Hero (dev) is running."
echo "  Open: http://localhost:1776"

LAN_IP_LINES="$(detect_lan_ips || true)"
if [ -n "${LAN_IP_LINES}" ]; then
  echo ""
  echo "  LAN access (from another device on this network):"
  while IFS=' ' read -r ip iface; do
    [ -z "${ip}" ] && continue
    echo "    http://${ip}:1776   (${iface})"
  done <<< "${LAN_IP_LINES}"
  echo ""
  echo "  If a LAN device can't connect, check the macOS firewall:"
  echo "    System Settings → Network → Firewall → allow incoming"
  echo "    connections for Docker (or temporarily disable the firewall)."
fi
echo "------------------------------------------------------------"

wait "${BRIDGE_PID}" "${DOCKER_PID}"
