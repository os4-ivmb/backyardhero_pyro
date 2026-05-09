"""OTA flash mode driver for the BYH dongle/receiver fleet.

This module owns the host side of the OTA wire protocol added in dongle FW
v10 / receiver FW v15. It runs on its own daemon thread and:

  1. Stages the operator-supplied .bin file into memory + computes a
     CRC32 for end-to-end verification.
  2. Sends `flash_begin <ident> <size> <chunks> <crc32_hex> <rate>` to
     the dongle and waits for the matching `{"type":"ota","phase":"begin_ok"}`
     event back.
  3. Streams `flash_data <idx> <hex>` lines, one per chunk, paced by the
     ack/nack stream coming back from the dongle. We send one chunk and
     wait for its `phase:ack` before sending the next so the dongle's
     128-deep command queue (which we share with the regular polling
     path) never sees more than one OTA frame in flight.
  4. Issues `flash_end` once all chunks are acked, then watches for the
     dongle's `phase:done` (receiver came back online post-reboot) or
     `phase:timeout` (30s expired).

The driver publishes per-chunk progress via the daemon's
`update_state_file` so the UI can show a progress bar.

The dongle wire bookkeeping (radio data rate hop, single-receiver pin,
re-listen post-reboot) is entirely on the firmware side; this module
only deals with the serial wire protocol.
"""

from __future__ import annotations

import binascii
import json
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

# Maximum data bytes per OTA_DATA frame. Must match
# `OTA_MAX_CHUNK_BYTES` on the dongle (32-byte radio payload minus the
# 3-byte OtaDataMessage header).
OTA_CHUNK_BYTES = 29

# How long to wait for an ack/nack on a single chunk before we declare
# the dongle non-responsive and treat the attempt as timed out. The
# dongle's per-chunk RF retries (4 internal + 5 radio-level = ~25 frames
# in FW v14) all happen before it replies, so 5s comfortably covers
# the worst case + a few hundred ms of USB-CDC backpressure.
CHUNK_ACK_TIMEOUT_S = 5.0

# Per-chunk host-level retries on top of the dongle's own retry burst.
# A single nack means the dongle's full retry budget all failed in one
# ~400ms window -- usually a transient deep fade or burst of 2.4GHz
# interference. After waiting NACK_BACKOFF_S the link almost always
# recovers, so we resend the same chunk and continue.
#
# The retry strategy interleaves regular `flash_data` resends with
# escalating `flash_recover` calls (FW v14):
#   attempts 0,1,2: normal flash_data resend
#   attempt 3:      flash_recover <idx> 0  (REPLAY: stored frame replay)
#   attempts 4,5:   flash_data
#   attempt 6:      flash_recover <idx> 1  (SOFT: + softRadioRecovery)
#   attempts 7,8:   flash_data
#   attempt 9:      flash_recover <idx> 2  (FULL: + radio.begin restart)
#   attempts 10,11: flash_data
#
# At each recovery escalation we also send `flash_ping` first to confirm
# the dongle's main loop is making progress -- if it doesn't reply
# within PING_TIMEOUT_S we log the wedge but continue retrying (the
# dongle's hardware watchdog will reset it after 20s as a backstop).
#
# Receiver tolerates duplicate chunkIdx (silently re-acks) so this is
# safe even when the chunk got through but its ACK was lost.
CHUNK_HOST_RETRIES = 12
NACK_BACKOFF_S = 0.05
PING_TIMEOUT_S = 1.5

# Map host-attempt index -> recovery level to send. Anything not in this
# table is a plain `flash_data` resend.
RECOVERY_SCHEDULE = {
    3: 0,   # REPLAY
    6: 1,   # SOFT
    9: 2,   # FULL
}

# If we've heard nothing from the dongle (no ack/nack/heartbeat/pong)
# for this many seconds during an active job, assume it rebooted (WDT
# tripped, USB hiccup, etc.). The dongle's WDT is 10s in FW v15, plus
# a few seconds of USB re-enumeration overhead -- 20s comfortably
# spans that window. We bail the job cleanly so the UI unblocks; the
# operator can retry once the bridge has reconnected the new device.
DONGLE_SILENCE_ABORT_S = 20.0

