#!/usr/bin/env python3
"""set_node_id.py -- assign a NODE_ID + ident to a connected receiver
without re-flashing.

Talks to the receiver's serial port and sends the same `SETID` command
the firmware accepts at any time (see the v14 notes in
devices/os4_receiver/os4_receiver.ino). The chip writes the new identity
to NVS and reboots; this script confirms the new boot banner.

Use this when you want to:
    * Assign an ID to a unit that booted UNPROVISIONED for any reason.
    * Renumber a unit in the field without re-flashing firmware.
    * Sanity-check what NODE_ID a receiver currently holds (--get).

For first-time provisioning right after a flash, the same logic is built
into `flash_receiver.py --full` and `flash_receiver.py --set-id`; reach
for this script when the chip already has working firmware and you just
need to talk to it.

Usage:
    set_node_id.py                       # prompts for everything
    set_node_id.py --node 146            # ident defaults to RX146
    set_node_id.py --node 146 --ident RX146 --port /dev/cu.usbmodem01
    set_node_id.py --get                 # just print the current NODE_ID
    set_node_id.py --wipe                # clear NVS identity (back to UNPROVISIONED)

Dependencies (pyserial) install automatically into devices/utils/.venv on
first run -- no manual pip install needed.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Self-bootstrapping venv (mirrors the logic in flash_receiver.py so this
# script is independently runnable even if flash_receiver isn't around).
# ---------------------------------------------------------------------------

def _venv_paths(venv_dir: Path) -> tuple[Path, Path]:
    """Return (python, pip) inside a venv. Windows uses Scripts\\*.exe,
    POSIX uses bin/."""
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe", venv_dir / "Scripts" / "pip.exe"
    return venv_dir / "bin" / "python3", venv_dir / "bin" / "pip"


def _same_path(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def _ensure_venv() -> None:
    script_dir = Path(__file__).resolve().parent
    venv_dir = script_dir / ".venv"
    venv_python, venv_pip = _venv_paths(venv_dir)
    requirements = script_dir / "requirements.txt"

    if _same_path(sys.executable, str(venv_python)):
        try:
            import serial  # noqa: F401
            return
        except ImportError:
            print("[set_node_id] dependencies changed -- updating .venv...", file=sys.stderr)
            subprocess.run(
                [str(venv_pip), "install", "-q", "-r", str(requirements)],
                check=True,
            )
            os.execv(str(venv_python), [str(venv_python), __file__, *sys.argv[1:]])

    try:
        import serial  # noqa: F401
        return
    except ImportError:
        pass

    if not venv_python.exists():
        print(f"[set_node_id] creating venv at {venv_dir} (one-time setup)...", file=sys.stderr)
        subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
        print("[set_node_id] installing dependencies...", file=sys.stderr)
        subprocess.run(
            [str(venv_pip), "install", "-q", "-r", str(requirements)],
            check=True,
        )

    os.execv(str(venv_python), [str(venv_python), __file__, *sys.argv[1:]])


_ensure_venv()


# Reuse the prompt/serial helpers from flash_receiver. Importing it here
# triggers its own _ensure_venv(), but that's a no-op since we're already
# under the venv interpreter at this point.
import argparse  # noqa: E402
import time      # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from flash_receiver import (  # noqa: E402
    log,
    open_serial_with_retry,
    prompt_ident,
    prompt_node_id,
    prompt_port,
    read_boot_banner,
    read_until_any,
    send_setid_and_confirm,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--port", help="serial port (default: prompt)")

    mode = p.add_mutually_exclusive_group()
    mode.add_argument(
        "--get", action="store_true",
        help="just print the receiver's current NODE_ID + IDENT and exit (no writes).",
    )
    mode.add_argument(
        "--wipe", action="store_true",
        help="clear the NVS identity (back to UNPROVISIONED). Reboots the chip.",
    )

    p.add_argument("--node", type=int, help="receiver NODE_ID to set (1-254). Skips the prompt.")
    p.add_argument("--ident", help="receiver ident string (default: RX<node>). Skips the prompt.")
    p.add_argument(
        "--no-banner-wait", action="store_true",
        help="skip waiting for the boot banner before sending the command. "
             "Use when the chip is already running and you don't want to wait "
             "for a fresh reset.",
    )
    return p.parse_args()


def query_get_id(port: str) -> int:
    """Send GETID and print the response."""
    log(f"opening {port}...")
    ser = open_serial_with_retry(port)
    try:
        # Drain any pending output, then send GETID.
        ser.write(b"\nGETID\n")
        ser.flush()
        text, matched = read_until_any(ser, ["NODE_ID="], timeout_s=3.0)
        sys.stdout.write(text)
        sys.stdout.flush()
        if matched is None:
            log("WARNING: no GETID response within 3s. Is the receiver running v14+ firmware?")
            return 1
    finally:
        ser.close()
    return 0


def issue_wipe(port: str) -> int:
    log(f"opening {port} to wipe NVS identity...")
    ser = open_serial_with_retry(port)
    try:
        ser.write(b"\nWIPEID\n")
        ser.flush()
        text, matched = read_until_any(ser, ["OK WIPEID"], timeout_s=3.0)
        sys.stdout.write(text)
        sys.stdout.flush()
        if matched is None:
            log("WARNING: no WIPEID acknowledgement. Verify manually.")
            return 1
    finally:
        ser.close()

    # The chip restarts after WIPEID -- reopen and confirm UNPROVISIONED.
    log("waiting for restart...")
    time.sleep(1.0)
    ser2 = open_serial_with_retry(port)
    try:
        text, _, _ = read_boot_banner(ser2, timeout_s=12.0)
        if "UNPROVISIONED" in text:
            log("SUCCESS -- receiver is now UNPROVISIONED.")
        else:
            log("WARNING: post-wipe banner didn't show UNPROVISIONED. Verify manually.")
    finally:
        ser2.close()
    return 0


def issue_setid(port: str, node_id: int, ident: str, *, wait_banner: bool) -> int:
    log(f"opening {port} to set NODE_ID={node_id} IDENT={ident}...")
    ser = open_serial_with_retry(port)

    if wait_banner:
        # Wait for the boot banner so the firmware's main loop is up and
        # actively servicing serial commands. If the chip wasn't reset
        # right before this, the banner won't show up -- that's fine, the
        # SETID handler is live regardless.
        log("waiting briefly for boot banner (skip with --no-banner-wait)...")
        read_until_any(
            ser,
            ["UNPROVISIONED", "SUCCESS: Receiver started", "NODE_ID:"],
            timeout_s=5.0,
        )

    try:
        send_setid_and_confirm(ser, node_id, ident, port)
    except SystemExit as e:
        # send_setid_and_confirm raises SystemExit on no-ack; close cleanly.
        return int(e.code or 1)
    return 0


def main() -> int:
    args = parse_args()
    port = args.port or prompt_port()
    log(f"using port: {port}")

    if args.get:
        return query_get_id(port)

    if args.wipe:
        return issue_wipe(port)

    node_id = args.node if args.node is not None else prompt_node_id()
    if not (1 <= node_id <= 254):
        print(f"[set_node_id] ERROR: node_id out of range: {node_id}", file=sys.stderr)
        return 1
    ident = args.ident or prompt_ident(default=f"RX{node_id}")

    return issue_setid(port, node_id, ident, wait_banner=not args.no_banner_wait)


if __name__ == "__main__":
    sys.exit(main())
