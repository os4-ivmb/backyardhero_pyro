#!/usr/bin/env bash
# build_receiver.sh -- compile os4_receiver.ino and stash versioned binaries
# into devices/os4_receiver/bin/.
#
# Outputs (per FW_VERSION):
#   os4_receiver_v<N>.bin            -- the app partition (~340 KB).
#                                       Flashed at 0x10000 for routine
#                                       firmware updates.
#   os4_receiver_v<N>.bootloader.bin -- chip bootloader. Flashed at 0x1000
#                                       for first-time / recovery flashes.
#   os4_receiver_v<N>.partitions.bin -- partition table. Flashed at 0x8000
#                                       for first-time / recovery flashes.
#   os4_receiver_v<N>.boot_app0.bin  -- OTA "next-app" pointer. Flashed at
#                                       0xe000 for first-time / recovery
#                                       flashes. Static, copied from the
#                                       arduino-esp32 install.
#
# This is exactly the file set the Arduino IDE flashes -- the default
# ESP32-S2 partition table puts NVS at 0x9000-0xdfff, sandwiched between
# the partition table (0x8000-0x8fff) and boot_app0 (0xe000-0xffff), so
# flashing only these four regions naturally preserves NVS (and therefore
# the receiver's NODE_ID / RECEIVER_IDENT) on every flash.
#
# Symlinks:
#   bin/latest.bin             -> newest os4_receiver_v<N>.bin
#   bin/latest.bootloader.bin  -> newest os4_receiver_v<N>.bootloader.bin
#   bin/latest.partitions.bin  -> newest os4_receiver_v<N>.partitions.bin
#   bin/latest.boot_app0.bin   -> newest os4_receiver_v<N>.boot_app0.bin
#
# FW_VERSION is read directly from `#define FW_VERSION` in
# devices/os4_receiver/os4_receiver.ino. Re-running at the same FW_VERSION
# overwrites the existing bins (with a warning) -- bump FW_VERSION in the
# sketch to produce new artifacts alongside the old ones.
#
# Requires: arduino-cli + the ESP32 core. arduino-cli reuses your existing
# ~/Library/Arduino15 install for the core, so no extra setup is needed
# on a machine that already builds via the Arduino IDE.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKETCH_DIR="$(cd "${SCRIPT_DIR}/../os4_receiver" && pwd)"
SKETCH_INO="${SKETCH_DIR}/os4_receiver.ino"
BIN_DIR="${SKETCH_DIR}/bin"
BUILD_DIR="${SKETCH_DIR}/.build"

FQBN="esp32:esp32:lolin_s2_mini:CDCOnBoot=default,MSCOnBoot=default,DFUOnBoot=default,PartitionScheme=default,DebugLevel=none,EraseFlash=none"

# arduino-esp32 ships boot_app0.bin in its tools/partitions/ folder. We
# copy it next to the rest of the per-version bins so flash_receiver.py
# doesn't have to dig through ~/Library/Arduino15 at flash time.
ARDUINO_ESP32_PARTITIONS_GLOB="${HOME}/Library/Arduino15/packages/esp32/hardware/esp32/*/tools/partitions"

err()  { echo "[build_receiver] ERROR: $*" >&2; exit 1; }
info() { echo "[build_receiver] $*"; }

[[ -f "${SKETCH_INO}" ]] || err "sketch not found: ${SKETCH_INO}"

if ! command -v arduino-cli >/dev/null 2>&1; then
  cat >&2 <<EOF
[build_receiver] ERROR: arduino-cli not found.

Install it with:
    brew install arduino-cli

It will reuse your existing Arduino IDE install (~/Library/Arduino15)
for the ESP32 core, so no extra setup is required.
EOF
  exit 1
fi

FW_VERSION="$(awk '/^#define[[:space:]]+FW_VERSION[[:space:]]+/ { print $3; exit }' "${SKETCH_INO}")"
[[ -n "${FW_VERSION}" ]] || err "couldn't parse FW_VERSION from ${SKETCH_INO}"
info "FW_VERSION = ${FW_VERSION}"

if ! arduino-cli core list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "esp32:esp32"; then
  cat >&2 <<EOF
[build_receiver] ERROR: arduino-cli can't see the esp32:esp32 core.

If you build via the Arduino IDE today, run:
    arduino-cli config init --overwrite
    arduino-cli config set directories.data ~/Library/Arduino15
    arduino-cli config set board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
    arduino-cli core update-index
    arduino-cli core install esp32:esp32

(The first three lines only need to be run once.)
EOF
  exit 1
fi

# Find the freshest boot_app0.bin from the installed arduino-esp32 core.
# shellcheck disable=SC2086
BOOT_APP0_SRC="$(ls -t ${ARDUINO_ESP32_PARTITIONS_GLOB}/boot_app0.bin 2>/dev/null | head -1)"
[[ -n "${BOOT_APP0_SRC}" && -f "${BOOT_APP0_SRC}" ]] || \
  err "couldn't find boot_app0.bin under ${ARDUINO_ESP32_PARTITIONS_GLOB}/"

mkdir -p "${BIN_DIR}" "${BUILD_DIR}"

OUT_APP="${BIN_DIR}/os4_receiver_v${FW_VERSION}.bin"
OUT_BL="${BIN_DIR}/os4_receiver_v${FW_VERSION}.bootloader.bin"
OUT_PT="${BIN_DIR}/os4_receiver_v${FW_VERSION}.partitions.bin"
OUT_BA="${BIN_DIR}/os4_receiver_v${FW_VERSION}.boot_app0.bin"
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

APP_SRC="${BUILD_DIR}/os4_receiver.ino.bin"
BL_SRC="${BUILD_DIR}/os4_receiver.ino.bootloader.bin"
PT_SRC="${BUILD_DIR}/os4_receiver.ino.partitions.bin"
[[ -f "${APP_SRC}" ]] || err "expected app binary not produced: ${APP_SRC}"
[[ -f "${BL_SRC}" ]]  || err "expected bootloader binary not produced: ${BL_SRC}"
[[ -f "${PT_SRC}" ]]  || err "expected partitions binary not produced: ${PT_SRC}"

cp "${APP_SRC}"      "${OUT_APP}"
cp "${BL_SRC}"       "${OUT_BL}"
cp "${PT_SRC}"       "${OUT_PT}"
cp "${BOOT_APP0_SRC}" "${OUT_BA}"

# Clean up the superseded merged.bin layout from earlier iterations of
# this script so old artifacts don't confuse the flash helper.
rm -f "${BIN_DIR}/os4_receiver_v${FW_VERSION}_full.bin" \
      "${BIN_DIR}/latest_full.bin"

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
