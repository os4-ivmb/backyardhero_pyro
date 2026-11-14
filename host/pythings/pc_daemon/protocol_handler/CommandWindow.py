"""Windowed, acknowledged command sending to the dongle (T14).

Dongle firmware that advertises bit 0 of `caps` in its status tick accepts
an optional `#<seq> ` prefix on any host line and answers each prefixed line
with exactly one

    K <seq> <result> <queue_depth>

    result 1 = delivered (radio auto-ACK) / handled immediately
           0 = not delivered after all repeats
           2 = dropped (queue full, evicted, scrubbed by a later STOP)
           3 = rejected by the parser

CommandWindow keeps up to WINDOW sequenced commands outstanding, so the host
paces itself on the dongle's real throughput instead of fixed sleeps, and
learns which individual commands failed. Priority commands (stop, pause,
manual fire) bypass the window.

Without the capability (an older dongle, or before the first status tick
after a reconnect) every call falls back to the old behaviour: send the bare
line and sleep a fixed spacing. Futures then resolve with RESULT_UNKNOWN.
"""

import threading
import time
from collections import deque
from concurrent.futures import Future

RESULT_NOT_DELIVERED = 0
RESULT_DELIVERED = 1
RESULT_DROPPED = 2
RESULT_REJECTED = 3
RESULT_TIMEOUT = -1
RESULT_RESET = -2          # bridge reconnected / dongle reopened
RESULT_UNKNOWN = None      # legacy dongle: no ack available

RESULT_NAMES = {
    RESULT_NOT_DELIVERED: "not delivered",
    RESULT_DELIVERED: "delivered",
    RESULT_DROPPED: "dropped (queue full)",
    RESULT_REJECTED: "rejected",
    RESULT_TIMEOUT: "no ack (timeout)",
    RESULT_RESET: "link reset",
    RESULT_UNKNOWN: "unknown",
}

DONGLE_CAP_CMD_ACKS = 0x01

WINDOW = 16
ACK_TIMEOUT_S = 2.0
LEGACY_SPACING_S = 0.03


def result_ok(result):
    """True for delivered, and for 'unknown' on a legacy dongle (nothing
    better to go on)."""
    return result == RESULT_DELIVERED or result is RESULT_UNKNOWN


