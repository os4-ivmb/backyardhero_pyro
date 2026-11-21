#!/usr/bin/env python3
"""flash_omni.py -- flash a BYH Omni. Mirrors the Arduino IDE's
flash invocation byte-for-byte, with post-flash NODE_ID, ident, and hardware
board-version provisioning over serial.

Four modes:

    flash_omni.py
        Default. Writes the app at 0x10000 AND re-stamps the OTA
        next-app pointer (boot_app0.bin at 0xe000), so the chip is
        guaranteed to boot what we just wrote -- even if the previous
        run was an OTA that left the bootloader pointing at app1.
        PRESERVES NVS, so the omni's NODE_ID / RECEIVER_IDENT carry
        through every routine firmware bump.

    flash_omni.py --full
        First-time flash: bootloader + partition table + boot_app0 + app,
        all in one esptool invocation -- the same four-file layout the
        IDE writes when it pushes a fresh build. Naturally preserves NVS
        because the default ESP32-S2 partition table puts NVS at
        0x9000-0xdfff, sandwiched between partitions (0x8000-0x8fff)
        and boot_app0 (0xe000-0xffff), and we don't write anything in
        that gap. Auto-prompts for omni number and runs SETID over
        serial afterwards, including the hardware board version. Use for a
        brand-new chip or for recovery.

    flash_omni.py --set-id
        Same flash as default (app + boot_app0), then an interactive
        SETID. Reconfigures an omni's identity and board version without
        wiping anything else in NVS.

    flash_omni.py --set-board
        Does not flash anything. Prompts for the hardware board version, sends
        SETBOARD over serial, and verifies the value after the omni restarts.

`--node N`, `--ident NAME`, and `--board-version N` skip the prompts.

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

def _venv_paths(venv_dir: Path) -> tuple[Path, Path]:
    """Return (python, pip) inside a venv. Windows puts these under
    Scripts\\*.exe; POSIX puts them under bin/."""
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe", venv_dir / "Scripts" / "pip.exe"
    return venv_dir / "bin" / "python3", venv_dir / "bin" / "pip"


def _same_path(a: str, b: str) -> bool:
    # Windows paths are case-insensitive and may differ in casing/slashes.
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def _ensure_venv() -> None:
    script_dir = Path(__file__).resolve().parent
    venv_dir = script_dir / ".venv"
    venv_python, venv_pip = _venv_paths(venv_dir)
    requirements = script_dir / "requirements.txt"

    # Already running under our venv -> everything should import.
    if _same_path(sys.executable, str(venv_python)):
        try:
            import serial  # noqa: F401
            return
        except ImportError:
            # Requirements changed since the venv was built; reinstall.
            print(
                "[flash_omni] dependencies changed -- updating .venv...",
                file=sys.stderr,
            )
            subprocess.run(
                [str(venv_pip), "install", "-q", "-r", str(requirements)],
                check=True,
            )
            os.execv(str(venv_python), [str(venv_python), __file__, *sys.argv[1:]])

    # Outside venv. If the host Python already has pyserial (rare on
    # macOS, normal on Linux, common on Windows if installed manually),
    # just use it directly.
    try:
        import serial  # noqa: F401
        return
    except ImportError:
        pass

    # First-run bootstrap.
    if not venv_python.exists():
        print(
            f"[flash_omni] creating venv at {venv_dir} (one-time setup)...",
            file=sys.stderr,
        )
        subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
        print("[flash_omni] installing dependencies...", file=sys.stderr)
        subprocess.run(
            [str(venv_pip), "install", "-q", "-r", str(requirements)],
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
SKETCH_DIR = (SCRIPT_DIR / ".." / "byh_omni").resolve()
BIN_DIR = SKETCH_DIR / "bin"

# Per-version artifact filenames produced by build_omni.sh:
#   byh_omni_v<N>.bin             -- app, flashed at 0x10000
#   byh_omni_v<N>.bootloader.bin  -- chip bootloader, flashed at 0x1000
#   byh_omni_v<N>.partitions.bin  -- partition table, flashed at 0x8000
#   byh_omni_v<N>.boot_app0.bin   -- OTA next-app pointer, flashed at 0xe000
APP_BIN_RE = re.compile(r"^byh_omni_v(\d+)\.bin$")

# Standard arduino-esp32 layout for lolin_s2_mini (default partition
# table). NVS lives at 0x9000-0xdfff, in the gap between PARTITIONS and
# BOOT_APP0 -- writing only these four regions naturally preserves it.
OFFSET_BOOTLOADER = "0x1000"
OFFSET_PARTITIONS = "0x8000"
OFFSET_BOOT_APP0  = "0xe000"
OFFSET_APP        = "0x10000"


def log(msg: str) -> None:
    print(f"[flash_omni] {msg}", flush=True)


def err(msg: str) -> None:
    print(f"[flash_omni] ERROR: {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Bin selection
# ---------------------------------------------------------------------------


def _latest_app_bin() -> tuple[int, Path]:
    """Return (version, path) of the highest-versioned app binary."""
    if not BIN_DIR.is_dir():
        raise SystemExit(
            f"[flash_omni] no bin dir at {BIN_DIR} -- run build_omni.sh first."
        )

    candidates: list[tuple[int, float, Path]] = []
    for p in BIN_DIR.iterdir():
        m = APP_BIN_RE.match(p.name)
        if not m:
            continue
        candidates.append((int(m.group(1)), p.stat().st_mtime, p))

    if not candidates:
        raise SystemExit(
            f"[flash_omni] no byh_omni_v*.bin found in {BIN_DIR}.\n"
            "  Run devices/utils/build_omni.sh first."
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
      1. If `app_bin` matches the build_omni.sh naming convention
         (`byh_omni_v<N>.bin`), look for `byh_omni_v<N>.boot_app0.bin`
         next to it. This is the version-matched artifact.
      2. Otherwise fall back to `bin/latest.boot_app0.bin` -- the
         build_omni.sh symlink. boot_app0.bin is byte-for-byte
         identical across versions (it's the static "boot from app0"
         pointer copied straight out of the arduino-esp32 install), so
         using `latest` is safe even if the user passed `--bin` to a
         hand-renamed file.
      3. If neither exists, return None and let the caller decide whether
         to skip the boot_app0 flash.
    """
    m = APP_BIN_RE.match(app_bin.name)
    if m:
        sibling = app_bin.parent / f"byh_omni_v{m.group(1)}.boot_app0.bin"
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
    bl = BIN_DIR / f"byh_omni_v{version}.bootloader.bin"
    pt = BIN_DIR / f"byh_omni_v{version}.partitions.bin"
    ba = BIN_DIR / f"byh_omni_v{version}.boot_app0.bin"
    missing = [p for p in (bl, pt, ba) if not p.is_file()]
    if missing:
        raise SystemExit(
            f"[flash_omni] FULL flash needs all four v{version} artifacts; missing:\n  "
            + "\n  ".join(str(p) for p in missing)
            + "\n  Re-run devices/utils/build_omni.sh to regenerate them."
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
        raise SystemExit(f"[flash_omni] invalid choice: {raw}")
    return raw


# ---------------------------------------------------------------------------
# Omni identity prompt
# ---------------------------------------------------------------------------


def prompt_node_id() -> int:
    while True:
        raw = input("Omni number (1-65535): ").strip()
        if not raw.isdigit():
            print("  must be an integer")
            continue
        n = int(raw)
        if 1 <= n <= 65535:
            return n
        print("  out of range (1-65535)")


def prompt_ident(default: str) -> str:
    raw = input(f"Omni ident [default {default}]: ").strip()
    if not raw:
        return default
    if len(raw) > 8:
        raise SystemExit("[flash_omni] ident too long (max 8 chars).")
    if " " in raw:
        raise SystemExit("[flash_omni] ident must not contain spaces.")
    return raw


def prompt_board_version(default: int = 10) -> int:
    while True:
        raw = input(f"Omni board version [default {default}]: ").strip()
        if not raw:
            return default
        if raw.isdigit() and 1 <= int(raw) <= 255:
            return int(raw)
        print("  must be an integer from 1-255")


# ---------------------------------------------------------------------------
# esptool flash
# ---------------------------------------------------------------------------


def _arduino_data_dirs() -> list[Path]:
    """Candidate arduino-cli / Arduino IDE data directories, per-OS.

      * macOS:   ~/Library/Arduino15
      * Linux:   ~/.arduino15
      * Windows: %LOCALAPPDATA%\\Arduino15
    """
    home = Path.home()
    dirs = [home / "Library" / "Arduino15", home / ".arduino15"]
    localappdata = os.environ.get("LOCALAPPDATA")
    if localappdata:
        dirs.append(Path(localappdata) / "Arduino15")
    return dirs


def find_esptool() -> list[str]:
    """Return the argv prefix for invoking esptool, in priority order:

      1. The Arduino-bundled esptool (<arduino-data>/packages/esp32/
         tools/esptool_py/<ver>/esptool[.exe]). This is the EXACT binary
         the Arduino IDE shells out to when you hit Upload, so by
         definition it's the one we know works on this machine. Its
         USB-CDC reset handling for ESP32-S2 boards is what we inherit.
      2. The venv-installed esptool (requirements.txt installs >=4.9).
         Used if arduino-cli isn't installed and the IDE has never run.
      3. esptool.py / esptool on PATH (likely brew, possibly old).
    """
    for data_dir in _arduino_data_dirs():
        arduino_pkg = data_dir / "packages" / "esp32" / "tools" / "esptool_py"
        if not arduino_pkg.is_dir():
            continue
        for v in sorted(arduino_pkg.iterdir(), reverse=True):
            for cand in (v / "esptool.exe", v / "esptool", v / "esptool.py"):
                # os.access(..., X_OK) is effectively always true for
                # existing files on Windows, so existence is the real
                # gate there; on POSIX it correctly filters non-exes.
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
        "[flash_omni] ERROR: esptool not found.\n"
        "  Install the Arduino IDE's ESP32 core, or:\n"
        "    rm -rf devices/utils/.venv && ./flash_omni.py --help"
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

    On the lolin_s2_mini's USB-CDC, auto-reset frequently fails on the
    first try even when the chip is perfectly happy to be flashed. The
    sequence below tries to avoid bothering the operator with a manual
    BOOT+RESET prompt unless it's actually necessary:

      1. --before default_reset       (the normal auto-reset path)
      2. --before no_reset            (silent retry -- empirically the
         chip is often already sitting in a download-ready state after
         a "failed" default_reset; this catches that case without any
         operator interaction)
      3. --before no_reset AFTER prompting for a manual BOOT+RESET.
    """
    esptool_argv = find_esptool()

    cmd = _build_esptool_cmd(esptool_argv, port, flash_pairs, before="default_reset")
    log("running: " + " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
        return
    except subprocess.CalledProcessError:
        log("esptool auto-reset failed -- common on lolin_s2_mini USB-CDC boards.")

    log("retrying once with --before no_reset before asking for manual BOOT+RESET...")
    time.sleep(1.0)
    cmd_noreset = _build_esptool_cmd(esptool_argv, port, flash_pairs, before="no_reset")
    log("running: " + " ".join(cmd_noreset))
    try:
        subprocess.run(cmd_noreset, check=True)
        return
    except subprocess.CalledProcessError:
        log("silent no_reset retry also failed -- falling back to manual prompt.")

    print(
        "\n"
        "  -----------------------------------------------------------\n"
        "  Manually enter the ROM bootloader on the omni:\n"
        "    1. Press and HOLD the BOOT button on the omni\n"
        "    2. While still holding BOOT, press and release RESET\n"
        "    3. Release BOOT\n"
        "  -----------------------------------------------------------\n",
        file=sys.stderr, flush=True,
    )
    input("  Press Enter once the omni is in bootloader mode... ")

    log("retrying: " + " ".join(cmd_noreset))
    try:
        subprocess.run(cmd_noreset, check=True)
    except subprocess.CalledProcessError as e:
        raise SystemExit(
            f"[flash_omni] esptool failed again (exit {e.returncode}).\n"
            "  Things to try:\n"
            "    * Unplug and replug the omni, then re-run this script.\n"
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
    raise SystemExit(f"[flash_omni] could not open {port}: {last_err}")


def read_until_any(ser: serial.Serial, needles: list[str], timeout_s: float) -> tuple[str, str | None]:
    """Read serial until the first of `needles` appears. Returns
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


# Replies to the GETID / GETRF provisioning commands. Anchored to a line
# start so "OK SETID NODE_ID=..." (the pre-restart ack) never matches.
GETID_RE = re.compile(r"(?m)^NODE_ID=(\d+) IDENT=(\S*) BOARD_VERSION=(\d+)")
GETRF_RE = re.compile(r"(?m)^RF_CHANNEL=(\d+) RF_SYSTEM_ID=(\d+)")


def poll_command(
    port: str,
    command: str,
    reply_re: re.Pattern[str],
    *,
    timeout_s: float = 20.0,
    resend_s: float = 1.0,
) -> re.Match[str] | None:
    """Send `command` over serial every `resend_s` until a line matching
    `reply_re` comes back, or `timeout_s` passes.

    We used to wait for the omni's one-shot boot banner instead, but that
    banner is printed ~100ms after reset -- before the host has re-opened
    the re-enumerated USB-CDC port -- so it was usually lost. Whether a
    late part of it still arrived depended on what was plugged in: with a
    cue module the receiver's LED tests delay "SUCCESS: Omni started"
    long enough to be seen; with nothing on the cue header the
    board-count ADC reads high, the omni boots in dongle role, and that
    path never prints UNPROVISIONED / SUCCESS at all. GETID / GETRF are
    answered in every role (receiver loop and the dongle's provisioning
    hook), so asking is reliable where listening wasn't.
    """
    deadline = time.monotonic() + timeout_s
    ser: serial.Serial | None = None
    buf = ""
    next_send = 0.0
    try:
        while time.monotonic() < deadline:
            if ser is None:
                ser = open_serial_with_retry(port)
            try:
                now = time.monotonic()
                if now >= next_send:
                    ser.write(f"\n{command}\n".encode())
                    ser.flush()
                    next_send = now + resend_s
                chunk = ser.read(256)
            except (serial.SerialException, OSError):
                # Port vanished mid-poll (chip still re-enumerating): reopen.
                try:
                    ser.close()
                except Exception:
                    pass
                ser = None
                time.sleep(0.5)
                continue
            if chunk:
                text = chunk.decode(errors="replace")
                sys.stdout.write(text)
                sys.stdout.flush()
                buf = (buf + text)[-4096:]
                m = reply_re.search(buf)
                if m:
                    return m
    finally:
        if ser is not None:
            ser.close()
    return None


def wait_for_identity(port: str, *, timeout_s: float = 20.0) -> tuple[int, str, int] | None:
    """Poll GETID until the omni answers. Returns (node_id, ident,
    board_version), or None on timeout. node_id 0 = unprovisioned."""
    log(f"waiting for omni on {port} to answer GETID...")
    m = poll_command(port, "GETID", GETID_RE, timeout_s=timeout_s)
    if m is None:
        return None
    return int(m.group(1)), m.group(2), int(m.group(3))


def _send_restarting_command(port: str, command: str, ok: str, err_tag: str) -> None:
    """Send a provisioning command that saves to NVS and restarts the omni.
    Exits if the omni does not acknowledge it."""
    ser = open_serial_with_retry(port)
    try:
        log(f"sending: {command}")
        ser.write(f"\n{command}\n".encode())
        ser.flush()
        ack_text, matched = read_until_any(ser, [ok, err_tag], timeout_s=5.0)
        sys.stdout.write(ack_text)
        sys.stdout.flush()
    finally:
        ser.close()
    if matched != ok:
        raise SystemExit(f"[flash_omni] omni did not acknowledge {command.split()[0]}.")
    log(f"omni acknowledged {command.split()[0]}, waiting for restart...")
    time.sleep(1.5)


def _require_alive(port: str) -> tuple[int, str, int]:
    seen = wait_for_identity(port)
    if seen is None:
        raise SystemExit(
            f"[flash_omni] omni on {port} never answered GETID.\n"
            "  Check the port, close any other serial monitor, and replug the omni."
        )
    return seen


def send_setid_and_confirm(port: str, node_id: int, ident: str, board_version: int | None = None) -> None:
    """Send SETID, optionally including board version, then confirm with GETID
    after the restart."""
    board_arg = f" {board_version}" if board_version is not None else ""
    _send_restarting_command(port, f"SETID {node_id} {ident}{board_arg}", "OK SETID", "ERR SETID")

    seen = wait_for_identity(port)
    if seen is None:
        log("WARNING: omni didn't answer GETID after restart. Verify manually.")
        return
    seen_id, seen_ident, seen_board = seen
    board_ok = board_version is None or seen_board == board_version
    if seen_id == node_id and seen_ident == ident and board_ok:
        log(f"SUCCESS -- omni is now NODE_ID={node_id} IDENT={ident} BOARD_VERSION={seen_board}")
    else:
        log(
            f"WARNING: omni reports NODE_ID={seen_id} IDENT={seen_ident} "
            f"BOARD_VERSION={seen_board} after restart. Verify manually."
        )


def set_board_version_and_confirm(port: str, board_version: int) -> None:
    """Set only the persisted hardware board version and verify the restart."""
    _require_alive(port)
    _send_restarting_command(port, f"SETBOARD {board_version}", "OK SETBOARD", "ERR SETBOARD")
    seen = wait_for_identity(port)
    seen_board = seen[2] if seen else None
    if seen_board == board_version:
        log(f"SUCCESS -- omni BOARD_VERSION={board_version}")
    else:
        log(
            f"WARNING: omni reported BOARD_VERSION={seen_board} after restart; "
            f"expected {board_version}. Verify manually."
        )


def set_rf_and_confirm(port: str, channel: int, system_id: int) -> None:
    """Store the RF channel / system ID (SETRF, firmware with T26) and check
    them with GETRF after the restart. They must match the dongle's
    `rf_channel` / `rf_system_id`, or the omni becomes unreachable."""
    if not (0 <= channel <= 125) or not (0 <= system_id <= 255):
        raise SystemExit("[flash_omni] --rf needs channel 0-125 and system id 0-255")
    _require_alive(port)
    _send_restarting_command(
        port, f"SETRF {channel} {system_id}", "OK SETRF", "ERR SETRF"
    )
    m = poll_command(port, "GETRF", GETRF_RE)
    if m and int(m.group(1)) == channel and int(m.group(2)) == system_id:
        log(f"SUCCESS -- omni RF_CHANNEL={channel} RF_SYSTEM_ID={system_id}")
    else:
        log("WARNING: could not confirm the RF settings with GETRF. Verify manually.")


def post_flash_confirm_identity(port: str) -> tuple[int | None, str | None, int | None]:
    """After a default (app-only) flash, ask the omni what NODE_ID / IDENT /
    board version it has."""
    seen = wait_for_identity(port)
    if seen is None:
        return None, None, None
    return seen


def post_flash_provision(port: str, node_id: int, ident: str, board_version: int) -> None:
    """After a --full or --set-id flash: wait for the omni to answer, then
    send SETID and confirm the new identity after the restart."""
    seen_id, seen_ident, _ = _require_alive(port)
    log(f"omni is up (currently NODE_ID={seen_id} IDENT={seen_ident or '-'}); provisioning...")
    send_setid_and_confirm(port, node_id, ident, board_version)



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
        help="path to a specific app .bin (default: latest in byh_omni/bin/). "
             "Ignored in --full mode (which always uses the matching v<N>.* set).",
    )
    p.add_argument("--port", help="serial port (default: prompt)")

    mode = p.add_mutually_exclusive_group()
    mode.add_argument(
        "--full", action="store_true",
        help="first-time flash: bootloader + partitions + boot_app0 + app, all "
             "in one esptool call (mirrors the IDE's first upload). Naturally "
             "preserves NVS. Prompts for omni and board versions, then runs SETID.",
    )
    mode.add_argument(
        "--set-id", dest="set_id", action="store_true",
        help="app-only flash followed by an interactive SETID. Re-provisions "
             "identity and board version without wiping the rest of NVS.",
    )
    mode.add_argument(
        "--set-board", dest="set_board", action="store_true",
        help="do not flash; only set the omni hardware board version in NVS.",
    )

    p.add_argument("--node", type=int, help="omni NODE_ID (1-65535). Skips the prompt for --full / --set-id.")
    p.add_argument("--ident", help="omni ident string (default: RX<node>). Skips the prompt for --full / --set-id.")
    mode.add_argument(
        "--set-rf", action="store_true",
        help="do not flash; only store the RF channel / system ID given with --rf.",
    )
    p.add_argument(
        "--rf", nargs=2, type=int, metavar=("CHANNEL", "SYSTEM_ID"),
        help="RF channel (0-125) and system ID (0-255) to store after flashing "
             "(or alone with --set-rf). Must match the dongle. Default: leave unchanged "
             "(85 / 0 on a fresh omni).",
    )
    p.add_argument(
        "--board-version", type=int,
        help="omni hardware board version (1-255). Skips the prompt for --full / --set-id / --set-board.",
    )
    return p.parse_args()


