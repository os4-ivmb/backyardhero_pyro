#!/usr/bin/env python3
"""flash_receiver.py -- flash an os4 receiver. Mirrors the Arduino IDE's
flash invocation byte-for-byte, with the only addition being post-flash
NODE_ID provisioning over serial.

Three modes:

    flash_receiver.py
        Default. Writes the app at 0x10000 AND re-stamps the OTA
        next-app pointer (boot_app0.bin at 0xe000), so the chip is
        guaranteed to boot what we just wrote -- even if the previous
        run was an OTA that left the bootloader pointing at app1.
        PRESERVES NVS, so the receiver's NODE_ID / RECEIVER_IDENT carry
        through every routine firmware bump.

    flash_receiver.py --full
        First-time flash: bootloader + partition table + boot_app0 + app,
        all in one esptool invocation -- the same four-file layout the
        IDE writes when it pushes a fresh build. Naturally preserves NVS
        because the default ESP32-S2 partition table puts NVS at
        0x9000-0xdfff, sandwiched between partitions (0x8000-0x8fff)
        and boot_app0 (0xe000-0xffff), and we don't write anything in
        that gap. Auto-prompts for receiver number and runs SETID over
        serial afterwards. Use for a brand-new chip or for recovery.

    flash_receiver.py --set-id
        Same flash as default (app + boot_app0), then an interactive
        SETID. Re-numbers a receiver without wiping anything else in NVS.

`--node N` and `--ident NAME` skip the prompts.

Dependencies are installed automatically into devices/utils/.venv on
first run (pyserial + esptool). No manual pip install needed; macOS
Homebrew Python's PEP 668 protection is sidestepped by the venv. To
rebuild the venv from scratch, `rm -rf devices/utils/.venv` and re-run.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Self-bootstrapping venv
# ---------------------------------------------------------------------------
# macOS Homebrew Python ships with PEP 668 protection, so a global
# `pip install pyserial` fails. Rather than make the operator deal with
# venv plumbing, we transparently create one at devices/utils/.venv on
# first run, install requirements.txt into it, and re-exec ourselves
# under the venv's interpreter. Steady state: ~50ms to detect we're
# already in the venv and continue.

def _ensure_venv() -> None:
    script_dir = Path(__file__).resolve().parent
    venv_dir = script_dir / ".venv"
    venv_python = venv_dir / "bin" / "python3"
    requirements = script_dir / "requirements.txt"

    # Already running under our venv -> everything should import.
    if sys.executable == str(venv_python):
        try:
            import serial  # noqa: F401
            return
        except ImportError:
            # Requirements changed since the venv was built; reinstall.
            print(
                "[flash_receiver] dependencies changed -- updating .venv...",
                file=sys.stderr,
            )
            subprocess.run(
                [str(venv_dir / "bin" / "pip"), "install", "-q", "-r", str(requirements)],
                check=True,
            )
            os.execv(str(venv_python), [str(venv_python), __file__, *sys.argv[1:]])

    # Outside venv. If the host Python already has pyserial (rare on
    # macOS, normal on Linux), just use it directly.
    try:
        import serial  # noqa: F401
        return
    except ImportError:
        pass

    # First-run bootstrap.
    if not venv_python.exists():
        print(
            f"[flash_receiver] creating venv at {venv_dir} (one-time setup)...",
            file=sys.stderr,
        )
        subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
        print("[flash_receiver] installing dependencies...", file=sys.stderr)
        subprocess.run(
            [str(venv_dir / "bin" / "pip"), "install", "-q", "-r", str(requirements)],
            check=True,
        )

    # Hand off to the venv interpreter.
    os.execv(str(venv_python), [str(venv_python), __file__, *sys.argv[1:]])


_ensure_venv()


import argparse  # noqa: E402  (intentional: after _ensure_venv)
import re        # noqa: E402
import shutil    # noqa: E402
import time      # noqa: E402

import serial  # noqa: E402  (pyserial)
from serial.tools import list_ports  # noqa: E402


SCRIPT_DIR = Path(__file__).resolve().parent
SKETCH_DIR = (SCRIPT_DIR / ".." / "os4_receiver").resolve()
BIN_DIR = SKETCH_DIR / "bin"

# Per-version artifact filenames produced by build_receiver.sh:
#   os4_receiver_v<N>.bin             -- app, flashed at 0x10000
#   os4_receiver_v<N>.bootloader.bin  -- chip bootloader, flashed at 0x1000
#   os4_receiver_v<N>.partitions.bin  -- partition table, flashed at 0x8000
#   os4_receiver_v<N>.boot_app0.bin   -- OTA next-app pointer, flashed at 0xe000
APP_BIN_RE = re.compile(r"^os4_receiver_v(\d+)\.bin$")

# Standard arduino-esp32 layout for lolin_s2_mini (default partition
# table). NVS lives at 0x9000-0xdfff, in the gap between PARTITIONS and
# BOOT_APP0 -- writing only these four regions naturally preserves it.
OFFSET_BOOTLOADER = "0x1000"
OFFSET_PARTITIONS = "0x8000"
OFFSET_BOOT_APP0  = "0xe000"
OFFSET_APP        = "0x10000"


def log(msg: str) -> None:
    print(f"[flash_receiver] {msg}", flush=True)


def err(msg: str) -> None:
    print(f"[flash_receiver] ERROR: {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Bin selection
# ---------------------------------------------------------------------------


def _latest_app_bin() -> tuple[int, Path]:
    """Return (version, path) of the highest-versioned app binary."""
    if not BIN_DIR.is_dir():
        raise SystemExit(
            f"[flash_receiver] no bin dir at {BIN_DIR} -- run build_receiver.sh first."
        )

    candidates: list[tuple[int, float, Path]] = []
    for p in BIN_DIR.iterdir():
        m = APP_BIN_RE.match(p.name)
        if not m:
            continue
        candidates.append((int(m.group(1)), p.stat().st_mtime, p))

    if not candidates:
        raise SystemExit(
            f"[flash_receiver] no os4_receiver_v*.bin found in {BIN_DIR}.\n"
            "  Run devices/utils/build_receiver.sh first."
        )

    candidates.sort(key=lambda t: (t[0], t[1]))
    v, _, p = candidates[-1]
    return v, p


def find_latest_app_bin() -> Path:
    """Path to the newest app binary."""
    return _latest_app_bin()[1]


def find_boot_app0_for(app_bin: Path) -> Path | None:
    """Locate the boot_app0.bin that pairs with a given app binary.

    Strategy:
      1. If `app_bin` matches the build_receiver.sh naming convention
         (`os4_receiver_v<N>.bin`), look for `os4_receiver_v<N>.boot_app0.bin`
         next to it. This is the version-matched artifact.
      2. Otherwise fall back to `bin/latest.boot_app0.bin` -- the
         build_receiver.sh symlink. boot_app0.bin is byte-for-byte
         identical across versions (it's the static "boot from app0"
         pointer copied straight out of the arduino-esp32 install), so
         using `latest` is safe even if the user passed `--bin` to a
         hand-renamed file.
      3. If neither exists, return None and let the caller decide whether
         to skip the boot_app0 flash.
    """
    m = APP_BIN_RE.match(app_bin.name)
    if m:
        sibling = app_bin.parent / f"os4_receiver_v{m.group(1)}.boot_app0.bin"
        if sibling.is_file():
            return sibling

    fallback = BIN_DIR / "latest.boot_app0.bin"
    if fallback.exists():
        return fallback.resolve()

    return None


def find_latest_full_set() -> dict[str, Path]:
    """Locate the four files needed for a first-time / full flash, all
    matching the same FW_VERSION. Returns {offset: path}."""
    version, app = _latest_app_bin()
    bl = BIN_DIR / f"os4_receiver_v{version}.bootloader.bin"
    pt = BIN_DIR / f"os4_receiver_v{version}.partitions.bin"
    ba = BIN_DIR / f"os4_receiver_v{version}.boot_app0.bin"
    missing = [p for p in (bl, pt, ba) if not p.is_file()]
    if missing:
        raise SystemExit(
            f"[flash_receiver] FULL flash needs all four v{version} artifacts; missing:\n  "
            + "\n  ".join(str(p) for p in missing)
            + "\n  Re-run devices/utils/build_receiver.sh to regenerate them."
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


def list_candidate_ports() -> list[str]:
    """Return likely-relevant serial ports (USB-CDC + tty.usbmodem* on mac)."""
    ports = []
    for p in list_ports.comports():
        device = p.device
        low = device.lower()
        if "bluetooth" in low or "debug-console" in low:
            continue
        ports.append(device)
    # On macOS the lolin_s2_mini shows up as /dev/tty.usbmodem* -- prefer those.
    ports.sort(key=lambda d: (0 if "usbmodem" in d.lower() else 1, d))
    return ports


def prompt_port() -> str:
    candidates = list_candidate_ports()
    if not candidates:
        return input("Serial port (e.g. /dev/tty.usbmodem01): ").strip()

    print("Detected serial ports:")
    for i, p in enumerate(candidates, 1):
        marker = "  <-- default" if i == 1 else ""
        print(f"  [{i}] {p}{marker}")

    raw = input(
        f"Pick a port [1-{len(candidates)}] or paste a path "
        f"(default 1 -> {candidates[0]}): "
    ).strip()
    if not raw:
        return candidates[0]
    if raw.isdigit():
        idx = int(raw)
        if 1 <= idx <= len(candidates):
            return candidates[idx - 1]
        raise SystemExit(f"[flash_receiver] invalid choice: {raw}")
    return raw


# ---------------------------------------------------------------------------
# Receiver identity prompt
# ---------------------------------------------------------------------------


def prompt_node_id() -> int:
    while True:
        raw = input("Receiver number (1-254): ").strip()
        if not raw.isdigit():
            print("  must be an integer")
            continue
        n = int(raw)
        if 1 <= n <= 254:
            return n
        print("  out of range (1-254)")


def prompt_ident(default: str) -> str:
    raw = input(f"Receiver ident [default {default}]: ").strip()
    if not raw:
        return default
    if len(raw) > 15:
        raise SystemExit("[flash_receiver] ident too long (max 15 chars).")
    if " " in raw:
        raise SystemExit("[flash_receiver] ident must not contain spaces.")
    return raw


# ---------------------------------------------------------------------------
# esptool flash
# ---------------------------------------------------------------------------


def find_esptool() -> list[str]:
    """Return the argv prefix for invoking esptool, in priority order:

      1. The Arduino-bundled esptool (~/Library/Arduino15/packages/esp32/
         tools/esptool_py/<ver>/esptool). This is the EXACT binary the
         Arduino IDE shells out to when you hit Upload, so by definition
         it's the one we know works on this machine. Its USB-CDC reset
         handling for ESP32-S2 boards is what we want to inherit.
      2. The venv-installed esptool (pyproject installs >=4.9). Used if
         arduino-cli isn't installed and the IDE has never been used.
      3. esptool.py / esptool on PATH (likely brew, possibly old).
    """
    arduino_pkg = Path.home() / "Library" / "Arduino15" / "packages" / "esp32" / "tools" / "esptool_py"
    if arduino_pkg.is_dir():
        for v in sorted(arduino_pkg.iterdir(), reverse=True):
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
            log(
                f"WARNING: falling back to {path}. If you see "
                "'Could not configure port' or hangs at 'Connecting...', "
                "this esptool may be too old for ESP32-S2 USB-CDC."
            )
            return [path]

    raise SystemExit(
        "[flash_receiver] ERROR: esptool not found.\n"
        "  Install the Arduino IDE's ESP32 core, or:\n"
        "    rm -rf devices/utils/.venv && ./flash_receiver.py --help"
    )


def _build_esptool_cmd(
    esptool_argv: list[str],
    port: str,
    flash_pairs: list[tuple[str, Path]],
    *,
    before: str,
) -> list[str]:
    """Build the exact `write_flash` command line that the Arduino IDE
    uses for an upload to a lolin_s2_mini, with one or more
    (offset, file) pairs. The IDE's invocation is:

        esptool --chip esp32s2 --port <port> --baud 921600 \\
            --before default_reset --after hard_reset \\
            write_flash -z \\
            --flash_mode keep --flash_freq keep --flash_size keep \\
            0x1000 boot.bin 0x8000 part.bin 0xe000 boot_app0.bin 0x10000 app.bin

    `--flash_mode/freq/size keep` is what lets us flash only the app
    partition without clobbering the bootloader's QIO/80m header.
    """
    cmd = esptool_argv + [
        "--chip", "esp32s2",
        "--port", port,
        "--baud", "921600",
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


def run_esptool_flash(port: str, flash_pairs: list[tuple[str, Path]]) -> None:
    """Flash one or more (offset, file) pairs in a single esptool call.
    On the lolin_s2_mini's USB-CDC, auto-reset occasionally fails when
    the chip is in a weird state (e.g. mid-stream output from the user
    app); when that happens we prompt the operator to put the chip into
    ROM bootloader mode by hand and retry with --before no_reset."""
    esptool_argv = find_esptool()

    cmd = _build_esptool_cmd(esptool_argv, port, flash_pairs, before="default_reset")
    log("running: " + " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
        return
    except subprocess.CalledProcessError:
        log("esptool auto-reset failed -- common on lolin_s2_mini USB-CDC boards.")

    print(
        "\n"
        "  -----------------------------------------------------------\n"
        "  Manually enter the ROM bootloader on the receiver:\n"
        "    1. Press and HOLD the BOOT button on the receiver\n"
        "    2. While still holding BOOT, press and release RESET\n"
        "    3. Release BOOT\n"
        "  -----------------------------------------------------------\n",
        file=sys.stderr, flush=True,
    )
    input("  Press Enter once the receiver is in bootloader mode... ")

    cmd = _build_esptool_cmd(esptool_argv, port, flash_pairs, before="no_reset")
    log("retrying: " + " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        raise SystemExit(
            f"[flash_receiver] esptool failed again (exit {e.returncode}).\n"
            "  Things to try:\n"
            "    * Unplug and replug the receiver, then re-run this script.\n"
            "    * Make sure nothing else is holding the serial port\n"
            "      (Arduino IDE Serial Monitor, screen, etc.).\n"
            "    * Try a different USB cable / port (some cables are\n"
            "      power-only and don't carry data)."
        )


# ---------------------------------------------------------------------------
# Post-flash interaction over USB-CDC serial
# ---------------------------------------------------------------------------


def open_serial_with_retry(port: str, *, retries: int = 30, delay_s: float = 0.5) -> serial.Serial:
    """The lolin_s2_mini's USB-CDC re-enumerates after the post-flash reset,
    so the device path may briefly disappear or reject opens. Retry."""
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            ser = serial.Serial(port, baudrate=115200, timeout=0.5)
            return ser
        except (serial.SerialException, OSError) as e:
            last_err = e
            if attempt == 1 or attempt % 5 == 0:
                log(f"waiting for serial port {port} to come back (attempt {attempt})...")
            time.sleep(delay_s)
    raise SystemExit(f"[flash_receiver] could not open {port}: {last_err}")


def read_until(ser: serial.Serial, needle: str, timeout_s: float) -> str:
    """Read serial until `needle` appears or timeout. Returns accumulated text."""
    deadline = time.monotonic() + timeout_s
    buf = bytearray()
    while time.monotonic() < deadline:
        chunk = ser.read(256)
        if chunk:
            buf.extend(chunk)
            if needle.encode() in buf:
                return buf.decode(errors="replace")
        else:
            time.sleep(0.05)
    return buf.decode(errors="replace")


def read_until_any(ser: serial.Serial, needles: list[str], timeout_s: float) -> tuple[str, str | None]:
    """Like read_until() but matches the first of multiple needles. Returns
    (accumulated_text, matched_needle_or_None_on_timeout)."""
    deadline = time.monotonic() + timeout_s
    buf = bytearray()
    while time.monotonic() < deadline:
        chunk = ser.read(256)
        if chunk:
            buf.extend(chunk)
            for n in needles:
                if n.encode() in buf:
                    return buf.decode(errors="replace"), n
        else:
            time.sleep(0.05)
    return buf.decode(errors="replace"), None


# Match the receiver's boot banner line: "NODE_ID: <n>"
NODE_ID_BANNER_RE = re.compile(r"NODE_ID:\s*(\d+)")
IDENT_BANNER_RE   = re.compile(r"Ident:\s*(\S+)")


def read_boot_banner(ser: serial.Serial, *, timeout_s: float = 12.0) -> tuple[str, int | None, str | None]:
    """Wait for the boot banner. Looks for either the NODE_ID: line (which
    setup() prints early) or the UNPROVISIONED prompt. Returns
    (full_text, node_id_or_None, ident_or_None)."""
    text, _ = read_until_any(ser, ["UNPROVISIONED", "SUCCESS: Receiver started"], timeout_s)
    sys.stdout.write(text)
    sys.stdout.flush()
    node_match  = NODE_ID_BANNER_RE.search(text)
    ident_match = IDENT_BANNER_RE.search(text)
    node_id = int(node_match.group(1)) if node_match else None
    ident   = ident_match.group(1)     if ident_match else None
    return text, node_id, ident


def send_setid_and_confirm(ser: serial.Serial, node_id: int, ident: str, port: str) -> None:
    """Send SETID, wait for OK, wait for restart, confirm new identity."""
    cmd = f"SETID {node_id} {ident}\n".encode()
    log(f"sending: {cmd.decode().strip()}")
    ser.write(cmd)
    ser.flush()

    ack_text, matched = read_until_any(
        ser, ["OK SETID", "ERR SETID"], timeout_s=5.0
    )
    sys.stdout.write(ack_text)
    sys.stdout.flush()
    if matched != "OK SETID":
        ser.close()
        raise SystemExit("[flash_receiver] receiver did not acknowledge SETID.")

    ser.close()
    log("receiver acknowledged SETID, waiting for restart...")
    time.sleep(1.0)
    ser2 = open_serial_with_retry(port)
    confirm_text, confirmed_id, confirmed_ident = read_boot_banner(ser2, timeout_s=12.0)
    ser2.close()

    if confirmed_id == node_id and confirmed_ident == ident:
        log(f"SUCCESS -- receiver is now NODE_ID={node_id} IDENT={ident}")
    else:
        log(
            f"WARNING: post-restart banner didn't fully confirm identity "
            f"(saw NODE_ID={confirmed_id} IDENT={confirmed_ident}). Verify manually."
        )


def post_flash_confirm_identity(port: str) -> tuple[int | None, str | None]:
    """Open serial after a default (app-only) flash, read the boot banner,
    return what NODE_ID/IDENT the receiver claims."""
    log(f"opening {port} to read post-flash boot banner...")
    ser = open_serial_with_retry(port)
    try:
        _, node_id, ident = read_boot_banner(ser, timeout_s=12.0)
    finally:
        ser.close()
    return node_id, ident


def post_flash_provision(port: str, node_id: int, ident: str) -> None:
    """Open serial after a --full flash, expect UNPROVISIONED banner, send
    SETID, confirm restart with new identity."""
    log(f"opening {port} to provision NODE_ID={node_id} IDENT={ident}...")
    ser = open_serial_with_retry(port)

    log("waiting for receiver boot banner...")
    text, node_id_seen, _ = read_boot_banner(ser, timeout_s=12.0)
    if "UNPROVISIONED" not in text and node_id_seen != 0:
        log(
            "WARNING: didn't see the UNPROVISIONED banner after a --full flash. "
            "Sending SETID anyway."
        )

    send_setid_and_confirm(ser, node_id, ident, port)


def post_flash_reprovision(port: str, node_id: int, ident: str) -> None:
    """For --set-id without --full. Wait for the boot banner (chip already
    has firmware), then send SETID."""
    log(f"opening {port} to re-provision as NODE_ID={node_id} IDENT={ident}...")
    ser = open_serial_with_retry(port)

    log("waiting for receiver boot banner...")
    read_boot_banner(ser, timeout_s=12.0)

    send_setid_and_confirm(ser, node_id, ident, port)


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
        help="path to a specific app .bin (default: latest in os4_receiver/bin/). "
             "Ignored in --full mode (which always uses the matching v<N>.* set).",
    )
    p.add_argument("--port", help="serial port (default: prompt)")

    mode = p.add_mutually_exclusive_group()
    mode.add_argument(
        "--full", action="store_true",
        help="first-time flash: bootloader + partitions + boot_app0 + app, all "
             "in one esptool call (mirrors the IDE's first upload). Naturally "
             "preserves NVS. Prompts for receiver number and runs SETID after.",
    )
    mode.add_argument(
        "--set-id", dest="set_id", action="store_true",
        help="app-only flash followed by an interactive SETID. Re-provisions "
             "the receiver without wiping the rest of NVS.",
    )

    p.add_argument("--node", type=int, help="receiver NODE_ID (1-254). Skips the prompt for --full / --set-id.")
    p.add_argument("--ident", help="receiver ident string (default: RX<node>). Skips the prompt for --full / --set-id.")
    return p.parse_args()


def collect_identity_prompts(args: argparse.Namespace) -> tuple[int, str]:
    node_id = args.node if args.node is not None else prompt_node_id()
    if not (1 <= node_id <= 254):
        raise SystemExit(f"[flash_receiver] node_id out of range: {node_id}")
    ident = args.ident or prompt_ident(default=f"RX{node_id}")
    return node_id, ident


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
        flash_pairs_dict = find_latest_full_set()
        flash_pairs = [
            (OFFSET_BOOTLOADER, flash_pairs_dict[OFFSET_BOOTLOADER]),
            (OFFSET_PARTITIONS, flash_pairs_dict[OFFSET_PARTITIONS]),
            (OFFSET_BOOT_APP0,  flash_pairs_dict[OFFSET_BOOT_APP0]),
            (OFFSET_APP,        flash_pairs_dict[OFFSET_APP]),
        ]
        log("FULL flash (preserves NVS in the 0x9000-0xdfff gap):")
        for off, p in flash_pairs:
            log(f"  {off}  {_format_bin_label(p)}")
    else:
        app_bin = args.bin if args.bin else find_latest_app_bin()
        app_bin = app_bin.resolve()
        if not app_bin.is_file():
            err(f"binary not found: {app_bin}")
            return 1

        # Always re-stamp boot_app0 alongside the app. boot_app0 is the
        # OTA "next-app" pointer at 0xe000; if the receiver's last boot
        # was an OTA, that pointer is set to app1, and an app-only flash
        # to app0 (0x10000) would silently keep booting the OTA'd image
        # in app1. Re-flashing boot_app0 forces "boot app0", so the chip
        # always boots whatever we just wrote. The NVS gap (0x9000-0xdfff)
        # sits below 0xe000 and is unaffected.
        boot_app0 = find_boot_app0_for(app_bin)
        flash_pairs = [(OFFSET_APP, app_bin)]
        if boot_app0 is not None:
            flash_pairs.insert(0, (OFFSET_BOOT_APP0, boot_app0))
            log(f"app + boot_app0 flash (preserves NVS): {_format_bin_label(app_bin)}")
            log(f"  also restamping {_format_bin_label(boot_app0)} at {OFFSET_BOOT_APP0}")
        else:
            log(
                "WARNING: no boot_app0.bin found next to the app binary or at "
                "bin/latest.boot_app0.bin -- skipping the OTA-pointer reset. "
                "If the receiver was last flashed via OTA, it may keep booting "
                "the previous image. Re-run devices/utils/build_receiver.sh "
                "to regenerate boot_app0.bin."
            )
            log(f"app-only flash (preserves NVS): {_format_bin_label(app_bin)}")

    port = args.port or prompt_port()
    log(f"using port: {port}")

    if args.full:
        node_id, ident = collect_identity_prompts(args)
        run_esptool_flash(port, flash_pairs)
        # A first-time flash leaves the chip with a fresh (empty) NVS,
        # so it boots into UNPROVISIONED mode and we send SETID.
        post_flash_provision(port, node_id, ident)
        return 0

    if args.set_id:
        node_id, ident = collect_identity_prompts(args)
        run_esptool_flash(port, flash_pairs)
        post_flash_reprovision(port, node_id, ident)
        return 0

    # Default: app-only flash, no provisioning. Confirm post-flash that
    # the chip's preserved identity is intact.
    run_esptool_flash(port, flash_pairs)
    seen_id, seen_ident = post_flash_confirm_identity(port)

    if seen_id is None:
        log(
            "WARNING: didn't see NODE_ID in the boot banner. The receiver may "
            "not have started cleanly (corrupt partition table?). Try:\n"
            "        flash_receiver.py --full"
        )
        return 0

    if seen_id == 0:
        log(
            "WARNING: receiver came up UNPROVISIONED (NODE_ID=0). "
            "Provision it without wiping NVS again with:\n"
            "        flash_receiver.py --set-id"
        )
        return 0

    log(f"SUCCESS -- receiver preserved identity: NODE_ID={seen_id} IDENT={seen_ident}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
