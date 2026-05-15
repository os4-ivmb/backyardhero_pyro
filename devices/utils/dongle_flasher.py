"""Shared esptool-driving helpers for the os4 dongle.

This module is the single source of truth for "what does flashing a
dongle actually look like at the esptool level". Two callers consume it:

  * devices/utils/flash_dongle.py -- the operator-facing CLI. Adds the
    self-bootstrapping venv, port discovery, and interactive prompts.

  * host/tcp_serial_bridge/tcp_serial_bridge.py -- the host-side bridge
    process. Imports this module to drive an esptool flash kicked off
    from the UI, wired through the daemon's HTTP client.

Keeping the constants (offsets, ESP32-S2 chip name, baud) and the
esptool argv assembly in one place means the UI-driven path can never
silently drift away from what the CLI does. If the next arduino-esp32
release changes the flash layout we'll change it here once.

The module is intentionally light on side effects: importing it is free,
no venv setup, no filesystem scanning. Callers do the bootstrap.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


# Standard arduino-esp32 layout for lolin_s2_mini. Same offsets the
# Arduino IDE uses, which is what we want.
#
# Unlike the receiver, the dongle keeps no flash-backed state of its
# own: rfChannel / rfSystemId / debugMode all live in RAM and are
# re-pushed by the host's LEDHandler on every reconnect. So "preserve
# NVS" -- the receiver's reason for using these specific offsets --
# isn't really at stake here. We use the same offsets anyway because:
#   1. They match what the Arduino IDE / build_dongle.sh produce, so
#      operators can swap between IDE-flash and UI-flash without
#      surprises.
#   2. Skipping the bootloader / partition table writes in app-only
#      mode is meaningfully faster (~3s vs ~5s), and there's no upside
#      to rewriting bytes that didn't change.
OFFSET_BOOTLOADER = "0x1000"
OFFSET_PARTITIONS = "0x8000"
OFFSET_BOOT_APP0  = "0xe000"
OFFSET_APP        = "0x10000"

# ESP32-S2 native USB CDC vendor ID. Used by tcp_serial_bridge / the
# CLI to pick the right port out of a noisy `list_ports` result.
ESPRESSIF_VID = 0x303a

# What we tell esptool we're flashing. The dongle is a lolin_s2_mini
# which is plain esp32s2.
ESPTOOL_CHIP = "esp32s2"

# Same baud the CLI has used since the beginning. esp32s2 USB-CDC
# happily handles this; faster baud rates aren't honoured (the CDC
# pipe doesn't actually rate-limit -- baud is just a knob the host
# sets, the device ignores).
ESPTOOL_BAUD = "921600"

# Default app-only flash set: just the app at 0x10000.
#
# Used for the routine "I built a new firmware, push it to the dongle"
# update path -- the only path the UI exposes. The dongle never
# self-OTAs (only receivers do, and they OTA over RF, not via this
# flow), so app1 is always empty and boot_app0 is always pointing at
# app0 from the original arduino-esp32 flash. That means re-stamping
# boot_app0 on every routine update -- which the receiver-side flow
# does need -- buys us nothing here. Skipping it shaves a write and,
# more importantly, lets the UI accept just one .bin from the user
# (the app) instead of asking them to also wrangle boot_app0.bin.
APP_ONLY_OFFSETS = (OFFSET_APP,)

# Full-flash set (first-time / recovery). Re-writes bootloader,
# partition table, boot_app0, and app. Not exposed in the UI -- a
# dongle ships with firmware already on it, so the UI is purely an
# update path. This set still exists for the CLI (flash_dongle.py
# --full) and any future bridge HTTP caller that needs to recover
# from a partition-scheme change or a brick-suspect event.
FULL_FLASH_OFFSETS = (
    OFFSET_BOOTLOADER,
    OFFSET_PARTITIONS,
    OFFSET_BOOT_APP0,
    OFFSET_APP,
)


def find_esptool() -> list[str]:
    """argv prefix for esptool.

    Priority:
      1. Arduino-bundled esptool under <data_dir>/packages/esp32/tools/esptool_py/<ver>/
         on macOS and Linux. The IDE / arduino-cli ships a known-good
         build that knows about ESP32-S2 USB-CDC reset quirks.
      2. esptool installed in the *current* python interpreter (pip-
         installed from requirements.txt -- both the CLI's bootstrapped
         venv and the bridge's venv qualify).
      3. esptool.py / esptool on PATH (fallback, may be too old).

    Raises SystemExit if nothing is found.
    """
    candidates_dirs: list[Path] = []
    if sys.platform == "darwin":
        candidates_dirs.append(
            Path.home() / "Library" / "Arduino15"
                          / "packages" / "esp32" / "tools" / "esptool_py"
        )
    candidates_dirs.append(
        Path.home() / ".arduino15"
                    / "packages" / "esp32" / "tools" / "esptool_py"
    )
    for d in candidates_dirs:
        if d.is_dir():
            for v in sorted(d.iterdir(), reverse=True):
                for cand in (v / "esptool", v / "esptool.py"):
                    if cand.exists() and os.access(cand, os.X_OK):
                        return [str(cand)]

    try:
        import esptool  # type: ignore  # noqa: F401
        return [sys.executable, "-m", "esptool"]
    except ImportError:
        pass

    for name in ("esptool.py", "esptool"):
        path = shutil.which(name)
        if path:
            return [path]

    raise SystemExit(
        "esptool not found.\n"
        "  Install with `pip install esptool` (into the bridge venv\n"
        "  or `flash_dongle.py`'s self-bootstrap venv), or rely on\n"
        "  arduino-esp32's bundled esptool (installed automatically\n"
        "  by build_dongle.sh's `arduino-cli core install esp32:esp32`)."
    )


def build_esptool_cmd(
    esptool_argv: list[str],
    port: str,
    flash_pairs: list[tuple[str, Path]],
    *,
    before: str = "default_reset",
) -> list[str]:
    """Assemble an esptool `write_flash` invocation for the dongle.

    Args:
      esptool_argv: prefix from find_esptool().
      port: serial device path.
      flash_pairs: list of (offset_hex, file_path) pairs to write.
      before: esptool --before mode. "default_reset" tries auto-reset
              into the bootloader (works on most lolin_s2_mini boards
              with the right cable); "no_reset" assumes the operator
              has already mashed BOOT+RESET to put the chip in the
              ROM bootloader manually.

    Returns the full argv list, ready for subprocess.Popen.
    """
    cmd = list(esptool_argv) + [
        "--chip", ESPTOOL_CHIP,
        "--port", port,
        "--baud", ESPTOOL_BAUD,
        "--before", before,
        "--after", "hard_reset",
        "write_flash",
        "-z",
        "--flash_mode", "keep",
        "--flash_freq", "keep",
        "--flash_size", "keep",
    ]
    for offset, path in flash_pairs:
        cmd.extend([offset, str(path)])
    return cmd