# How long the dongle waits post-`flash_end` for the receiver to reboot
# back onto the standard 250kbps polling. Should match
# `OTA_REJOIN_TIMEOUT_MS` on the dongle so we don't time out before it
# does. Plus a small grace window for the serial round-trip.
REJOIN_DEADLINE_S = 33.0

# Data rate byte sent over the wire. 0=250k, 1=1Mbps, 2=2Mbps. 2Mbps
# keeps a typical ~340KB image under ~30s on a clean channel.
DEFAULT_DATA_RATE = 2


class OtaPhase(str, Enum):
    IDLE = "idle"
    SUBMITTED = "submitted"        # accepted into the queue, not started
    PREP = "prep"                  # waiting for begin_ok
    STREAMING = "streaming"        # sending chunks
    FINALIZING = "finalizing"      # flash_end issued, waiting for rejoin
    DONE = "done"
    ERROR = "error"
    ABORTED = "aborted"


@dataclass
class OtaState:
    """Mirror of the active OTA job, copied into /data/state by the daemon."""

    phase: OtaPhase = OtaPhase.IDLE
    target_ident: Optional[str] = None
    total_bytes: int = 0
    total_chunks: int = 0
    chunks_sent: int = 0
    chunks_acked: int = 0
    bytes_acked: int = 0
    # Total host-level retries across the lifetime of the job. Useful as
    # a link-quality indicator -- a transfer with chunks_retried >> 0 is
    # working but on a flaky link.
    chunks_retried: int = 0
    started_ms: Optional[int] = None
    last_event_ms: Optional[int] = None
    error: Optional[str] = None
    rate: int = DEFAULT_DATA_RATE
    crc32_hex: Optional[str] = None
    file_name: Optional[str] = None

    def to_dict(self):
        return {
            "phase": self.phase.value,
            "target_ident": self.target_ident,
            "total_bytes": self.total_bytes,
            "total_chunks": self.total_chunks,
            "chunks_sent": self.chunks_sent,
            "chunks_acked": self.chunks_acked,
            "bytes_acked": self.bytes_acked,
            "chunks_retried": self.chunks_retried,
            "started_ms": self.started_ms,
            "last_event_ms": self.last_event_ms,
            "error": self.error,
            "rate": self.rate,
            "crc32_hex": self.crc32_hex,
            "file_name": self.file_name,
            "progress_pct": (
                round((self.chunks_acked / self.total_chunks) * 100, 1)
                if self.total_chunks else 0
            ),
        }


