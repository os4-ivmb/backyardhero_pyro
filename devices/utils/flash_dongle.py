#!/usr/bin/env python3
"""flash_dongle.py -- flash an os4 dongle (ESP32-S2 lolin_s2_mini).

Two modes:

    flash_dongle.py
        Default. App-only flash at 0x10000 PLUS a re-stamp of the OTA
        next-app pointer (boot_app0.bin at 0xe000). Skips writing the
        bootloader and partition table (which never change between
        builds) so the routine update finishes in ~3s instead of ~5s.

    flash_dongle.py --full
        First-time / recovery flash: bootloader + partition table +
        boot_app0 + app, all in one esptool invocation. Use for a
        brand-new chip or if the partition table itself changed.

The dongle keeps no flash-backed state of its own (no NVS / Preferences
use, unlike the receiver) -- rfChannel / rfSystemId / debugMode are
all RAM-only and re-pushed from the host on every reconnect. So
neither mode has any "settings preserved" behavior to advertise: any
flash mode is safe with respect to dongle-side state.

Port selection priority (use --port to override):
    1. /dev/byh_dongle (set by the install_pi.sh udev rule)
    2. /dev/serial/by-id/* matching Espressif/ESP32/LOLIN
    3. /dev/ttyACM* whose USB VID is 0x303a (Espressif)
    4. First detected USB-CDC serial port (with confirmation prompt)

Dependencies are installed automatically into devices/utils/.venv on
first run (pyserial + esptool). Same self-bootstrap pattern as
flash_receiver.py.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# Self-bootstrapping venv (mirrors flash_receiver.py)
# ---------------------------------------------------------------------------

def _ensure_venv() -> None:
    script_dir = Path(__file__).resolve().parent
    venv_dir = script_dir / ".venv"
    venv_python = venv_dir / "bin" / "python3"
    requirements = script_dir / "requirements.txt"

    if sys.executable == str(venv_python):
        try:
            import serial  # noqa: F401
            return
        except ImportError:
            print("[flash_dongle] dependencies changed -- updating .venv...",
                  file=sys.stderr)
            subprocess.run(
                [str(venv_dir / "bin" / "pip"), "install", "-q", "-r", str(requirements)],
                check=True,
            )
            os.execv(str(venv_python), [str(venv_python), __file__, *sys.argv[1:]])

    try:
        import serial  # noqa: F401
        return
    except ImportError:
        pass

    if not venv_python.exists():
        print(f"[flash_dongle] creating venv at {venv_dir} (one-time setup)...",
              file=sys.stderr)
        subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
        print("[flash_dongle] installing dependencies...", file=sys.stderr)
        subprocess.run(
            [str(venv_dir / "bin" / "pip"), "install", "-q", "-r", str(requirements)],
            check=True,
        )

    os.execv(str(venv_python), [str(venv_python), __file__, *sys.argv[1:]])


_ensure_venv()


import argparse  # noqa: E402
import re        # noqa: E402

import serial                       # noqa: E402  (pyserial)
from serial.tools import list_ports  # noqa: E402

# Shared esptool-driving helpers. The bridge process imports the same
# module so the UI-driven flash path can never silently drift away from
# what this CLI does.
from dongle_flasher import (        # noqa: E402
    OFFSET_BOOTLOADER,
    OFFSET_PARTITIONS,
    OFFSET_BOOT_APP0,
    OFFSET_APP,
    ESPRESSIF_VID,
    find_esptool,
    build_esptool_cmd,
)


SCRIPT_DIR = Path(__file__).resolve().parent
SKETCH_DIR = (SCRIPT_DIR / ".." / "os4_dongle").resolve()
BIN_DIR = SKETCH_DIR / "bin"

# Per-version artifact names produced by build_dongle.sh.
APP_BIN_RE = re.compile(r"^os4_dongle_v(\d+)\.bin$")


def log(msg: str) -> None:
    print(f"[flash_dongle] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Bin selection
# ---------------------------------------------------------------------------

def _latest_app_bin() -> tuple[int, Path]:
    if not BIN_DIR.is_dir():
        raise SystemExit(
            f"[flash_dongle] no bin dir at {BIN_DIR} -- run build_dongle.sh first."
        )
    candidates: list[tuple[int, float, Path]] = []
    for p in BIN_DIR.iterdir():
        m = APP_BIN_RE.match(p.name)
        if not m:
            continue
        candidates.append((int(m.group(1)), p.stat().st_mtime, p))
    if not candidates:
        raise SystemExit(
            f"[flash_dongle] no os4_dongle_v*.bin found in {BIN_DIR}.\n"
            "  Run devices/utils/build_dongle.sh first."
        )
    candidates.sort(key=lambda t: (t[0], t[1]))
    v, _, p = candidates[-1]
    return v, p


def find_latest_app_bin() -> Path:
    return _latest_app_bin()[1]


def find_boot_app0_for(app_bin: Path) -> Path | None:
    """Match boot_app0.bin to the app's version, falling back to the
    `latest` symlink. boot_app0 is byte-identical across versions
    (static arduino-esp32 file) so `latest` is always safe."""
    m = APP_BIN_RE.match(app_bin.name)
    if m:
        sibling = app_bin.parent / f"os4_dongle_v{m.group(1)}.boot_app0.bin"
        if sibling.is_file():
            return sibling
    fallback = BIN_DIR / "latest.boot_app0.bin"
    if fallback.exists():
        return fallback.resolve()
    return None


def find_latest_full_set() -> dict[str, Path]:
    version, app = _latest_app_bin()
    bl = BIN_DIR / f"os4_dongle_v{version}.bootloader.bin"
    pt = BIN_DIR / f"os4_dongle_v{version}.partitions.bin"
    ba = BIN_DIR / f"os4_dongle_v{version}.boot_app0.bin"
    missing = [p for p in (bl, pt, ba) if not p.is_file()]
    if missing:
        raise SystemExit(
            f"[flash_dongle] FULL flash needs all four v{version} artifacts; missing:\n  "
            + "\n  ".join(str(p) for p in missing)
            + "\n  Re-run devices/utils/build_dongle.sh to regenerate them."
        )
    return {
        OFFSET_BOOTLOADER: bl,
        OFFSET_PARTITIONS: pt,
        OFFSET_BOOT_APP0:  ba,
        OFFSET_APP:        app,
    }


# ---------------------------------------------------------------------------
# Serial port pick
# ---------------------------------------------------------------------------

def _udev_symlink_target() -> str | None:
    """If install_pi.sh's udev rule has created /dev/byh_dongle, use
    it. The actual /dev/ttyACMx underneath may shuffle across replug,
    but the symlink stays put -- which is exactly the property
    /dev/byh_dongle was created for."""
    p = Path("/dev/byh_dongle")
    if p.exists():
        try:
            return str(p.resolve())
        except OSError:
            return str(p)
    return None


def _by_id_match() -> str | None:
    by_id = Path("/dev/serial/by-id")
    if not by_id.is_dir():
        return None
    for entry in sorted(by_id.iterdir()):
        name = entry.name
        low = name.lower()
        if any(tok in low for tok in ("espressif", "esp32", "lolin", "esp_")):
            try:
                return str(entry.resolve())
            except OSError:
                return str(entry)
    return None


def list_candidate_ports() -> list[str]:
    """Return likely-relevant serial ports. /dev/byh_dongle (the udev
    symlink) gets to jump the queue; after that we prefer ports whose
    USB VID is Espressif's, then everything else."""
    ports = []

    sym = _udev_symlink_target()
    if sym:
        ports.append(sym)

    by_id = _by_id_match()
    if by_id and by_id not in ports:
        ports.append(by_id)

    espressif: list[str] = []
    other: list[str] = []
    for p in list_ports.comports():
        device = p.device
        low = device.lower()
        if "bluetooth" in low or "debug-console" in low:
            continue
        if device in ports:
            continue
        if (p.vid or 0) == ESPRESSIF_VID:
            espressif.append(device)
        else:
            other.append(device)

    espressif.sort()
    other.sort(key=lambda d: (0 if "usbmodem" in d.lower() else 1, d))
    ports.extend(espressif)
    ports.extend(other)
    return ports


