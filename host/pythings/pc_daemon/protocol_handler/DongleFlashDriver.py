"""Dongle flash driver -- the daemon's view of a UI-driven dongle update.

Where the receiver-OTA flow streams chunks over RF (driven by
OtaFlashDriver in this same package), the dongle update is fundamentally
different: the dongle's USB-CDC port is owned by the host-side
tcp_serial_bridge, so this driver doesn't drive esptool itself. Instead
it talks HTTP to the bridge's /flash_dongle endpoint:

    daemon                           bridge (host loopback :9001)
    ─────                           ─────────────────────────────
    POST /flash_dongle  ───────────▶  pause forwarders, fork esptool
                       ◀───────────   {accepted: true, job_id}
    GET  /flash_dongle/status         (worker thread runs esptool,
                       (poll loop)     parses Writing-at-pct lines)
                       ◀───────────   {phase, overall_pct, ...}
    POST /flash_dongle/continue       (operator-confirmed BOOT+RESET,
                                       worker rretries with no_reset)
    POST /flash_dongle/abort          (kill esptool subprocess)

The bridge's /flash_dongle/status is the source of truth for live
state; this driver's job is to (a) gate-check on the daemon's side
(no flash while a show is loaded or armed), (b) translate UI commands
into HTTP calls, and (c) republish the status into fw_state.dongle_ota
so the existing WebSocket fan-out delivers updates to the browser
without a separate polling channel.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
from typing import Optional
from urllib import error as urlerror
from urllib import request as urlrequest


# Where to find the host-side bridge's flasher endpoint. host.docker.internal
# resolves to the host loopback inside docker (Docker Desktop on Mac/Win does
# this natively; on Linux we wire it up via extra_hosts in compose). On a
# native install (no docker) the same env override lets the daemon point
# at 127.0.0.1.
FLASH_HTTP_HOST = os.environ.get("BYH_FLASH_HOST", "host.docker.internal")
FLASH_HTTP_PORT = int(os.environ.get("BYH_FLASH_PORT", "9001"))
FLASH_BASE_URL = f"http://{FLASH_HTTP_HOST}:{FLASH_HTTP_PORT}"

# Default poll cadence. esptool's progress output ticks at roughly 5-10Hz
# during the write phase; 5Hz is plenty for a smooth UI bar without
# burning CPU on a Pi.
POLL_INTERVAL_S = 0.2

# How long we let a single HTTP request hang before giving up. The bridge
# normally responds in <50ms; anything beyond a couple seconds means the
# bridge process is wedged.
HTTP_TIMEOUT_S = 4.0

# Dongle-update timeline guard. From "submit job" to "phase=done|error|
# aborted" must complete within this many seconds, otherwise we declare
# the bridge wedged and surface an error in the UI. The longest legitimate
# run is full-flash mode at ~30s + manual-reset prompt at up to 5min,
# so 7 minutes leaves comfortable headroom.
JOB_LIFETIME_LIMIT_S = 7 * 60.0

# Phases we consider "in flight"; matches FlashJob.PHASES on the bridge
# side. Anything in this set blocks a new submission.
ACTIVE_PHASES = frozenset({
    "preparing",
    "connecting",
    "writing",
    "verifying",
    "rebooting",
    "needs_manual_reset",
})


class DongleFlashDriver:
    """One-at-a-time dongle update driver.

    Lifecycle:
      * `start_job(...)` -- POSTs the staged image paths to the bridge
        and kicks off the polling thread.
      * `continue_job()` -- forwards the operator's "I've BOOT+RESET'd
        the dongle" confirmation.
      * `abort()` -- POSTs /flash_dongle/abort and lets the polling
        thread tear down the local snapshot.
      * `snapshot()` -- the latest mirror of the bridge's
        /flash_dongle/status response, embedded in fw_state.dongle_ota.
    """

    def __init__(self, parent):
        self.parent = parent  # FireworkDaemon
        self._lock = threading.Lock()
        # Last snapshot we got from the bridge. None until the first
        # successful start_job; the UI renders "idle" in that case.
        self._snapshot: Optional[dict] = None
        # Last error string, only set when WE failed (HTTP errors,
        # timeouts) -- the bridge's own errors are inside _snapshot.
        self._driver_error: Optional[str] = None
        # Kept so abort() can know whether there's anything in flight
        # locally without trusting a stale snapshot.
        self._poll_thread: Optional[threading.Thread] = None
        self._stop_poll = threading.Event()
        self._job_started_ms: Optional[int] = None
        self._active_job_id: Optional[str] = None

    # ------------------------------------------------------------------
    # Public state
    # ------------------------------------------------------------------
    def is_busy(self) -> bool:
        with self._lock:
            snap = self._snapshot
        if not snap:
            return False
        return snap.get("phase") in ACTIVE_PHASES

    def snapshot(self) -> dict:
        """Bridge snapshot + driver-side fields, JSON-safe.

        Returned shape (matches what the UI consumes via fw_state.dongle_ota):
            {
              "phase": str,                # 'idle' | bridge phase
              "job_id": str | None,
              "overall_pct": int,
              "current_offset": str | None,
              "current_offset_pct": int,
              "started_ms": int | None,
              "last_event_ms": int | None,
              "ended_ms": int | None,
              "error": str | None,         # bridge-reported
              "driver_error": str | None,  # daemon-reported (HTTP, etc.)
              "exit_code": int | None,
              "mode": str | None,
              "files": {offset: {name, bytes}},
              "log_tail": [str],
              "total_bytes": int,
            }
        """
        with self._lock:
            snap = dict(self._snapshot) if self._snapshot else None
            driver_error = self._driver_error
        if snap is None:
            out = {
                "phase": "idle",
                "job_id": None,
                "overall_pct": 0,
                "current_offset": None,
                "current_offset_pct": 0,
                "started_ms": None,
                "last_event_ms": None,
                "ended_ms": None,
                "error": None,
                "exit_code": None,
                "mode": None,
                "files": {},
                "log_tail": [],
                "total_bytes": 0,
            }
        else:
            out = snap
        out["driver_error"] = driver_error
        return out

    # ------------------------------------------------------------------
    # Public API (called from BYHProtocolHandler)
    # ------------------------------------------------------------------
    def start_job(
        self,
        *,
        mode: str,
        files: dict[str, str],
        file_names: dict[str, str],
    ) -> tuple[bool, str]:
        """Submit a fresh dongle flash job.

        `files` is {hex_offset: filesystem_path}. `file_names` is the
        same keys mapped to display names for the UI. Both must already
        be validated by the caller (existence, size caps).
        """
        if mode not in ("app", "full"):
            return False, f"mode must be 'app' or 'full' (got {mode!r})"
        if not files:
            return False, "no files to flash"

        if self.is_busy():
            with self._lock:
                phase = (self._snapshot or {}).get("phase")
            return False, f"a dongle flash is already in flight (phase={phase})"

        # Embed the firmware bytes inline rather than passing a filesystem
        # path. The bridge runs as a host-native process and does NOT share a
        # filesystem with this (containerised) daemon on Docker Desktop /
        # Windows -- a path like /tmp/ota_staging/.../app.bin resolves to a
        # different place (or nowhere) for the native bridge. Shipping the
        # bytes makes the flow filesystem-agnostic across every platform.
        files_payload = {}
        for offset, path in files.items():
            try:
                with open(path, "rb") as fh:
                    content = fh.read()
            except OSError as e:
                return False, f"could not read staged firmware {path}: {e}"
            files_payload[offset] = {
                "name": file_names.get(offset, os.path.basename(path)),
                "content_b64": base64.b64encode(content).decode("ascii"),
            }

        body = {"mode": mode, "files": files_payload}

        try:
            resp = self._http_post("/flash_dongle", body)
        except DongleFlashHTTPError as e:
            self._set_driver_error(str(e))
            return False, str(e)

        job_id = resp.get("job_id")
        if not job_id:
            self._set_driver_error(f"bridge accepted job but returned no job_id: {resp}")
            return False, "bridge returned malformed response"

        with self._lock:
            self._snapshot = {
                "phase": "preparing",
                "job_id": job_id,
                "overall_pct": 0,
                "current_offset": None,
                "current_offset_pct": 0,
                "started_ms": int(time.time() * 1000),
                "last_event_ms": int(time.time() * 1000),
                "ended_ms": None,
                "error": None,
                "exit_code": None,
                "mode": mode,
                "files": {
                    offset: {"name": file_names.get(offset, os.path.basename(p)),
                             "bytes": _safe_size(p)}
                    for offset, p in files.items()
                },
                "log_tail": [],
                "total_bytes": sum(_safe_size(p) for p in files.values()),
            }
            self._driver_error = None
            self._active_job_id = job_id
            self._job_started_ms = int(time.time() * 1000)
            self._stop_poll.clear()

        # Start the polling thread. Polls /flash_dongle/status until the
        # bridge reports a terminal phase.
        t = threading.Thread(
            target=self._poll_loop,
            name=f"dongle-flash-poll-{job_id}",
            daemon=True,
        )
        with self._lock:
            self._poll_thread = t
        t.start()

        try:
            self.parent.mark_state_dirty()
        except Exception:
            pass
        return True, f"queued ({job_id})"

    def continue_job(self, port: Optional[str] = None) -> tuple[bool, str]:
        # Optionally tell the bridge which port to retry on -- the operator
        # may have picked one in the UI when auto-detection was ambiguous.
        body = {"port": port} if port else {}
        try:
            self._http_post("/flash_dongle/continue", body)
        except DongleFlashHTTPError as e:
            self._set_driver_error(str(e))
            return False, str(e)
        return True, "continue requested"

    def abort(self) -> tuple[bool, str]:
        try:
            self._http_post("/flash_dongle/abort", {})
        except DongleFlashHTTPError as e:
            # Even on HTTP failure, mark the local snapshot aborted so
            # the UI unblocks. The poll loop will clean up.
            self._set_driver_error(str(e))
            with self._lock:
                if self._snapshot is not None:
                    self._snapshot = {
                        **self._snapshot,
                        "phase": "aborted",
                        "error": f"abort raised {e}",
                        "ended_ms": int(time.time() * 1000),
                    }
            try:
                self.parent.mark_state_dirty()
            except Exception:
                pass
            return False, str(e)
        return True, "abort requested"

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------
    def _set_driver_error(self, err: str) -> None:
        with self._lock:
            self._driver_error = err
        try:
            self.parent.mark_state_dirty()
        except Exception:
            pass

    def _poll_loop(self) -> None:
        """Poll /flash_dongle/status until terminal."""
        try:
            while not self._stop_poll.is_set():
                # Lifetime guard: if we've been polling for longer than
                # JOB_LIFETIME_LIMIT_S without seeing a terminal phase,
                # something is very wrong on the bridge side. Surface
                # locally so the UI doesn't hang on a stuck "writing".
                with self._lock:
                    started = self._job_started_ms
                if started and (int(time.time() * 1000) - started) / 1000.0 > JOB_LIFETIME_LIMIT_S:
                    with self._lock:
                        if self._snapshot is not None:
                            self._snapshot = {
                                **self._snapshot,
                                "phase": "error",
                                "error": (
                                    f"bridge job exceeded {JOB_LIFETIME_LIMIT_S:.0f}s "
                                    "lifetime; assuming wedged"
                                ),
                                "ended_ms": int(time.time() * 1000),
                            }
                    try:
                        self.parent.mark_state_dirty()
                    except Exception:
                        pass
                    return

                try:
                    snap = self._http_get("/flash_dongle/status")
                except DongleFlashHTTPError as e:
                    # Don't bail on a single transient HTTP error -- the
                    # bridge may be busy mid-flash. Surface as a soft
                    # driver_error and keep polling.
                    self._set_driver_error(f"poll: {e}")
                    time.sleep(POLL_INTERVAL_S * 2)
                    continue

                # Clear soft error on a successful poll.
                with self._lock:
                    self._driver_error = None

                # The bridge's /status returns the current job snapshot
                # AND a `last` field for the most recently finished job.
                # We prefer current; fall back to last if current is
                # idle but last matches our active job id (so the
                # UI still sees the final 100% snapshot once the
                # bridge has cleared its current_job slot).
                phase = snap.get("phase")
                with self._lock:
                    if phase == "idle" and snap.get("last"):
                        last = snap.get("last") or {}
                        if last.get("job_id") == self._active_job_id:
                            self._snapshot = last
                        else:
                            self._snapshot = {**(self._snapshot or {}), "phase": "idle"}
                    else:
                        # Drop the bridge's `last` field from our local
                        # snapshot -- it's only useful as a fallback,
                        # and the UI doesn't render it.
                        snap_copy = dict(snap)
                        snap_copy.pop("last", None)
                        self._snapshot = snap_copy

                try:
                    self.parent.mark_state_dirty()
                except Exception:
                    pass

                with self._lock:
                    cur_phase = (self._snapshot or {}).get("phase")
                if cur_phase in ("done", "error", "aborted", "idle"):
                    return

                self._stop_poll.wait(POLL_INTERVAL_S)
        except Exception as e:
            print(f"dongle-flash poll loop crashed: {e}")
            with self._lock:
                if self._snapshot is not None:
                    self._snapshot = {
                        **self._snapshot,
                        "phase": "error",
                        "error": f"daemon poll crashed: {e}",
                        "ended_ms": int(time.time() * 1000),
                    }
            try:
                self.parent.mark_state_dirty()
            except Exception:
                pass

    # --- HTTP helpers ----------------------------------------------------
    def _http_post(self, path: str, body: dict) -> dict:
        url = FLASH_BASE_URL + path
        data = json.dumps(body).encode("utf-8")
        req = urlrequest.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/json"},
        )
        return self._do_http(req)

    def _http_get(self, path: str) -> dict:
        url = FLASH_BASE_URL + path
        req = urlrequest.Request(url, method="GET")
        return self._do_http(req)

    def _do_http(self, req: urlrequest.Request) -> dict:
        try:
            with urlrequest.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
                raw = resp.read()
                if not raw:
                    return {}
                try:
                    return json.loads(raw.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError) as e:
                    raise DongleFlashHTTPError(
                        f"bridge returned non-JSON ({e}): {raw!r}"
                    ) from e
        except urlerror.HTTPError as e:
            # Read the body so we can include the bridge's error message.
            try:
                body_raw = e.read()
                payload = json.loads(body_raw.decode("utf-8"))
                msg = payload.get("error") or body_raw.decode("utf-8", "replace")
            except Exception:
                msg = str(e)
            raise DongleFlashHTTPError(
                f"bridge returned {e.code}: {msg}"
            ) from e
        except urlerror.URLError as e:
            raise DongleFlashHTTPError(
                f"could not reach bridge at {FLASH_BASE_URL}: {e.reason}"
            ) from e
        except OSError as e:
            raise DongleFlashHTTPError(
                f"network error reaching bridge at {FLASH_BASE_URL}: {e}"
            ) from e


class DongleFlashHTTPError(RuntimeError):
    """HTTP-layer failure talking to the bridge's flasher endpoint."""


def _safe_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0