def collect_identity_prompts(args: argparse.Namespace) -> tuple[int, str, int]:
    node_id = args.node if args.node is not None else prompt_node_id()
    if not (1 <= node_id <= 65535):
        raise SystemExit(f"[flash_omni] node_id out of range: {node_id}")
    ident = args.ident or prompt_ident(default=f"RX{node_id}")
    if len(ident) > 8 or " " in ident:
        raise SystemExit(f"[flash_omni] ident must be at most 8 chars with no spaces: {ident!r}")
    board_version = (
        args.board_version
        if args.board_version is not None
        else prompt_board_version()
    )
    if not (1 <= board_version <= 255):
        raise SystemExit(f"[flash_omni] board version out of range: {board_version}")
    return node_id, ident, board_version


def _format_bin_label(p: Path) -> str:
    try:
        return str(p.relative_to(Path.cwd()))
    except ValueError:
        return str(p)


def main() -> int:
    args = parse_args()
    if args.set_rf:
        if not args.rf:
            raise SystemExit("[flash_omni] --set-rf needs --rf CHANNEL SYSTEM_ID")
        port = args.port or prompt_port()
        set_rf_and_confirm(port, args.rf[0], args.rf[1])
        return 0
    rc = _main(args)
    if rc == 0 and args.rf:
        set_rf_and_confirm(args.port or prompt_port(), args.rf[0], args.rf[1])
    return rc


