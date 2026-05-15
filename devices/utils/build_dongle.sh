#!/usr/bin/env bash
# build_dongle.sh -- compile os4_dongle.ino and stash versioned binaries
# into devices/os4_dongle/bin/.
#
# Parallels build_receiver.sh, with two differences:
#   1. Targets the dongle sketch (devices/os4_dongle/os4_dongle.ino).
#   2. Auto-installs the toolchain (arduino-cli + esp32:esp32 core +
#      RF24 / Adafruit NeoPixel / ArduinoJson libraries) on first run.
#      Mac users can still `brew install arduino-cli` ahead of time --
#      we detect an existing install and reuse it.
#
# Outputs (per FW_VERSION):
#   os4_dongle_v<N>.bin            -- the app partition (~340 KB).
#                                     Flashed at 0x10000 for routine
#                                     firmware updates.
#   os4_dongle_v<N>.bootloader.bin -- chip bootloader. Flashed at 0x1000
#                                     for first-time / recovery flashes.
#   os4_dongle_v<N>.partitions.bin -- partition table. Flashed at 0x8000
#                                     for first-time / recovery flashes.
#   os4_dongle_v<N>.boot_app0.bin  -- OTA "next-app" pointer. Flashed
#                                     at 0xe000 on EVERY flash so the
#                                     chip always boots app0.
#
# This is exactly the file set the Arduino IDE flashes. The dongle
# (unlike the receiver) keeps no flash-backed state of its own --
# rfChannel / rfSystemId / debugMode all live in RAM and the host
# re-pushes them on every reconnect -- so there's no NVS-preservation
# behavior to worry about. The four-region split exists purely so
# routine app-only updates can skip the unchanging bootloader +
# partition-table writes (saves ~2s per flash).
#
# Symlinks:
#   bin/latest.bin             -> newest os4_dongle_v<N>.bin
#   bin/latest.bootloader.bin  -> newest os4_dongle_v<N>.bootloader.bin
#   bin/latest.partitions.bin  -> newest os4_dongle_v<N>.partitions.bin
#   bin/latest.boot_app0.bin   -> newest os4_dongle_v<N>.boot_app0.bin
#
# Flags:
#   --no-auto-install   Don't try to install missing toolchain pieces.
#                       (Use when you want a fast fail on a CI box or
#                       you're managing arduino-cli/cores by hand.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKETCH_DIR="$(cd "${SCRIPT_DIR}/../os4_dongle" && pwd)"
SKETCH_INO="${SKETCH_DIR}/os4_dongle.ino"
BIN_DIR="${SKETCH_DIR}/bin"
BUILD_DIR="${SKETCH_DIR}/.build"

FQBN="esp32:esp32:lolin_s2_mini:CDCOnBoot=default,MSCOnBoot=default,DFUOnBoot=default,PartitionScheme=default,DebugLevel=none,EraseFlash=none"

# Libraries the dongle sketch pulls in. esp_task_wdt / SPI ship with
# the ESP32 core itself.
REQUIRED_LIBS=(
  "RF24"
  "Adafruit NeoPixel"
  "ArduinoJson"
)

# Espressif's official arduino-esp32 package index. Needed so that
# `arduino-cli core install esp32:esp32` works on a fresh box.
ESP32_PKG_INDEX="https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json"

AUTO_INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-auto-install) AUTO_INSTALL=0; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "[build_dongle] unknown arg: $1" >&2; exit 1 ;;
  esac
done

err()  { echo "[build_dongle] ERROR: $*" >&2; exit 1; }
info() { echo "[build_dongle] $*"; }

[[ -f "${SKETCH_INO}" ]] || err "sketch not found: ${SKETCH_INO}"

# ---------------------------------------------------------------------------
# Toolchain bootstrap
# ---------------------------------------------------------------------------