class OtaFlashDriver:
    """One-at-a-time OTA driver.

    Lifecycle:
      * `start_job(ident, image_bytes)` - kicks off a background thread
        that drives the protocol to completion. Returns immediately.
      * `abort()` - issues `flash_abort` and tears down the in-flight job.
      * `feed_event(event_dict)` - called from the daemon's serial
        ingestion path on every `{"type":"ota",...}` line so the
        protocol state machine can advance.
      * `state` - the current OtaState (snapshot copy is what the daemon
        embeds in /data/state).
    """

    def __init__(self, parent):
        self.parent = parent  # FireworkDaemon
        self.state = OtaState()
        self._lock = threading.Lock()
        self._event_cond = threading.Condition(self._lock)
        # Append-only event log for the running job. Each entry is the
        # raw dongle event dict (`{type:ota, phase:..., ...}`); the
        # driver thread pops from the front.
        self._pending_events: list[dict] = []
        self._abort_requested = False
        self._thread: Optional[threading.Thread] = None
        self._image: Optional[bytes] = None
        # Most recent dongle heartbeat / pong for liveness tracking.
        # Updated by feed_event() on `OS` and `OP` lines, read by the
        # driver thread to decide whether to escalate or bail.
        self._last_dongle_event_ms: int = 0
        # Pong handling: the driver waits on this event after sending
        # `flash_ping`. feed_pong() sets it.
        self._pong_event = threading.Event()
        self._last_pong: Optional[dict] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def is_busy(self) -> bool:
        with self._lock:
            return self.state.phase not in (
                OtaPhase.IDLE, OtaPhase.DONE, OtaPhase.ERROR, OtaPhase.ABORTED
            )

    def snapshot(self) -> dict:
        """Return a JSON-safe copy of the current state for /data/state."""
        with self._lock:
            return self.state.to_dict()

    def start_job(self, ident: str, image_bytes: bytes,
                  rate: int = DEFAULT_DATA_RATE,
                  file_name: Optional[str] = None) -> tuple[bool, str]:
        """Submit a new OTA job. Returns (ok, message)."""
        if not ident:
            return False, "ident required"
        if not image_bytes:
            return False, "image is empty"
        if rate not in (0, 1, 2):
            return False, "rate must be 0/1/2"

        with self._lock:
            if self.state.phase not in (
                OtaPhase.IDLE, OtaPhase.DONE, OtaPhase.ERROR, OtaPhase.ABORTED
            ):
                return False, f"OTA driver busy (phase={self.state.phase.value})"

            total_chunks = (len(image_bytes) + OTA_CHUNK_BYTES - 1) // OTA_CHUNK_BYTES
            if total_chunks > 0xFFFF:
                return False, "image too large (>2^16 chunks)"

            crc32 = binascii.crc32(image_bytes) & 0xFFFFFFFF
            self._image = image_bytes
            self._abort_requested = False
            self._pending_events.clear()
            self.state = OtaState(
                phase=OtaPhase.SUBMITTED,
                target_ident=ident,
                total_bytes=len(image_bytes),
                total_chunks=total_chunks,
                chunks_sent=0,
                chunks_acked=0,
                bytes_acked=0,
                started_ms=int(time.time() * 1000),
                last_event_ms=int(time.time() * 1000),
                error=None,
                rate=rate,
                crc32_hex=f"{crc32:08x}",
                file_name=file_name,
            )

        self._thread = threading.Thread(
            target=self._run, name=f"ota-{ident}", daemon=True
        )
        self._thread.start()
        self._mark_dirty()
        return True, "queued"

    def abort(self) -> tuple[bool, str]:
        with self._lock:
            if self.state.phase in (
                OtaPhase.IDLE, OtaPhase.DONE, OtaPhase.ERROR, OtaPhase.ABORTED
            ):
                return False, "no active OTA job"
            self._abort_requested = True
            self._event_cond.notify_all()
        # Best-effort signal to the dongle. Even if it bounces the
        # serial path the driver thread will tear down on the abort flag.
        try:
            self.parent.send_serial_command("flash_abort")
        except Exception as e:
            print(f"OTA abort: failed to send flash_abort: {e}")
        return True, "abort requested"

    def feed_event(self, evt: dict):
        """Called from the daemon's ingestion path for every ota frame."""
        with self._lock:
            self._pending_events.append(evt)
            self._last_dongle_event_ms = int(time.time() * 1000)
            self._event_cond.notify_all()

    def feed_heartbeat(self, hb: dict):
        """Called for the dongle's compact `OS ...` per-second heartbeat
        emitted while OTA is active. Updates liveness only -- the driver
        thread's main wait is still on the per-chunk OA/ON acks. Heartbeat
        keeps `chunks_acked` etc. in sync if individual ack frames get
        lost in serial backpressure.
        """
        with self._lock:
            self._last_dongle_event_ms = int(time.time() * 1000)
            try:
                self.state.chunks_acked = max(
                    self.state.chunks_acked, int(hb.get('acked', 0))
                )
                # bytes_acked tracking off the heartbeat is a coarse
                # estimate (chunks * chunk_size); the per-chunk ack path
                # is still authoritative.
            except (TypeError, ValueError):
                pass

    def feed_pong(self, pong: dict):
        """Called for the dongle's `OP ...` reply to `flash_ping`. Wakes
        any driver thread parked in _wait_for_pong()."""
        with self._lock:
            self._last_dongle_event_ms = int(time.time() * 1000)
            self._last_pong = pong
        self._pong_event.set()

    # ------------------------------------------------------------------
    # Internal driver loop
    # ------------------------------------------------------------------
    def _set_phase(self, phase: OtaPhase, error: Optional[str] = None):
        with self._lock:
            self.state.phase = phase
            self.state.last_event_ms = int(time.time() * 1000)
            if error is not None:
                self.state.error = error
        self._mark_dirty()

    def _mark_dirty(self):
        # Push a state snapshot up to the daemon's flusher so the WS
        # server gets the new progress immediately rather than at the
        # next heartbeat tick.
        try:
            self.parent.mark_state_dirty()
        except Exception:
            pass

    def _next_event(self, timeout_s: float) -> Optional[dict]:
        deadline = time.time() + timeout_s
        with self._lock:
            while not self._pending_events:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                if self._abort_requested:
                    return {"phase": "_abort_local"}
                self._event_cond.wait(timeout=remaining)
                if self._abort_requested:
                    return {"phase": "_abort_local"}
            return self._pending_events.pop(0)

    def _drain_events(self):
        with self._lock:
            self._pending_events.clear()

    def _send(self, cmd: str):
        try:
            self.parent.send_serial_command(cmd)
        except Exception as e:
            raise RuntimeError(f"serial send failed: {e}") from e

    def _run(self):
        ident = self.state.target_ident
        rate = self.state.rate
        crc32_hex = self.state.crc32_hex
        total_size = self.state.total_bytes
        total_chunks = self.state.total_chunks
        image = self._image
        try:
            print(
                f"OTA: starting job ident={ident} bytes={total_size} "
                f"chunks={total_chunks} rate={rate} crc32={crc32_hex}"
            )
            # Phase 1: send flash_begin and wait for begin_ok
            self._set_phase(OtaPhase.PREP)
            self._drain_events()
            self._send(
                f"flash_begin {ident} {total_size} {total_chunks} {crc32_hex} {rate}"
            )

            evt = self._next_event(timeout_s=10.0)
            if not self._handle_begin_response(evt):
                return

            # Phase 2: stream chunks, one at a time, gated on per-chunk ack.
            self._set_phase(OtaPhase.STREAMING)
            for idx in range(total_chunks):
                if self._abort_requested:
                    self._send("flash_abort")
                    self._set_phase(OtaPhase.ABORTED, "host abort")
                    return
                start = idx * OTA_CHUNK_BYTES
                end = min(start + OTA_CHUNK_BYTES, total_size)
                hex_payload = image[start:end].hex()

                if not self._send_chunk_with_retry(idx, hex_payload):
                    return

                # Periodic dirty-mark so the UI progress bar updates
                # without the WS having to wait for the next heartbeat.
                # Cap to ~10Hz so a fast transfer doesn't spam the
                # state writer (10000 chunks at 100Hz would push 100
                # disk writes per second).
                if (idx % max(1, total_chunks // 200)) == 0:
                    self._mark_dirty()

            # Phase 3: flash_end + post-reboot rejoin
            self._set_phase(OtaPhase.FINALIZING)
            self._drain_events()
            self._send("flash_end")
            self._wait_for_finalization()
        except Exception as e:
            print(f"OTA: driver thread crashed: {e}")
            self._set_phase(OtaPhase.ERROR, f"driver crashed: {e}")
            try:
                self._send("flash_abort")
            except Exception:
                pass
        finally:
            self._image = None
            self._mark_dirty()

    def _handle_begin_response(self, evt: Optional[dict]) -> bool:
        if not evt:
            self._set_phase(OtaPhase.ERROR, "begin: no response from dongle")
            return False
        phase = evt.get("phase")
        if phase == "_abort_local":
            self._send("flash_abort")
            self._set_phase(OtaPhase.ABORTED, "host abort")
            return False
        if phase == "begin_ok":
            return True
        if phase == "error":
            err = evt.get("err") or "unknown"
            self._set_phase(OtaPhase.ERROR, f"begin rejected: {err}")
            return False
        # Unexpected event shape (e.g. progress event from a prior
        # job). Treat as fatal; the operator can retry.
        self._set_phase(OtaPhase.ERROR, f"begin: unexpected phase {phase!r}")
        return False

    def _wait_for_pong(self, timeout_s: float) -> Optional[dict]:
        """Send `flash_ping` and wait for an `OP` reply within timeout_s.

        Returns the pong dict on success, None on timeout. Used as a
        liveness probe between recovery escalations: if the dongle
        doesn't reply quickly, we know its main loop is wedged and
        further retries are unlikely to help -- but we try anyway,
        because the dongle's hardware watchdog (20s in FW v14) will
        eventually reset it and the host's 30s rejoin window kicks in.
        """
        self._pong_event.clear()
        with self._lock:
            self._last_pong = None
        try:
            self._send("flash_ping")
        except Exception as e:
            print(f"OTA: flash_ping send failed: {e}")
            return None
        if not self._pong_event.wait(timeout=timeout_s):
            return None
        with self._lock:
            return self._last_pong

    def _send_chunk_with_retry(self, idx: int, hex_payload: str) -> bool:
        """Send one OTA chunk and wait for ack, retrying nacks/timeouts.

        The receiver de-duplicates by chunkIdx (silently re-acks if it has
        already applied the chunk), so resending after a lost ACK is
        always safe -- in the worst case we just waste a frame.

        Retry strategy interleaves regular `flash_data` resends with
        escalating `flash_recover` calls (FW v14):
          attempts 0,1,2: normal flash_data resend
          attempt 3:      flash_recover <idx> 0  (REPLAY)
          attempts 4,5:   flash_data resend
          attempt 6:      flash_recover <idx> 1  (SOFT)
          attempts 7,8:   flash_data resend
          attempt 9:      flash_recover <idx> 2  (FULL)
          attempts 10,11: flash_data resend

        Before each escalating recovery (attempts 3, 6, 9) we send
        `flash_ping` to confirm the dongle's main loop is making progress.
        If it isn't, we log the wedge but continue retrying -- the
        dongle's hardware task watchdog (20s) is the backstop.

        Returns True on ack, False on terminal failure (host abort or
        all retries exhausted). On terminal failure the driver is left
        in ERROR/ABORTED state and `flash_abort` has been issued.
        """
        last_err = "unknown"
        for attempt in range(CHUNK_HOST_RETRIES):
            if self._abort_requested:
                self._send("flash_abort")
                self._set_phase(OtaPhase.ABORTED, "host abort")
                return False

            # Drain any leftover events from a prior attempt before we
            # send -- otherwise a stale nack from `idx-1` could be
            # mistaken for *this* chunk's response.
            if attempt > 0:
                self._drain_events()

            recovery_level = RECOVERY_SCHEDULE.get(attempt)
            if recovery_level is None:
                # Normal `flash_data` resend.
                self._send(f"flash_data {idx} {hex_payload}")
            else:
                # Escalating recovery. First confirm the dongle is alive
                # at the serial layer -- a fast pong tells us serial
                # backpressure has cleared and the main loop is moving.
                pong = self._wait_for_pong(PING_TIMEOUT_S)
                if pong is None:
                    print(
                        f"OTA: chunk {idx}: dongle ping timeout before "
                        f"level={recovery_level} recovery (loop wedged?); "
                        f"sending recovery anyway"
                    )
                else:
                    print(
                        f"OTA: chunk {idx}: dongle alive (att={pong.get('att')} "
                        f"acked={pong.get('acked')}), escalating to "
                        f"flash_recover level={recovery_level}"
                    )
                self._drain_events()
                self._send(f"flash_recover {idx} {recovery_level}")

            with self._lock:
                self.state.chunks_sent = idx + 1
                if attempt > 0:
                    self.state.chunks_retried += 1

            outcome = self._await_chunk_outcome(idx)
            if outcome == "ack":
                return True
            if outcome == "abort":
                return False  # _await_chunk_outcome already set state
            if outcome == "fatal":
                return False
            if outcome == "dongle_gone":
                # Silence-based abort already set ERROR phase; no point
                # sending flash_abort because the dongle isn't listening.
                return False
            # outcome is "nack" or "timeout" -- back off and retry.
            last_err = (
                f"{outcome}{'+recover'+str(recovery_level) if recovery_level is not None else ''}"
            )
            print(
                f"OTA: chunk {idx} {outcome} on host attempt "
                f"{attempt+1}/{CHUNK_HOST_RETRIES} -- retrying"
            )
            self._mark_dirty()  # surface the rising chunks_retried counter

            # Linear backoff capped at 1s so a long retry tail doesn't
            # let the receiver's 30s OTA inactivity watchdog tear down
            # the session out from under us.
            time.sleep(min(1.0, NACK_BACKOFF_S * (attempt + 1)))

        # Out of retries. Tear the receiver down before bailing.
        self._set_phase(
            OtaPhase.ERROR,
            f"chunk {idx} failed after {CHUNK_HOST_RETRIES} host retries "
            f"(last={last_err}); link is too lossy",
        )
        try:
            self._send("flash_abort")
        except Exception:
            pass
        return False

    def _dongle_silence_s(self) -> float:
        """Seconds since we last heard *anything* from the dongle.

        Used to distinguish "RF link lossy but dongle alive" (acks/
        nacks/heartbeats still arriving) from "dongle rebooted" (silence
        across all event types). The latter is unrecoverable mid-chunk,
        so we bail rather than spin retries forever.
        """
        with self._lock:
            if self._last_dongle_event_ms == 0:
                return 0.0
            return (int(time.time() * 1000) - self._last_dongle_event_ms) / 1000.0

    def _await_chunk_outcome(self, idx: int) -> str:
        """Wait for a single ack/nack/timeout for chunk `idx`.

        Returns one of: "ack", "nack", "timeout", "abort", "fatal",
        "dongle_gone". On "ack" the driver state is updated; on
        "abort"/"fatal"/"dongle_gone" the phase is set and no further
        retry should be attempted.
        """
        deadline = time.time() + CHUNK_ACK_TIMEOUT_S
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return "timeout"
            # Bail early if the dongle has been silent long enough that
            # we're clearly past a reboot (WDT, USB drop, etc.). No
            # point waiting out the full per-chunk timeout if the chip
            # isn't there to answer.
            silence = self._dongle_silence_s()
            if silence > DONGLE_SILENCE_ABORT_S:
                self._set_phase(
                    OtaPhase.ERROR,
                    f"dongle went silent for {silence:.0f}s "
                    f"(rebooted? bridge disconnected?); aborting"
                )
                return "dongle_gone"
            evt = self._next_event(timeout_s=min(remaining, 1.0))
            if not evt:
                continue
            phase = evt.get("phase")
            if phase == "_abort_local":
                self._send("flash_abort")
                self._set_phase(OtaPhase.ABORTED, "host abort")
                return "abort"
            if phase == "ack" and int(evt.get("idx", -1)) == idx:
                with self._lock:
                    self.state.chunks_acked = idx + 1
                    self.state.bytes_acked = (idx + 1) * OTA_CHUNK_BYTES
                    if self.state.bytes_acked > self.state.total_bytes:
                        self.state.bytes_acked = self.state.total_bytes
                    self.state.last_event_ms = int(time.time() * 1000)
                return "ack"
            if phase == "nack" and int(evt.get("idx", -1)) == idx:
                if evt.get("fatal"):
                    self._set_phase(
                        OtaPhase.ERROR,
                        f"chunk {idx}: receiver dropped out of OTA "
                        f"({evt.get('fatal')})",
                    )
                    return "fatal"
                return "nack"
            # Unrelated event (e.g. stale ack from a prior chunk that
            # raced with our retry). Discard and keep waiting.
            if phase in ("ack", "nack"):
                # Silently drop -- common during retries when the
                # original frame eventually got through after we'd
                # already started the next attempt.
                continue
            print(f"OTA: ignoring stale event during chunk {idx}: {evt}")

    def _wait_for_finalization(self):
        deadline = time.time() + REJOIN_DEADLINE_S
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                self._set_phase(OtaPhase.ERROR, "rejoin timeout")
                return
            evt = self._next_event(timeout_s=remaining)
            if not evt:
                continue
            phase = evt.get("phase")
            if phase == "_abort_local":
                self._send("flash_abort")
                self._set_phase(OtaPhase.ABORTED, "host abort")
                return
            if phase == "end_sent":
                # Just informational: receiver was told to commit.
                # Keep waiting for done/timeout.
                continue
            if phase == "done":
                self._set_phase(OtaPhase.DONE)
                return
            if phase == "timeout":
                self._set_phase(OtaPhase.ERROR, "receiver did not rejoin")
                return
            if phase == "error":
                err = evt.get("err") or "unknown"
                self._set_phase(OtaPhase.ERROR, f"finalization error: {err}")
                return
            # Anything else is informational; keep waiting.