def _main(args: argparse.Namespace) -> int:

    if args.set_board:
        board_version = (
            args.board_version
            if args.board_version is not None
            else prompt_board_version()
        )
        if not (1 <= board_version <= 255):
            raise SystemExit(f"[flash_omni] board version out of range: {board_version}")
        port = args.port = args.port or prompt_port()
        set_board_version_and_confirm(port, board_version)
        return 0

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
        # OTA "next-app" pointer at 0xe000; if the omni's last boot
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
                "If the omni was last flashed via OTA, it may keep booting "
                "the previous image. Re-run devices/utils/build_omni.sh "
                "to regenerate boot_app0.bin."
            )
            log(f"app-only flash (preserves NVS): {_format_bin_label(app_bin)}")

    port = args.port = args.port or prompt_port()
    log(f"using port: {port}")

    if args.full:
        node_id, ident, board_version = collect_identity_prompts(args)
        run_esptool_flash(port, flash_pairs)
        # Send SETID with the hardware board version in one
        # transaction/restart once the omni answers GETID.
        post_flash_provision(port, node_id, ident, board_version)
        return 0

    if args.set_id:
        node_id, ident, board_version = collect_identity_prompts(args)
        run_esptool_flash(port, flash_pairs)
        post_flash_provision(port, node_id, ident, board_version)
        return 0

    # Default: app-only flash, no provisioning. Confirm post-flash that
    # the chip's preserved identity is intact.
    run_esptool_flash(port, flash_pairs)
    seen_id, seen_ident, seen_board_version = post_flash_confirm_identity(port)

    if seen_id is None:
        log(
            "WARNING: omni never answered GETID after flashing. It may "
            "not have started cleanly (corrupt partition table?). Try:\n"
            "        flash_omni.py --full"
        )
        return 0

    if seen_id == 0:
        log(
            "WARNING: omni came up UNPROVISIONED (NODE_ID=0). "
            "Provision it without wiping NVS again with:\n"
            "        flash_omni.py --set-id"
        )
        return 0

    log(
        f"SUCCESS -- omni preserved configuration: NODE_ID={seen_id} "
        f"IDENT={seen_ident} BOARD_VERSION={seen_board_version}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