install_arduino_cli_linux() {
  # Use Arduino's official installer; lands the binary at $HOME/bin or
  # /usr/local/bin depending on perms. We always force /usr/local/bin
  # when we have sudo so it ends up on PATH for everyone, falling back
  # to ~/.local/bin otherwise.
  local target_dir
  if [[ "$(id -u)" -eq 0 ]]; then
    target_dir="/usr/local/bin"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    target_dir="/usr/local/bin"
  else
    target_dir="${HOME}/.local/bin"
    mkdir -p "${target_dir}"
  fi
  info "installing arduino-cli -> ${target_dir}"
  # The official install script honors BINDIR.
  if [[ "${target_dir}" == "/usr/local/bin" && "$(id -u)" -ne 0 ]]; then
    curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
      | sudo BINDIR="${target_dir}" sh
  else
    curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
      | BINDIR="${target_dir}" sh
  fi
  # Make sure the install dir is reachable for the rest of this run.
  case ":${PATH}:" in
    *":${target_dir}:"*) : ;;
    *) export PATH="${target_dir}:${PATH}" ;;
  esac
}

ensure_arduino_cli() {
  if command -v arduino-cli >/dev/null 2>&1; then return; fi
  if [[ "${AUTO_INSTALL}" -ne 1 ]]; then
    err "arduino-cli not found and --no-auto-install was set."
  fi
  case "$(uname -s)" in
    Linux)
      install_arduino_cli_linux
      ;;
    Darwin)
      cat >&2 <<EOF
[build_dongle] ERROR: arduino-cli not found.

Install on macOS with:
    brew install arduino-cli

Then re-run this script.
EOF
      exit 1
      ;;
    *)
      err "unsupported OS: $(uname -s); install arduino-cli manually and re-run."
      ;;
  esac
}

ensure_arduino_cli_config() {
  # Idempotent: `config init` complains if the file exists, but we
  # ignore that. After init we make sure the esp32 package index URL
  # is on the additional_urls list so `core install` works.
  arduino-cli config init >/dev/null 2>&1 || true
  if ! arduino-cli config dump --format json 2>/dev/null \
        | grep -q "${ESP32_PKG_INDEX}"; then
    info "adding esp32 package index to arduino-cli config"
    arduino-cli config add board_manager.additional_urls "${ESP32_PKG_INDEX}" \
      >/dev/null 2>&1 || true
  fi
}

ensure_esp32_core() {
  if arduino-cli core list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "esp32:esp32"; then
    return
  fi
  if [[ "${AUTO_INSTALL}" -ne 1 ]]; then
    err "esp32:esp32 core not installed and --no-auto-install was set."
  fi
  info "installing esp32:esp32 core (large download, ~5-10 min on a Pi)..."
  arduino-cli core update-index >/dev/null
  arduino-cli core install esp32:esp32
}

ensure_libs() {
  local installed
  installed="$(arduino-cli lib list 2>/dev/null | awk 'NR>1 {print $1}')"
  for lib in "${REQUIRED_LIBS[@]}"; do
    # arduino-cli lib list strips trailing space-suffixed metadata, but
    # the name we install is the exact display name. Strip-and-match.
    local needle
    needle="$(printf '%s' "${lib}" | tr -d ' ')"
    local have
    have="$(printf '%s\n' "${installed}" | tr -d ' ' | grep -ixF "${needle}" || true)"
    if [[ -z "${have}" ]]; then
      if [[ "${AUTO_INSTALL}" -ne 1 ]]; then
        err "missing arduino library '${lib}' and --no-auto-install was set."
      fi
      info "installing arduino library: ${lib}"
      arduino-cli lib install "${lib}"
    fi
  done
}

resolve_arduino_data_dir() {
  # Where arduino-cli + the IDE store cores/tools. We need this to find
  # boot_app0.bin, which the esp32 core ships in
  # packages/esp32/hardware/esp32/<ver>/tools/partitions/boot_app0.bin.
  local from_cli
  from_cli="$(arduino-cli config dump --format json 2>/dev/null \
    | python3 -c "import json, sys
try:
    cfg = json.load(sys.stdin)
    print(cfg.get('directories', {}).get('data', ''))
except Exception:
    pass" 2>/dev/null || true)"
  if [[ -n "${from_cli}" && -d "${from_cli}" ]]; then
    echo "${from_cli}"
    return
  fi
  # Fallbacks per platform.
  case "$(uname -s)" in
    Darwin)  echo "${HOME}/Library/Arduino15" ;;
    Linux)   echo "${HOME}/.arduino15" ;;
    *)       echo "${HOME}/.arduino15" ;;
  esac
}