class CommandWindow:
    def __init__(self, send_line, window=WINDOW, ack_timeout_s=ACK_TIMEOUT_S):
        # send_line(str) writes one raw line (no newline) to the bridge.
        self._send_line = send_line
        self.window = window
        self.ack_timeout_s = ack_timeout_s
        self._lock = threading.Condition()
        self._enabled = False
        self._next_seq = 1
        # seq -> [cmd, future, deadline, counts_toward_window]
        self._outstanding = {}
        self._in_window = 0
        self._waiting = deque()   # (cmd, future)
        # Threads that must never block on an ack (the bridge read thread:
        # it is the one that delivers the acks).
        self._no_wait_threads = set()
        self._timer = threading.Thread(target=self._timeout_loop, name="cmd-window", daemon=True)
        self._timer.start()

    # ------------------------------------------------------------------
    # Capability
    # ------------------------------------------------------------------
    def mark_no_wait_thread(self, thread=None):
        self._no_wait_threads.add((thread or threading.current_thread()).ident)

    @property
    def enabled(self):
        return self._enabled

    def note_caps(self, caps):
        try:
            enabled = bool(int(caps) & DONGLE_CAP_CMD_ACKS)
        except (TypeError, ValueError):
            enabled = False
        if enabled != self._enabled:
            print(f"CommandWindow: command acks {'enabled' if enabled else 'disabled'}")
            if not enabled:
                self.reset()
            self._enabled = enabled

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------
    def submit(self, cmd, priority=False):
        """Queue one command line. Returns a Future resolving to a RESULT_*.

        Priority commands are sent immediately, outside the window. In
        legacy mode the line is sent bare right away and the future
        resolves to RESULT_UNKNOWN (the caller does its own pacing)."""
        fut = Future()
        if not self._enabled:
            self._send_line(cmd)
            fut.set_result(RESULT_UNKNOWN)
            return fut
        with self._lock:
            if priority:
                self._send_locked(cmd, fut, counts=False)
            elif self._in_window < self.window and not self._waiting:
                self._send_locked(cmd, fut, counts=True)
            else:
                self._waiting.append((cmd, fut))
        return fut

    def submit_many(self, cmds, priority=False, retry=1, legacy_spacing_s=LEGACY_SPACING_S,
                    abort_event=None, wait=True):
        """Send a batch and (by default) wait for every result.

        Failed commands (anything but delivered) are retried `retry` times.
        Returns a list of (cmd, result) for the commands that still failed.
        In legacy mode the lines are paced with `legacy_spacing_s` and
        nothing can be reported as failed.
        """
        cmds = list(cmds)
        if wait and threading.get_ident() in self._no_wait_threads:
            wait = False
        if not self._enabled:
            for cmd in cmds:
                if abort_event is not None and abort_event.is_set():
                    break
                self._send_line(cmd)
                if legacy_spacing_s:
                    time.sleep(legacy_spacing_s)
            return []
        pending = cmds
        failures = []
        final = []   # rejected by the parser: retrying cannot help
        for attempt in range(retry + 1):
            if abort_event is not None and abort_event.is_set():
                break
            futs = [(cmd, self.submit(cmd, priority=priority)) for cmd in pending]
            if not wait:
                return []
            failures = []
            for cmd, fut in futs:
                try:
                    res = fut.result(timeout=self.ack_timeout_s * (self.window + 2))
                except Exception:
                    res = RESULT_TIMEOUT
                if res == RESULT_REJECTED:
                    final.append((cmd, res))
                elif not result_ok(res):
                    failures.append((cmd, res))
            # A legacy fallback mid-batch (caps lost) can't be retried usefully.
            if not failures or not self._enabled:
                break
            pending = [cmd for cmd, _res in failures]
        return final + failures

    def _send_locked(self, cmd, fut, counts):
        seq = self._next_seq
        self._next_seq = 1 if self._next_seq >= 65535 else self._next_seq + 1
        # A 16-bit sequence can only collide after 65535 commands while one
        # is still outstanding; fail the stale one rather than mis-resolve.
        stale = self._outstanding.pop(seq, None)
        if stale is not None:
            self._finish_locked(stale, RESULT_TIMEOUT)
        self._outstanding[seq] = [cmd, fut, time.monotonic() + self.ack_timeout_s, counts]
        if counts:
            self._in_window += 1
        try:
            self._send_line(f"#{seq} {cmd}")
        except Exception as e:
            print(f"CommandWindow: send failed for {cmd!r}: {e}")

    def _finish_locked(self, entry, result):
        cmd, fut, _deadline, counts = entry
        if counts:
            self._in_window = max(0, self._in_window - 1)
        if not fut.done():
            fut.set_result(result)

    def _pump_locked(self):
        while self._waiting and self._in_window < self.window and self._enabled:
            cmd, fut = self._waiting.popleft()
            self._send_locked(cmd, fut, counts=True)
        self._lock.notify_all()

    # ------------------------------------------------------------------
    # Inbound
    # ------------------------------------------------------------------
    def on_ack(self, seq, result, queue_depth=None):
        with self._lock:
            entry = self._outstanding.pop(seq, None)
            if entry is None:
                return False
            self._finish_locked(entry, result)
            self._pump_locked()
        return True

    def handle_line(self, line):
        """Parse a `K <seq> <result> <q>` line. Returns True if it was one."""
        if not line.startswith('K '):
            return False
        parts = line.split()
        try:
            seq = int(parts[1])
            result = int(parts[2])
            q = int(parts[3]) if len(parts) > 3 else None
        except (IndexError, ValueError):
            print(f"CommandWindow: bad ack line {line!r}")
            return True
        self.on_ack(seq, result, q)
        return True

    def reset(self, reason=RESULT_RESET):
        """Fail everything outstanding or waiting (bridge reconnect, dongle
        reopened, capability lost)."""
        with self._lock:
            entries = list(self._outstanding.values())
            self._outstanding.clear()
            for e in entries:
                self._finish_locked(e, reason)
            self._in_window = 0
            while self._waiting:
                _cmd, fut = self._waiting.popleft()
                if not fut.done():
                    fut.set_result(reason)
            self._lock.notify_all()

    def _timeout_loop(self):
        while True:
            time.sleep(0.1)
            now = time.monotonic()
            with self._lock:
                expired = [s for s, e in self._outstanding.items() if e[2] <= now]
                for s in expired:
                    self._finish_locked(self._outstanding.pop(s), RESULT_TIMEOUT)
                if expired:
                    self._pump_locked()

    def stats(self):
        with self._lock:
            return {
                "enabled": self._enabled,
                "outstanding": len(self._outstanding),
                "waiting": len(self._waiting),
            }
