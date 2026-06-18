"""HTTP flasher endpoint for the host-side TCP-to-serial bridge.

Why this lives in the bridge: the dongle's USB-CDC port is owned by the
bridge process. To flash the dongle from the UI we need the same hands
that drive the serial forwarder to release the port, run esptool, and
reopen the port -- doing this from a separate process would be a race
on /dev/byh_dongle.

Architecture:

    Browser ── POST /api/system/dongle_flash ──► Next.js
                                                  │
                                                  ▼
                                          /tmp/ota_staging/<job>/<kind>.bin
                                          /tmp/d_cmd/<ts>-dongle-flash.json
                                                  │
                                                  ▼
                                            Daemon (container)
                                                  │
                                  POST 9001/flash_dongle│ JSON paths
                                                  ▼
                                  ┌─────────────────────────┐
                                  │ flash_server (this file)│
                                  │  ── pause(serial)       │
                                  │  ── esptool subprocess  │
                                  │  ── resume(serial)      │
                                  └─────────────────────────┘
                                                  │
                                                  ▼
                                              dongle (USB-CDC)

API surface (all under 127.0.0.1:9001):

    POST /flash_dongle
        Body: {
            "mode": "app" | "full",
            "files": { "0x10000": "/path/app.bin", "0xe000": ... },
            "port":  optional override (defaults to bridge's current port)
        }
        Returns 202 with {"job_id": ...} on accept, 409 if a job is
        already in flight.

    GET /flash_dongle/status
        Returns the current snapshot dict (phase, pct, error, log_tail,
        ...). Always 200; phase=='idle' when no job has ever run.

    POST /flash_dongle/continue
        Operator has manually entered the bootloader (BOOT+RESET dance).
        The driver thread is parked in `needs_manual_reset`; this wakes
        it up to retry esptool with --before no_reset.

    POST /flash_dongle/abort
        Kill the in-flight esptool subprocess and tear down the job.
        The bridge's serial forwarders will auto-reconnect to whatever
        is on the port afterwards (works whether the abort succeeded
        cleanly or left the dongle in some half-flashed state).

Endpoint format chosen for simplicity: tiny stdlib http.server, no
streaming. The daemon polls /flash_dongle/status at ~5Hz; that's
plenty for a transfer that takes ~30s end to end.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Optional

# The shared esptool helpers live next to flash_dongle.py. Add the
# repo's devices/utils to sys.path so the bridge venv (which doesn't
# install dongle_flasher itself, only its deps) can import them.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEVICES_UTILS = _REPO_ROOT / "devices" / "utils"
if str(_DEVICES_UTILS) not in sys.path:
    sys.path.insert(0, str(_DEVICES_UTILS))

from dongle_flasher import (  # noqa: E402
    OFFSET_BOOTLOADER,
    OFFSET_PARTITIONS,
    OFFSET_BOOT_APP0,
    OFFSET_APP,
    APP_ONLY_OFFSETS,
    FULL_FLASH_OFFSETS,
    find_esptool,
    build_esptool_cmd,
)


# Listen address for the flasher HTTP API.
#
# This endpoint lets any caller start/abort dongle flash jobs (DoS at
# minimum, arbitrary-firmware flashing at worst), so it must NOT be
# exposed on the LAN / Wi-Fi AP interface (C4.1). We bind the same
# address as the :9000 forwarder via BYH_BRIDGE_BIND:
#
#   * Docker Desktop (mac/Windows): host.docker.internal forwards to the
#     host's loopback, so the default 127.0.0.1 bind works.
#   * Docker Engine on Linux (Raspberry Pi): host.docker.internal ->
#     host-gateway resolves to the docker bridge gateway IP (e.g.
#     172.17.0.1). The launcher (start.sh) sets BYH_BRIDGE_BIND to that
#     gateway so the container can reach us while wlan0 AP clients
#     cannot. A bare 127.0.0.1 bind would ECONNREFUSE the daemon there.
#
# Previously this bound 0.0.0.0, exposing 9001 to every AP client.
FLASH_HTTP_HOST = os.environ.get("BYH_BRIDGE_BIND", "127.0.0.1")
FLASH_HTTP_PORT = 9001

# Cap on log buffer kept in memory per job. esptool produces ~1KB of
# output for a routine flash; 4000 lines is plenty of headroom for the
# noisiest verbose-mode runs without letting a stuck loop eat RAM.
LOG_TAIL_LINES = 4000

# How long /flash_dongle/continue will wait for an operator before the
# job times out. 5 minutes is roomy enough for "find the dongle, mash
# BOOT+RESET, click the button" but short enough that a forgotten job
# doesn't keep the serial port hostage forever.
NEEDS_MANUAL_RESET_TIMEOUT_S = 300.0


# ---------------------------------------------------------------------------
# esptool stderr parsing
# ---------------------------------------------------------------------------

# esptool emits in-place progress with carriage returns:
#   "Writing at 0x00010000... (12 %)\r"
# We surface those as `phase=writing, pct=12` so the UI bar moves
# smoothly. Plain newlines (errors, "Hash of data verified.", etc.) are
# captured as log lines.
_RE_WRITING_PCT = re.compile(r"Writing at 0x([0-9a-fA-F]+)\s*\.\.\.\s*\((\d+)\s*%\)")
_RE_CONNECTING  = re.compile(r"Connecting\.\.\.")
_RE_CHIP_IS     = re.compile(r"Chip is ESP32")
_RE_VERIFY      = re.compile(r"Hash of data verified")
_RE_RESET       = re.compile(r"Hard resetting")
_RE_LEAVING     = re.compile(r"Leaving\.\.\.")


def _classify_line(line: str) -> tuple[str, dict]:
    """Map an esptool progress fragment to a (phase, extras) tuple.

    Returns ('', {}) when the line doesn't change the public phase.
    """
    if _RE_WRITING_PCT.search(line):
        m = _RE_WRITING_PCT.search(line)
        return "writing", {
            "current_offset": "0x" + m.group(1),
            "current_offset_pct": int(m.group(2)),
        }
    if _RE_CONNECTING.search(line):
        return "connecting", {}
    if _RE_CHIP_IS.search(line):
        return "preparing", {}
    if _RE_VERIFY.search(line):
        return "verifying", {}
    if _RE_LEAVING.search(line) or _RE_RESET.search(line):
        return "rebooting", {}
    return "", {}


# ---------------------------------------------------------------------------
# Job state
# ---------------------------------------------------------------------------

class FlashJob:
    """One in-flight (or finished) dongle flash.

    Lifecycle:
        idle -> preparing -> connecting -> preparing -> writing -> verifying
             -> rebooting -> done
        any -> needs_manual_reset (if auto-reset failed) -> writing ...
        any -> error | aborted

    Thread safety: every public attribute is read/written under
    `_lock`. Snapshots returned to HTTP clients are deep-ish copies.
    """

    PHASES = (
        "idle",
        "preparing",
        "connecting",
        "writing",
        "verifying",
        "rebooting",
        "needs_manual_reset",
        "done",
        "error",
        "aborted",
    )

    def __init__(self, job_id: str, mode: str, files: dict[str, str], file_names: dict[str, str]):
        self.job_id = job_id
        self.mode = mode  # "app" or "full"
        # offset (e.g. "0x10000") -> absolute path on host filesystem.
        self.files = files
        # offset -> displayed file name (for the UI). Same keys as files.
        self.file_names = file_names

        self._lock = threading.Lock()
        # Wakes the worker thread out of needs_manual_reset wait.
        self._continue_event = threading.Event()
        # Set to request a clean abort. The worker checks this between
        # phases and on subprocess output; it also kills the esptool
        # subprocess directly via _process.
        self._abort_event = threading.Event()
        self._process: Optional[subprocess.Popen] = None

        self.phase = "preparing"
        self.error: Optional[str] = None
        self.started_ms = int(time.time() * 1000)
        self.last_event_ms = self.started_ms
        self.ended_ms: Optional[int] = None
        # 0..100 across the whole job (averaged across written regions).
        self.overall_pct = 0
        # Current region being written; useful when full-flash mode is
        # bouncing between bootloader/partitions/app and the operator
        # wants to know which one is moving the bar.
        self.current_offset: Optional[str] = None
        self.current_offset_pct: int = 0
        # ring buffer of (timestamp, line) tuples for the UI log view.
        self.log_tail: deque[tuple[int, str]] = deque(maxlen=LOG_TAIL_LINES)
        # esptool exit code on completion (0 on success).
        self.exit_code: Optional[int] = None
        # Total bytes we asked esptool to write, summed across files.
        # Used to weight each region's pct into the overall_pct so the
        # bar advances ~linearly with wall-clock time.
        self.total_bytes = 0
        for path in files.values():
            try:
                self.total_bytes += os.path.getsize(path)
            except OSError:
                pass
        # Per-offset weighting. We cache size at job start so the
        # overall_pct math stays consistent even if the file is
        # rewritten mid-flash (which shouldn't happen, but defense in
        # depth).
        self._offset_sizes = {
            offset: (os.path.getsize(p) if os.path.isfile(p) else 0)
            for offset, p in files.items()
        }
        # Offsets we've already finished writing -- their full byte count
        # is already part of "completed" when we compute overall_pct.
        self._completed_offsets: set[str] = set()

    # --- snapshot for HTTP ------------------------------------------------
    def snapshot(self) -> dict:
        with self._lock:
            return {
                "job_id": self.job_id,
                "mode": self.mode,
                "phase": self.phase,
                "error": self.error,
                "started_ms": self.started_ms,
                "last_event_ms": self.last_event_ms,
                "ended_ms": self.ended_ms,
                "overall_pct": self.overall_pct,
                "current_offset": self.current_offset,
                "current_offset_pct": self.current_offset_pct,
                "exit_code": self.exit_code,
                "total_bytes": self.total_bytes,
                "files": {
                    offset: {
                        "name": self.file_names.get(offset, os.path.basename(p)),
                        "bytes": self._offset_sizes.get(offset, 0),
                    }
                    for offset, p in self.files.items()
                },
                # Last 80 lines is enough for the UI to show the operator
                # "what just happened"; full log is only available
                # locally on the host.
                "log_tail": [line for _, line in list(self.log_tail)[-80:]],
            }

    # --- internal helpers -------------------------------------------------
    def _set_phase(self, phase: str, *, error: Optional[str] = None) -> None:
        with self._lock:
            if phase not in self.PHASES:
                phase = "error"
                error = error or f"unknown phase {phase!r}"
            self.phase = phase
            self.last_event_ms = int(time.time() * 1000)
            if error is not None:
                self.error = error
            if phase in ("done", "error", "aborted"):
                self.ended_ms = self.last_event_ms

    def _append_log(self, line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        with self._lock:
            self.log_tail.append((int(time.time() * 1000), line))

    def _update_progress(self, current_offset: Optional[str], current_pct: int) -> None:
        with self._lock:
            if current_offset is not None:
                # If we just moved on to a new offset, treat the previous
                # one as fully complete for the overall_pct calculation.
                # This is what makes the bar march from 0->100 across a
                # full-flash run instead of resetting at every region.
                if self.current_offset and self.current_offset != current_offset:
                    self._completed_offsets.add(self.current_offset)
                self.current_offset = current_offset
            self.current_offset_pct = max(0, min(100, current_pct))

            total = max(1, self.total_bytes)
            done_bytes = sum(
                self._offset_sizes.get(o, 0) for o in self._completed_offsets
            )
            cur = self.current_offset
            if cur is not None and cur not in self._completed_offsets:
                cur_size = self._offset_sizes.get(cur, 0)
                done_bytes += int(cur_size * (self.current_offset_pct / 100.0))
            self.overall_pct = int(round(100.0 * done_bytes / total))
            self.last_event_ms = int(time.time() * 1000)


class FlashServerState:
    """Process-wide flasher state. There is exactly one instance.

    Owns the `current_job` slot (single-job-at-a-time policy enforced
    here) and the BridgeIO callbacks for pausing/resuming the serial
    forwarder.
    """

    def __init__(self, bridge_io: "BridgeIO"):
        self._lock = threading.Lock()
        self.current_job: Optional[FlashJob] = None
        self._next_job_seq = 1
        self.bridge_io = bridge_io
        # Snapshot of the very last finished job, kept around so a UI
        # that polls /status after the job's done can still see the
        # final state without a race against the next start.
        self.last_finished_snapshot: Optional[dict] = None

    def _alloc_job_id(self) -> str:
        with self._lock:
            seq = self._next_job_seq
            self._next_job_seq += 1
        return f"dflash-{int(time.time())}-{seq}"

    def submit(self, mode: str, files: dict[str, str], file_names: dict[str, str]) -> tuple[bool, str, Optional[FlashJob]]:
        with self._lock:
            if self.current_job is not None and self.current_job.phase not in (
                "done", "error", "aborted"
            ):
                return False, f"another job is in flight (phase={self.current_job.phase})", None
            job_id = f"dflash-{int(time.time())}-{self._next_job_seq}"
            self._next_job_seq += 1
            job = FlashJob(job_id, mode=mode, files=files, file_names=file_names)
            self.current_job = job
        return True, "ok", job

    def status_snapshot(self) -> dict:
        with self._lock:
            job = self.current_job
            last = self.last_finished_snapshot
        if job is None:
            return {
                "phase": "idle",
                "job_id": None,
                "last": last,
            }
        snap = job.snapshot()
        snap["last"] = last
        return snap

    def stash_finished(self, snap: dict) -> None:
        with self._lock:
            self.last_finished_snapshot = snap


class BridgeIO:
    """Adapter the bridge implements so the flash server can pause /
    resume serial forwarding without importing tcp_serial_bridge globals.

    The bridge constructs one of these and hands it to start_flash_server().
    """

    def __init__(
        self,
        pause_serial: Callable[[], None],
        resume_serial: Callable[[], None],
        current_port: Callable[[], str],
    ):
        self.pause_serial = pause_serial
        self.resume_serial = resume_serial
        self.current_port = current_port


# ---------------------------------------------------------------------------
# Flash worker thread
# ---------------------------------------------------------------------------

def _spawn_esptool(
    job: FlashJob,
    port: str,
    before: str,
) -> subprocess.Popen:
    """Build and start an esptool subprocess for `job`."""
    flash_pairs: list[tuple[str, Path]] = [
        (offset, Path(path)) for offset, path in job.files.items()
    ]
    # Sort by offset numerically so esptool writes bootloader (0x1000)
    # first, then partitions, etc. This isn't strictly required (esptool
    # is order-independent) but it keeps the progress display logical.
    flash_pairs.sort(key=lambda pair: int(pair[0], 16))
    esptool_argv = find_esptool()
    cmd = build_esptool_cmd(esptool_argv, port, flash_pairs, before=before)
    job._append_log(f"$ {' '.join(cmd)}")
    # Force unbuffered stderr so we see progress in real time. The
    # ESPTOOL_PY_NO_INTERACTIVE env disables ANSI escape sequences which
    # would otherwise show up in our log buffer as junk.
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    return subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,  # raw, we read characters
        env=env,
    )


def _drive_subprocess(job: FlashJob) -> int:
    """Read job._process's combined stdout/stderr and update phase as
    progress lines stream by. Returns the subprocess exit code.
    """
    proc = job._process
    assert proc is not None
    assert proc.stdout is not None

    # esptool uses \r for in-place progress updates. Read raw bytes and
    # split on either \r or \n so we surface the percentages.
    buf = bytearray()
    while True:
        if job._abort_event.is_set():
            try:
                proc.terminate()
            except Exception:
                pass
            break
        ch = proc.stdout.read(1)
        if not ch:
            # EOF. Flush whatever's left in buf as one last line.
            if buf:
                line = buf.decode("utf-8", errors="replace")
                _handle_line(job, line)
                buf.clear()
            break
        if ch in (b"\r", b"\n"):
            line = buf.decode("utf-8", errors="replace")
            buf.clear()
            if line:
                _handle_line(job, line)
        else:
            buf.append(ch[0])

    # subprocess.Popen.wait() drains the pipes -- we already drained
    # stdout so this is fast.
    return proc.wait()


def _handle_line(job: FlashJob, line: str) -> None:
    job._append_log(line)
    phase, extras = _classify_line(line)
    if phase:
        with job._lock:
            # Don't downgrade "writing" -> "preparing" if a stray
            # "Chip is ESP32-S2" line shows up partway through (it
            # doesn't, in practice, but defense in depth).
            cur_idx = job.PHASES.index(job.phase) if job.phase in job.PHASES else -1
            new_idx = job.PHASES.index(phase) if phase in job.PHASES else -1
            if new_idx >= cur_idx:
                job.phase = phase
                job.last_event_ms = int(time.time() * 1000)
    if "current_offset" in extras:
        job._update_progress(extras["current_offset"], extras["current_offset_pct"])


def _run_job(job: FlashJob, state: FlashServerState) -> None:
    """Worker thread body: pause serial, run esptool (with manual-reset
    fallback), resume serial, stash final snapshot.
    """
    try:
        port = state.bridge_io.current_port()
        if not port:
            job._set_phase("error", error="bridge has no serial port configured")
            return

        # Hand the port over to esptool.
        try:
            state.bridge_io.pause_serial()
        except Exception as e:
            job._set_phase("error", error=f"could not release serial port: {e}")
            return

        try:
            # Phase 1: try with auto-reset. This works on most lolin_s2_mini
            # boards if the operator's USB cable carries data lines and the
            # driver in the kernel speaks USB-CDC properly.
            job._set_phase("connecting")
            job._process = _spawn_esptool(job, port, before="default_reset")
            rc = _drive_subprocess(job)
            job.exit_code = rc

            if job._abort_event.is_set():
                job._set_phase("aborted", error="aborted by operator")
                return

            if rc != 0:
                # Phase 1.5: before bothering the operator, try a silent
                # retry with --before no_reset. On lolin_s2_mini USB-CDC
                # the chip is often already sitting in a download-ready
                # state after a "failed" default_reset, and this silent
                # retry succeeds outright a large fraction of the time.
                # It saves a manual BOOT+RESET dance the operator
                # otherwise has to click through every flash.
                job._append_log(
                    "auto-reset failed -- retrying once with no_reset before "
                    "asking for manual BOOT+RESET..."
                )
                time.sleep(1.0)
                job._set_phase("connecting")
                job._process = _spawn_esptool(job, port, before="no_reset")
                rc = _drive_subprocess(job)
                job.exit_code = rc
                if job._abort_event.is_set():
                    job._set_phase("aborted", error="aborted by operator")
                    return

            if rc != 0:
                # Silent retry also failed. Now we actually do need the
                # operator to BOOT+RESET the dongle. Park in
                # needs_manual_reset and wait for them to click
                # Continue, or for the timeout to expire.
                job._append_log(
                    "silent no_reset retry also failed -- BOOT+RESET the "
                    "dongle, then click Continue."
                )
                job._set_phase(
                    "needs_manual_reset",
                    error=(
                        "esptool couldn't talk to the dongle on its own "
                        "(common on lolin_s2_mini USB-CDC). Hold BOOT, "
                        "tap RESET, release BOOT, then click Continue."
                    ),
                )
                got_continue = job._continue_event.wait(timeout=NEEDS_MANUAL_RESET_TIMEOUT_S)
                if job._abort_event.is_set():
                    job._set_phase("aborted", error="aborted by operator")
                    return
                if not got_continue:
                    job._set_phase(
                        "error",
                        error=(
                            f"timed out waiting for manual bootloader entry "
                            f"after {int(NEEDS_MANUAL_RESET_TIMEOUT_S)}s. Try again."
                        ),
                    )
                    return

                # Phase 2: retry with --before no_reset. The operator has
                # now put the chip into the ROM bootloader manually.
                # Clear the previous error so the UI badge flips back to
                # "in progress" while the retry runs.
                with job._lock:
                    job.error = None
                job._set_phase("connecting")
                job._process = _spawn_esptool(job, port, before="no_reset")
                rc = _drive_subprocess(job)
                job.exit_code = rc
                if job._abort_event.is_set():
                    job._set_phase("aborted", error="aborted by operator")
                    return
                if rc != 0:
                    # Esptool's last error line is already in log_tail.
                    last = ""
                    with job._lock:
                        if job.log_tail:
                            last = job.log_tail[-1][1]
                    job._set_phase(
                        "error",
                        error=(
                            f"esptool exited {rc} after manual reset. "
                            f"Last: {last[-200:]}"
                        ),
                    )
                    return

            # Made it through one of the paths with rc==0.
            job._set_phase("done")
        finally:
            # Always give the port back, even on error / abort, so the
            # bridge's auto-reconnect path can reattach to whatever
            # state the dongle is in. (After a successful flash the
            # dongle reboots and re-enumerates -- the bridge's
            # _try_auto_reopen catches that within 1-3s.)
            try:
                state.bridge_io.resume_serial()
            except Exception as e:
                job._append_log(f"WARN: bridge resume_serial raised: {e}")

    except Exception as e:
        traceback.print_exc()
        job._append_log(f"flash worker crashed: {e}")
        job._set_phase("error", error=f"flash worker crashed: {e}")
    finally:
        # Snapshot for late /status callers (UI may poll once after the
        # job clears).
        try:
            state.stash_finished(job.snapshot())
        except Exception:
            pass


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------

class _FlashHandler(BaseHTTPRequestHandler):
    """Tiny stdlib http.server handler. The Server gives every handler
    instance access to `state` via `self.server.flash_state`."""

    # Quieten the default per-request access log; we have our own
    # structured logging.
    def log_message(self, fmt: str, *args: Any) -> None:  # pragma: no cover
        sys.stderr.write(f"[flash_server] {self.address_string()} - {fmt % args}\n")

    # ---- helpers ---------------------------------------------------------
    def _state(self) -> FlashServerState:
        return self.server.flash_state  # type: ignore[attr-defined]

    def _respond(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        # CORS: we don't expect cross-origin callers, but a misconfigured
        # browser test setup will choke without these. Loopback-only so
        # there's no security concern in being permissive.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise ValueError(f"invalid JSON body: {e}") from e

    # ---- routes ----------------------------------------------------------
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/flash_dongle/status":
            self._respond(200, self._state().status_snapshot())
            return
        if self.path.rstrip("/") in ("/", "/healthz"):
            self._respond(200, {"ok": True, "service": "byh-flash-server"})
            return
        self._respond(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = self.path.rstrip("/")
        if path == "/flash_dongle":
            self._handle_start()
        elif path == "/flash_dongle/continue":
            self._handle_continue()
        elif path == "/flash_dongle/abort":
            self._handle_abort()
        else:
            self._respond(404, {"error": "not found"})

    def do_DELETE(self) -> None:
        if self.path.rstrip("/") == "/flash_dongle":
            self._handle_abort()
        else:
            self._respond(404, {"error": "not found"})

    # ---- handlers --------------------------------------------------------
    def _handle_start(self) -> None:
        try:
            body = self._read_body()
        except ValueError as e:
            self._respond(400, {"error": str(e)})
            return

        mode = body.get("mode")
        if mode not in ("app", "full"):
            self._respond(400, {"error": "mode must be 'app' or 'full'"})
            return

        files_raw = body.get("files") or {}
        if not isinstance(files_raw, dict) or not files_raw:
            self._respond(400, {"error": "files must be a non-empty {offset: path} object"})
            return

        # Normalise offset keys to lowercase 0x... and validate paths.
        files: dict[str, str] = {}
        file_names: dict[str, str] = {}
        for offset, value in files_raw.items():
            if isinstance(value, dict):
                path = value.get("path")
                name = value.get("name") or (os.path.basename(path) if path else "")
            else:
                path = value
                name = os.path.basename(path) if path else ""
            if not isinstance(path, str) or not path:
                self._respond(400, {"error": f"offset {offset!r} missing path"})
                return
            try:
                offset_norm = "0x{:x}".format(int(offset, 16))
            except (TypeError, ValueError):
                self._respond(400, {"error": f"bad offset {offset!r} (want hex like 0x10000)"})
                return
            if not os.path.isfile(path):
                self._respond(400, {"error": f"offset {offset_norm}: file not found at {path}"})
                return
            files[offset_norm] = path
            file_names[offset_norm] = name

        required = (
            FULL_FLASH_OFFSETS if mode == "full" else APP_ONLY_OFFSETS
        )
        for off in required:
            off_norm = "0x{:x}".format(int(off, 16))
            if off_norm not in files:
                self._respond(
                    400,
                    {
                        "error": (
                            f"mode={mode} requires offset {off_norm}. "
                            f"Provided: {sorted(files.keys())}"
                        )
                    },
                )
                return

        ok, msg, job = self._state().submit(
            mode=mode, files=files, file_names=file_names
        )
        if not ok or job is None:
            self._respond(409, {"error": msg})
            return

        worker = threading.Thread(
            target=_run_job, args=(job, self._state()),
            name=f"dongle-flash-{job.job_id}", daemon=True,
        )
        worker.start()

        self._respond(202, {"accepted": True, "job_id": job.job_id})

    def _handle_continue(self) -> None:
        st = self._state()
        with st._lock:
            job = st.current_job
        if job is None:
            self._respond(404, {"error": "no active job"})
            return
        if job.phase != "needs_manual_reset":
            self._respond(409, {"error": f"job is in phase {job.phase}, can't continue"})
            return
        job._continue_event.set()
        self._respond(202, {"accepted": True})

    def _handle_abort(self) -> None:
        st = self._state()
        with st._lock:
            job = st.current_job
        if job is None or job.phase in ("done", "error", "aborted"):
            self._respond(404, {"error": "no active job"})
            return
        job._abort_event.set()
        # Wake the worker out of the manual-reset wait so it can notice
        # the abort flag immediately.
        job._continue_event.set()
        # Also kill esptool directly; the worker thread will observe
        # the dead subprocess and finalize state.
        proc = job._process
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass
        self._respond(202, {"accepted": True})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def start_flash_server(bridge_io: BridgeIO, *, port: int = FLASH_HTTP_PORT) -> threading.Thread:
    """Start the flasher HTTP server on a daemon thread.

    Returns the thread. The server listens on FLASH_HTTP_HOST:port; the
    daemon (in docker) reaches it via host.docker.internal.
    """
    state = FlashServerState(bridge_io)

    server = ThreadingHTTPServer((FLASH_HTTP_HOST, port), _FlashHandler)
    # Stash the state on the server so handlers can reach it.
    server.flash_state = state  # type: ignore[attr-defined]

    def _serve():
        sys.stderr.write(
            f"[flash_server] listening on http://{FLASH_HTTP_HOST}:{port}\n"
        )
        server.serve_forever()

    t = threading.Thread(target=_serve, name="flash-server", daemon=True)
    t.start()
    return t