ensure_arduino_cli
ensure_arduino_cli_config
ensure_esp32_core
ensure_libs

ARDUINO_DATA_DIR="$(resolve_arduino_data_dir)"
ARDUINO_ESP32_PARTITIONS_GLOB="${ARDUINO_DATA_DIR}/packages/esp32/hardware/esp32/*/tools/partitions"

# ---------------------------------------------------------------------------
# Version + outputs
# ---------------------------------------------------------------------------

FW_VERSION="$(awk '/^#define[[:space:]]+FW_VERSION[[:space:]]+/ { print $3; exit }' "${SKETCH_INO}")"
[[ -n "${FW_VERSION}" ]] || err "couldn't parse FW_VERSION from ${SKETCH_INO}"
info "FW_VERSION = ${FW_VERSION}"

# shellcheck disable=SC2086
BOOT_APP0_SRC="$(ls -t ${ARDUINO_ESP32_PARTITIONS_GLOB}/boot_app0.bin 2>/dev/null | head -1)"
[[ -n "${BOOT_APP0_SRC}" && -f "${BOOT_APP0_SRC}" ]] || \
  err "couldn't find boot_app0.bin under ${ARDUINO_ESP32_PARTITIONS_GLOB}/ (esp32 core install incomplete?)"

mkdir -p "${BIN_DIR}" "${BUILD_DIR}"

OUT_APP="${BIN_DIR}/os4_dongle_v${FW_VERSION}.bin"
OUT_BL="${BIN_DIR}/os4_dongle_v${FW_VERSION}.bootloader.bin"
OUT_PT="${BIN_DIR}/os4_dongle_v${FW_VERSION}.partitions.bin"
OUT_BA="${BIN_DIR}/os4_dongle_v${FW_VERSION}.boot_app0.bin"
for f in "${OUT_APP}" "${OUT_BL}" "${OUT_PT}" "${OUT_BA}"; do
  if [[ -f "${f}" ]]; then
    info "WARNING: ${f##*/} already exists -- overwriting (bump FW_VERSION to keep both)."
  fi
done

info "compiling ${SKETCH_DIR##*/}..."
arduino-cli compile \
  --fqbn "${FQBN}" \
  --build-path "${BUILD_DIR}" \
  --warnings none \
  "${SKETCH_DIR}"

APP_SRC="${BUILD_DIR}/os4_dongle.ino.bin"
BL_SRC="${BUILD_DIR}/os4_dongle.ino.bootloader.bin"
PT_SRC="${BUILD_DIR}/os4_dongle.ino.partitions.bin"
[[ -f "${APP_SRC}" ]] || err "expected app binary not produced: ${APP_SRC}"
[[ -f "${BL_SRC}"  ]] || err "expected bootloader binary not produced: ${BL_SRC}"
[[ -f "${PT_SRC}"  ]] || err "expected partitions binary not produced: ${PT_SRC}"

cp "${APP_SRC}"       "${OUT_APP}"
cp "${BL_SRC}"        "${OUT_BL}"
cp "${PT_SRC}"        "${OUT_PT}"
cp "${BOOT_APP0_SRC}" "${OUT_BA}"

ln -sfn "$(basename "${OUT_APP}")" "${BIN_DIR}/latest.bin"
ln -sfn "$(basename "${OUT_BL}")"  "${BIN_DIR}/latest.bootloader.bin"
ln -sfn "$(basename "${OUT_PT}")"  "${BIN_DIR}/latest.partitions.bin"
ln -sfn "$(basename "${OUT_BA}")"  "${BIN_DIR}/latest.boot_app0.bin"

bytes() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }
info "wrote ${OUT_APP##*/} ($(( $(bytes "${OUT_APP}") / 1024 )) KB, app)"
info "wrote ${OUT_BL##*/}  ($(( $(bytes "${OUT_BL}") / 1024 )) KB, bootloader)"
info "wrote ${OUT_PT##*/}  ($(( $(bytes "${OUT_PT}") )) B, partition table)"
info "wrote ${OUT_BA##*/}  ($(( $(bytes "${OUT_BA}") )) B, boot_app0)"
info "done."