def pick_port(prompt: bool = True) -> str:
    """Auto-pick if there's an obvious choice (udev symlink or single
    Espressif device); otherwise prompt."""
    cands = list_candidate_ports()
    if not cands:
        if not prompt:
            raise SystemExit("[flash_dongle] no candidate serial ports found.")
        return input("Serial port (e.g. /dev/ttyACM0): ").strip()

    # If /dev/byh_dongle exists, just use it -- the udev rule was
    # written specifically so the dongle has a stable name.
    sym = _udev_symlink_target()
    if sym and sym in cands:
        log(f"using {Path('/dev/byh_dongle')} -> {sym}")
        return sym

    if len(cands) == 1 or not prompt:
        log(f"using {cands[0]}")
        return cands[0]

    print("Detected serial ports:")
    for i, p in enumerate(cands, 1):
        marker = "  <-- default" if i == 1 else ""
        print(f"  [{i}] {p}{marker}")
    raw = input(
        f"Pick a port [1-{len(cands)}] or paste a path "
        f"(default 1 -> {cands[0]}): "
    ).strip()
    if not raw:
        return cands[0]
    if raw.isdigit():
        idx = int(raw)
        if 1 <= idx <= len(cands):
            return cands[idx - 1]
        raise SystemExit(f"[flash_dongle] invalid choice: {raw}")
    return raw


# ---------------------------------------------------------------------------
# esptool flash
# ---------------------------------------------------------------------------


def run_esptool_flash(port: str, flash_pairs: list[tuple[str, Path]]) -> None:
    """Drive esptool through up to three attempts:

      1. --before default_reset       (auto-reset into bootloader)
      2. --before no_reset            (auto, no user input) -- empirically
         the chip is often already sitting in a download-ready state after
         a "failed" default_reset on the lolin_s2_mini, so this silent
         retry succeeds on its own a large fraction of the time and saves
         the operator from a spurious BOOT+RESET prompt.
      3. --before no_reset, AFTER prompting the operator to manually
         enter the ROM bootloader. Only reached if attempt #2 also fails.
    """
    esptool_argv = find_esptool()

    cmd = build_esptool_cmd(esptool_argv, port, flash_pairs, before="default_reset")
    log("running: " + " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
        return
    except subprocess.CalledProcessError:
        log("esptool auto-reset failed -- common on lolin_s2_mini USB-CDC boards.")

    log("retrying once with --before no_reset before asking for manual BOOT+RESET...")
    time.sleep(1.0)
    cmd_noreset = build_esptool_cmd(esptool_argv, port, flash_pairs, before="no_reset")
    log("running: " + " ".join(cmd_noreset))
    try:
        subprocess.run(cmd_noreset, check=True)
        return
    except subprocess.CalledProcessError:
        log("silent no_reset retry also failed -- falling back to manual prompt.")

    print(
        "\n"
        "  -----------------------------------------------------------\n"
        "  Manually enter the ROM bootloader on the dongle:\n"
        "    1. Press and HOLD the BOOT button on the dongle\n"
        "    2. While still holding BOOT, press and release RESET\n"
        "    3. Release BOOT\n"
        "  -----------------------------------------------------------\n",
        file=sys.stderr, flush=True,
    )
    input("  Press Enter once the dongle is in bootloader mode... ")

    log("retrying: " + " ".join(cmd_noreset))
    try:
        subprocess.run(cmd_noreset, check=True)
    except subprocess.CalledProcessError as e:
        raise SystemExit(
            f"[flash_dongle] esptool failed again (exit {e.returncode}).\n"
            "  Things to try:\n"
            "    * Unplug and replug the dongle, then re-run this script.\n"
            "    * If you're running this on the Pi, make sure the\n"
            "      Backyard Hero host service has been stopped so it\n"
            "      isn't holding the serial port:\n"
            "          sudo systemctl stop byh-host\n"
            "    * Try a different USB cable / port (some cables are\n"
            "      power-only and don't carry data)."
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--bin", type=Path,
        help="path to a specific app .bin (default: latest in os4_dongle/bin/). "
             "Ignored in --full mode (which always uses the matching v<N>.* set).",
    )
    p.add_argument("--port", help="serial port (default: auto-detect)")
    p.add_argument(
        "--full", action="store_true",
        help="first-time / recovery flash: bootloader + partitions + boot_app0 + app, "
             "all in one esptool call. Naturally preserves NVS.",
    )
    p.add_argument(
        "-y", "--yes", action="store_true",
        help="non-interactive: auto-pick the first detected port, never prompt.",
    )
    return p.parse_args()


def _format_bin_label(p: Path) -> str:
    try:
        return str(p.relative_to(Path.cwd()))
    except ValueError:
        return str(p)


def main() -> int:
    args = parse_args()

    if args.full:
        if args.bin is not None:
            log("WARNING: --bin is ignored in --full mode (uses the full v<N>.* set).")
        full_set = find_latest_full_set()
        flash_pairs = [
            (OFFSET_BOOTLOADER, full_set[OFFSET_BOOTLOADER]),
            (OFFSET_PARTITIONS, full_set[OFFSET_PARTITIONS]),
            (OFFSET_BOOT_APP0,  full_set[OFFSET_BOOT_APP0]),
            (OFFSET_APP,        full_set[OFFSET_APP]),
        ]
        log(f"FULL flash, version-matched set, app: {_format_bin_label(full_set[OFFSET_APP])}")
    else:
        app_bin = args.bin.resolve() if args.bin else find_latest_app_bin()
        if not app_bin.is_file():
            raise SystemExit(f"[flash_dongle] not a file: {app_bin}")
        boot_app0 = find_boot_app0_for(app_bin)
        flash_pairs = [(OFFSET_APP, app_bin)]
        if boot_app0:
            flash_pairs.insert(0, (OFFSET_BOOT_APP0, boot_app0))
            log(f"app+boot_app0 flash: {_format_bin_label(app_bin)} + "
                f"{_format_bin_label(boot_app0)}")
        else:
            log(f"app-only flash (no boot_app0.bin found): {_format_bin_label(app_bin)}")

    port = args.port or pick_port(prompt=not args.yes)

    run_esptool_flash(port, flash_pairs)
    log("SUCCESS -- dongle flashed.")
    log("If the host daemon was running, restart it so it picks the dongle back up:")
    log("    sudo systemctl restart byh-host")
    return 0


if __name__ == "__main__":
    sys.exit(main())
