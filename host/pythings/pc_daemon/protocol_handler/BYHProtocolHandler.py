import os
import tempfile
import time
import serial
import sqlite3
import threading
from collections import deque
from datetime import datetime
import json
from enum import Enum
from led_control import *
from config_loader import load_system_config

from .OtaFlashDriver import OtaFlashDriver
from .CommandWindow import RESULT_NAMES
from .DongleFlashDriver import DongleFlashDriver

# Base dirs are env-overridable (defaults reproduce the original container
# paths so Docker/Pi are unchanged; the desktop supervisor sets them to
# writable per-user dirs).
_DATA_DIR = os.environ.get("BYH_DATA_DIR", "/data")
_CONFIG_DIR = os.environ.get("BYH_CONFIG_DIR", "/config")

# Path for the full per-channel RF scan dump. Kept separate from the state
# file because it's bulky (~3KB JSON for 126 channels) and infrequent (only
# updated on operator-initiated scans).
LAST_SCAN_FILE_PATH = os.path.join(_DATA_DIR, 'last_scan.json')

DEBUG = False

#T- to show start when signaled to start.
SHOW_START_TIME_SECONDS = 25
#If we havent gotten start statuses from async nodes by ABORT_PRE_START_SECONDS before the start, abort.
ABORT_PRE_START_SECONDS = 10

cfg_filepath = os.path.join(_CONFIG_DIR, 'systemcfg.json')
# The Receivers table in this DB is the source of truth for which receivers
# the dongle should know about. systemcfg.json still owns protocols / types /
# system block.
db_filepath = os.path.join(_DATA_DIR, 'backyardhero.db')

LATENCY_TO_CONSIDER_ONLINE_MS = 8000
ASYNC_LOAD_TIMEOUT_MS = 5000

# Hard ceiling on how long the daemon will keep retrying an async show
# load before failing it visibly. Without this the retry loop in
# updateRelevantStates spins forever on a receiver that never reaches
# loadComplete (H4). The operator can also cancel manually from the UI
# (abort_show_load) before this fires.
LOAD_TIMEOUT_SECONDS = 60
# Load supervisor (T15): how often it checks, the minimum quiet time before a
# receiver's load is re-sent (also >= 2 poll intervals), and how many sends a
# receiver gets before the load fails naming it.
LOAD_SUPERVISOR_TICK_S = 0.25
LOAD_RESEND_MIN_S = 3.0
LOAD_MAX_ATTEMPTS = 4

# stop_all(): STOP is idempotent on the receivers, so it is sent in several
# passes rather than trusting one. The first pass goes out immediately; the
# repeat passes run on a short-lived thread at these offsets (seconds after
# the first pass) so the caller returns promptly.
STOP_REPEAT_OFFSETS_S = (0.3, 1.0)
# Host-side spacing between stop lines inside one pass. A stop dispatches on
# the dongle in ~3ms and its queue holds 128+, so 5ms keeps the queue shallow
# without the 30ms fan-out pacing used for routine traffic.
STOP_SEND_SPACING_S = 0.005
# A stop from inside run_show() is skipped when stop_all() already ran this
# recently (the operator's stop path sends it directly).
STOP_DEDUPE_WINDOW_S = 2.0
# Receivers that report play state and still say "playing" this long after
# the first stop pass are named in an operator error.
STOP_CONFIRM_TIMEOUT_S = 2.0

# Timestamped pause / resume (T25). Resume is scheduled this far ahead (plus
# a little per receiver) so every receiver has the PLAY before it takes
# effect and they all resume at the same show instant.
RESUME_LEAD_S = 1.5
RESUME_LEAD_PER_RECEIVER_S = 0.005
DONGLE_CAP_TIMED_PAUSE = 0x02
DONGLE_CAP_BCAST = 0x04
# Broadcast control ops (T27, dongle `bcast <op> <showId> <at>`).
BCAST_STOP, BCAST_PAUSE, BCAST_PLAY, BCAST_SHOW_START = 1, 2, 3, 4
RX_CAP_TIMED_PAUSE = 0x02

def chunk_list(lst, n):
    """Yield successive n-sized chunks from lst."""
    for i in range(0, len(lst), n):
        yield lst[i:i + n]

class START_SEQUENCE_STEPS(Enum):
    STANDBY = 0
    LOADING = 1
    LOADED = 2
    AWAIT_USER_START_SIGNAL = 3
    START_PENDING = 4
    START_CONFIRMED = 5
    STARTED = 6
    ABORTED = 7
    STOPPED = 8

class BSCFireTranslator:
    def translate_zone_target_to_tx_pkg(zone, target, repetition=8):
        actual_zone = zone
        if(isinstance(zone, str)):
            actual_zone = int(zone)

        adj_zone = 123-int(actual_zone)
        adj_target = 15-int(target)

        dev_preamble = 0xe3 << (4*4)
        zone = adj_zone << (2*4)
        safebit = 7 << 4
        targetbit = adj_target
        rtn_str = str(bin(dev_preamble | zone | safebit | targetbit)).split("b")[1]

        return f">>{rtn_str}:{repetition}<<"

class BYHProtocolHandler:
    def __init__(self, parent):
        self.token = "{"
        self.protocol = "BKYD_TS_HYBRID"
        self.schedule_stop_event = threading.Event()  # Used to stop schedules
        self.schedule_pause_event = threading.Event() # that but pause
        self.running_show = False  # Set running state
        self.time_cursor = -1
        self.errors = []
        self.show_loaded = False
        self.parent = parent
        self.last_status_ts = 0
        self.show_id=0
        self.load_waiting = False
        self.load_start_ts = 0
        self.async_retry_ct = 0
        self.status = START_SEQUENCE_STEPS.STANDBY
        self.config = {}

        self.firing_array = []
        self.receivers = {}
        self.types = {}
        self.async_load_targets = {}
        self.show_start_time = 0
        # stop_all() bookkeeping. _stop_generation is bumped by every
        # stop_all() and by anything that must cancel pending repeat passes
        # (a new load or show start), so a stale repeat thread exits instead
        # of stopping a show that started after it.
        self._stop_generation = 0
        self._last_stop_all_mono = 0.0
        # Load supervision (T15). _load_abort is replaced per load and set
        # to end that load's send loop and supervisor; _load_state tracks
        # {ident: {"last_send": monotonic, "attempts": n}}.
        self._load_abort = threading.Event()
        self._load_abort.set()
        self._load_state = {}
        self._load_lock = threading.RLock()
        # Idents of receiver rows that exist only in self.receivers
        # because the currently-loaded show owns a Bilusocn 433MHz zone
        # and we need three 4-cue rows (1-4, 5-8, 9-12) per zone for
        # resolve_zone_target_to_device_id to find them. Cleared on
        # unload_show. NEVER persisted to the DB.
        self.ephemeral_receiver_idents = set()
        
        # Track latency samples for sliding average (max 20 samples per receiver).
        # deque(maxlen=20) gives us O(1) append + automatic eviction instead of
        # O(n) list.pop(0).
        self.latency_samples = {}  # Key: receiver ident, Value: deque of values

        # OTA flash driver (firmware push from host -> dongle -> receiver).
        # Single in-flight job at a time; the driver thread enforces this
        # internally. Lives on the protocol handler so it can share the
        # dongle's serial connection and pipe events from process_serial_in.
        self.ota_driver = OtaFlashDriver(parent)

        # Dongle-update driver. Talks HTTP to the host-side bridge's
        # /flash_dongle endpoint -- the dongle's USB-CDC port is owned
        # by the bridge process, so this driver can't drive esptool
        # directly. It mirrors the bridge's per-job snapshot into
        # fw_state.dongle_ota for the UI.
        self.dongle_flash_driver = DongleFlashDriver(parent)

        self.load_initial_receiver_cfg()
        print(f"Initialized Protocol {self.protocol}")
        self.sync_tx_clock()
        # With the ACK-payload protocol, receivers no longer self-announce;
        # the dongle only learns about a receiver after we send it a command.
        # Pre-register every receiver from config so the dongle's TDMA poller
        # starts pinging them immediately, even before the first show traffic.
        self._register_all_receivers_with_dongle()

    def _register_receiver_with_dongle(self, rcv_ident, rcv_cfg):
        """Send a no-op sync to a single nRF24 receiver so the dongle adds it
        to its poll table. Skips 433MHz-only devices that don't use the
        dongle's RF protocol."""
        if rcv_cfg.get("type") == "BILUSOCN_433_TX_ONLY":
            return False
        try:
            self.parent.send_serial_command(f"sync {rcv_ident} 0 1")
            return True
        except Exception as e:
            print(f"WARN: could not register {rcv_ident}: {e}")
            return False

    def _register_all_receivers_with_dongle(self):
        """Pre-register every (enabled) receiver from config so the dongle's
        TDMA poller starts pinging them immediately, even before any show
        traffic. Paced by the command window (or lightly spaced on a dongle
        without command acks). Never waits for results: this runs on the
        bridge read thread when the handler is built."""
        cmds = [f"sync {ident} 0 1" for ident, cfg in list(self.receivers.items())
                if cfg.get("type") != "BILUSOCN_433_TX_ONLY"]
        self._send_batch(cmds, retry=0, wait=False)

    # ------------------------------------------------------------------
    # Paced sending (T14). With a dongle that acks `#<seq>` lines, batches
    # go through the daemon's CommandWindow (up to 16 in flight, failures
    # reported and retried). Otherwise the old fixed spacing applies.
    # ------------------------------------------------------------------
    def _window(self):
        return getattr(self.parent, 'command_window', None)

    def _send_batch(self, cmds, priority=False, legacy_spacing_s=0.03, retry=1,
                    wait=True, abort_event=None):
        """Send command lines in order. Returns [(cmd, result)] for the ones
        that failed after `retry` retries (always [] without acks or when
        not waiting)."""
        window = self._window()
        if window is None:
            for cmd in cmds:
                if abort_event is not None and abort_event.is_set():
                    break
                self.parent.send_serial_command(cmd)
                if legacy_spacing_s:
                    time.sleep(legacy_spacing_s)
            return []
        return window.submit_many(cmds, priority=priority, retry=retry,
                                  legacy_spacing_s=legacy_spacing_s,
                                  abort_event=abort_event, wait=wait)

    def _acks_enabled(self):
        window = self._window()
        return bool(window is not None and window.enabled)

    @staticmethod
    def _describe_failures(failures):
        return ", ".join(f"{cmd.split()[1] if len(cmd.split()) > 1 else cmd}: "
                         f"{RESULT_NAMES.get(res, res)}" for cmd, res in failures)

    def _forget_receiver_on_dongle(self, rcv_ident):
        """Tell the dongle to drop a receiver from its poll table immediately,
        regardless of whether it's "online". Paired with the dongle's
        `forget IDENT` serial command."""
        try:
            self.parent.send_serial_command(f"forget {rcv_ident}")
        except Exception as e:
            print(f"WARN: could not forget {rcv_ident}: {e}")

    #Just something that runs periodically to then invoke housekeeping things
    def bounce(self):
        self.sync_tx_clock()

    def sync_tx_clock(self):
        sync_message = "msync 0 " + str(int(time.time() * 1000)) + "\n"
        print("Syncing tx host clock:", sync_message.strip())
        self.parent.send_serial_command(sync_message)

    def on_dongle_reconnected(self):
        """Self-heal after the dongle's USB serial was (re)opened by the bridge
        -- hot-replug, sleep/resume, or a WDT soft-reset. A rebooted dongle
        comes back with tsOffset=0 (boot-relative clock) and an EMPTY receiver
        poll table, while the receivers themselves keep their loaded cues. That
        combination is exactly the "show still shows loaded but fires zero
        cues" failure: showloadn used relative offsets so the load looks fine,
        but showstart ships absolute epoch ms against a boot-relative clock and
        the dongle isn't even polling the receivers anymore.

        Re-establish both halves the dongle lost on reboot: re-msync the host
        wall clock so receiver clock-sync goes back to the epoch domain, and
        re-register every receiver so the dongle's TDMA poller starts pinging
        them again. The loaded-show state on this handler is intentionally
        preserved -- the receivers still hold the cues, so once the dongle is
        re-synced and re-polling, firing works without a reload."""
        print("Dongle reconnect detected: re-syncing clock + re-registering receivers")
        try:
            self.sync_tx_clock()
        except Exception as e:
            print(f"WARN: msync after dongle reconnect failed: {e}")
        try:
            self._register_all_receivers_with_dongle()
        except Exception as e:
            print(f"WARN: receiver re-registration after dongle reconnect failed: {e}")

    def _load_receivers_from_db(self):
        """Read the Receivers table and project it into the legacy
        `{ ident: { label, type, cues, enabled, metadata, configuration_version } }`
        map shape that the rest of this handler (and the broadcast state file)
        already speaks. Only `enabled=1` rows are returned — disabled ones
        must not be in `self.receivers` because that map drives the dongle's
        poll list."""
        out = {}
        try:
            conn = sqlite3.connect(db_filepath)
            try:
                conn.row_factory = sqlite3.Row
                cur = conn.cursor()
                cur.execute(
                    "SELECT id, label, type, cues_data, enabled, metadata, "
                    "configuration_version FROM Receivers"
                )
                for row in cur.fetchall():
                    if int(row['enabled']) != 1:
                        continue
                    try:
                        cues = json.loads(row['cues_data']) if row['cues_data'] else {}
                    except json.JSONDecodeError:
                        cues = {}
                    try:
                        meta = json.loads(row['metadata']) if row['metadata'] else {}
                    except json.JSONDecodeError:
                        meta = {}
                    out[row['id']] = {
                        'label': row['label'],
                        'type': row['type'],
                        'cues': cues,
                        'enabled': True,
                        'metadata': meta,
                        'configuration_version': int(row['configuration_version']),
                    }
            finally:
                conn.close()
        except sqlite3.Error as e:
            print(f"ERROR: could not read Receivers from DB: {e}")
        return out

    def load_initial_receiver_cfg(self):
        # Receivers come from the SQL Receivers table (DB is source of truth).
        # Protocols / types / system block still come from systemcfg.json.
        self.receivers = self._load_receivers_from_db()
        try:
            # Merged base systemcfg.json + operator systemcfg.user.json.
            data = load_system_config()
            self.types = data.get('types', {})
            self.config = data.get('protocols', {}).get(self.protocol, {}).get('config', {}) or {}
        except Exception as e:
            print(f"Error loading BYH config: {e}")
            self.parent.write_error(f"Error parsing BYH config file at {cfg_filepath}")
            self.types = {}
            self.config = {}

        if not self.receivers:
            self.parent.write_error(
                "Receivers table is empty — no receivers will be polled."
            )

    def reload_receivers_from_db(self):
        """Re-read the Receivers table and reconcile the dongle's poll list:
          - newly-enabled / newly-added receivers get a `sync` (registration);
          - rows that disappeared (deleted) or flipped to enabled=0 get a
            `forget` so the dongle drops them immediately.

        Existing `status` substructures are preserved across the reload so
        the live state broadcast doesn't blink for unaffected receivers.
        """
        old_map = self.receivers or {}
        new_map = self._load_receivers_from_db()

        # Carry over live status / drift / latency for receivers that survive.
        for ident, def_ in new_map.items():
            prev = old_map.get(ident)
            if prev:
                if 'status' in prev:
                    def_['status'] = prev['status']
                if 'drift' in prev:
                    def_['drift'] = prev['drift']

        # Forget anyone that was previously registered but is no longer in
        # the new map (deleted or disabled).
        forgotten = []
        for ident, prev in old_map.items():
            if ident in new_map:
                continue
            if prev.get('type') == 'BILUSOCN_433_TX_ONLY':
                continue
            # Ephemeral rows (synthesized for a Bilusocn show zone) are
            # not in the DB by design, so they trivially won't be in
            # `new_map` -- but they aren't registered with the dongle
            # either, and we want to preserve them across reloads (a
            # show stays loaded across a Receivers-page edit). Skip the
            # forget AND keep them in self.receivers below.
            if prev.get('__ephemeral'):
                continue
            forgotten.append(ident)
        self._send_batch([f"forget {ident}" for ident in forgotten], retry=0, wait=False)

        # Register anyone new (or re-enabled). Always re-issuing sync for
        # already-known receivers is harmless — the dongle's TDMA poller will
        # absorb the no-op.
        registered = [ident for ident, def_ in new_map.items()
                      if ident not in old_map and def_.get("type") != "BILUSOCN_433_TX_ONLY"]
        self._send_batch([f"sync {ident} 0 1" for ident in registered], retry=0, wait=False)

        # Drop dropped latency sample buffers so memory doesn't grow forever
        # across many enable/disable cycles.
        for ident in list(self.latency_samples.keys()):
            if ident not in new_map:
                self.latency_samples.pop(ident, None)

        # Carry forward any ephemeral rows the currently-loaded show
        # synthesized for its Bilusocn zones. They live solely on the
        # protocol handler (no DB row) and would otherwise be wiped by
        # this DB-driven rebuild, breaking fire resolution mid-show.
        for ident in self.ephemeral_receiver_idents:
            prev = old_map.get(ident)
            if prev is not None:
                new_map[ident] = prev

        self.receivers = new_map
        print(
            f"Reloaded receivers from DB: total={len(new_map)} "
            f"registered={registered} forgotten={forgotten}"
        )
        return {'registered': registered, 'forgotten': forgotten,
                'total': len(new_map)}

    # ----- OTA flashing ------------------------------------------------
    def start_ota_flash(self, ident, image_path, rate=2):
        """Kick off an OTA flash job for the given receiver.

        image_path is a host filesystem path (typically dropped under
        /tmp/ota_staging by the Next.js upload handler). We read the
        bytes here so the driver doesn't need to do filesystem I/O on
        a worker thread that's also driving real-time radio I/O.

        Refuses if a show is loaded or the system is armed -- the dongle
        monopolizes the radio during OTA, and any in-flight or queued
        normal commands would be silently dropped (`scrubQueueForNode`)
        when the dongle enters flash mode.
        """
        if getattr(self.parent, 'dongle_link', 'usb') == 'wireless':
            return False, (
                "OTA refused: receiver OTA is not supported over a "
                "wireless hub connection."
            )
        if self.show_loaded:
            return False, "OTA refused: a show is currently loaded."
        if self.parent.is_armed:
            return False, "OTA refused: system is armed. Disarm first."
        if ident not in self.receivers:
            return False, f"OTA refused: unknown receiver '{ident}'."
        if self.receivers[ident].get('type') == 'BILUSOCN_433_TX_ONLY':
            return False, f"OTA refused: '{ident}' is a one-way TX device."
        if not self.receiver_is_connected(ident):
            return False, f"OTA refused: '{ident}' is not online."

        try:
            with open(image_path, 'rb') as f:
                image = f.read()
        except (FileNotFoundError, IOError) as e:
            return False, f"OTA refused: could not read image: {e}"

        ok, msg = self.ota_driver.start_job(
            ident=ident,
            image_bytes=image,
            rate=int(rate),
            file_name=os.path.basename(image_path),
        )
        if ok:
            self.parent.mark_state_dirty()
        return ok, msg

    def abort_ota_flash(self):
        ok, msg = self.ota_driver.abort()
        if ok:
            self.parent.mark_state_dirty()
        return ok, msg

    def get_ota_state(self):
        return self.ota_driver.snapshot()

    # ----- Dongle update (UI-driven host-side esptool flash) -----------
    def start_dongle_flash(self, *, mode, files, file_names):
        """Submit a dongle update job to the host-side flasher.

        Refuses if a show is loaded or the system is armed (same gating
        as receiver OTA -- we don't want a half-flashed dongle going
        offline mid-show), and refuses if a receiver OTA is in flight
        (the bridge can't share the dongle between esptool and the
        running OTA stream).

        `files` is {hex_offset: filesystem_path}. The Next.js handler
        validated existence + size before staging; we trust those checks
        and just hand the paths to the bridge.
        """
        if self.show_loaded:
            return False, "Dongle update refused: a show is currently loaded."
        if self.parent.is_armed:
            return False, "Dongle update refused: system is armed. Disarm first."
        if self.ota_driver.is_busy():
            return False, "Dongle update refused: a receiver OTA flash is in flight."

        ok, msg = self.dongle_flash_driver.start_job(
            mode=mode, files=files, file_names=file_names,
        )
        if ok:
            self.parent.mark_state_dirty()
        return ok, msg

    def continue_dongle_flash(self, port=None):
        ok, msg = self.dongle_flash_driver.continue_job(port=port)
        if ok:
            self.parent.mark_state_dirty()
        return ok, msg

    def abort_dongle_flash(self):
        ok, msg = self.dongle_flash_driver.abort()
        if ok:
            self.parent.mark_state_dirty()
        return ok, msg

    def get_dongle_flash_state(self):
        return self.dongle_flash_driver.snapshot()

    def retry_receiver(self, ident):
        """Re-issue registration for a single receiver. Use this when a
        receiver was pruned by the dongle (timeout) and needs to come back
        without disturbing the others."""
        rcv = self.receivers.get(ident)
        if not rcv:
            print(f"retry_receiver: unknown ident '{ident}' (not in DB-backed map)")
            return False
        if rcv.get('type') == 'BILUSOCN_433_TX_ONLY':
            print(f"retry_receiver: '{ident}' is a one-way TX device; nothing to do.")
            return False
        ok = self._register_receiver_with_dongle(ident, rcv)
        if ok:
            print(f"retry_receiver: re-registered {ident}")
        return ok

    # ----- RF spectrum scan ---------------------------------------------
    def start_rf_scan(self, passes=10, ch_start=0, ch_end=125):
        """Issue the dongle's `scan` serial command. The dongle blocks
        polling for ~passes * (ch_end-ch_start+1) * 0.18ms while it sweeps,
        then emits a single `scan_result` JSON line that's picked up in
        `process_serial_in -> _handle_scan_result`.
        """
        passes   = max(1, min(50, int(passes)))
        ch_start = max(0, min(125, int(ch_start)))
        ch_end   = max(ch_start, min(125, int(ch_end)))

        # Mark the scan as pending so the UI can show a spinner. Cleared
        # in _handle_scan_result. We also stamp this so a stuck scan can
        # be detected (timeout in the UI / state file).
        self.parent.rf_scan_pending_since_ms = int(time.time() * 1000)
        # Route through the flusher so all state writes share the same
        # debounce + unix-socket publish path.
        self.parent.mark_state_dirty()

        cmd = f"scan {passes} {ch_start} {ch_end}"
        print(f"start_rf_scan: sending '{cmd}'")
        self.parent.send_serial_command(cmd)
        return True

    def _handle_scan_result(self, msg_obj):
        """Persist the dongle's scan_result frame to LAST_SCAN_FILE_PATH and
        publish a small summary on self.parent for inclusion in /data/state.
        """
        try:
            results = msg_obj.get('results', []) or []
            # Defensive normalization — drop entries missing keys.
            cleaned = []
            for r in results:
                if 'ch' in r and 'hits' in r:
                    cleaned.append({'ch': int(r['ch']), 'hits': int(r['hits'])})
            if not cleaned:
                print("scan_result: empty results list, ignoring")
                return

            current_ch = msg_obj.get('current_ch')
            passes     = int(msg_obj.get('passes', 0))
            duration   = int(msg_obj.get('duration_ms', 0))
            host_ts_ms = int(time.time() * 1000)

            # --- Recommended channel ----------------------------------
            # Score = own hits + 0.5 * neighborhood hits within +-2.
            # Lower is better. Among ties, prefer the higher channel
            # number (above the 2.4 GHz Wi-Fi band tends to be steadier
            # over time than the gaps between Wi-Fi channels).
            by_ch = {r['ch']: r['hits'] for r in cleaned}
            scored = []
            for r in cleaned:
                ch = r['ch']
                neigh = 0
                for d in (-2, -1, 1, 2):
                    n = by_ch.get(ch + d)
                    if n is not None:
                        neigh += n
                score = r['hits'] + 0.5 * neigh
                scored.append((score, -ch, ch, r['hits']))
            scored.sort()
            recommended_ch = scored[0][2] if scored else None
            top5 = [
                {'ch': s[2], 'hits': s[3], 'score': round(s[0], 2)}
                for s in scored[:5]
            ]

            full_payload = {
                'host_ts_ms':   host_ts_ms,
                'fw':           int(msg_obj.get('fw', 0)),
                'passes':       passes,
                'ch_start':     int(msg_obj.get('ch_start', 0)),
                'ch_end':       int(msg_obj.get('ch_end', 125)),
                'current_ch':   current_ch,
                'duration_ms':  duration,
                'recommended_ch': recommended_ch,
                'top':          top5,
                'results':      cleaned,
            }

            self._write_last_scan_atomic(full_payload)

            # Compact summary for /data/state. Don't include the full
            # 126-bin array here — clients who want the chart fetch
            # /api/system/rf_scan.
            self.parent.last_rf_scan_summary = {
                'host_ts_ms':     host_ts_ms,
                'passes':         passes,
                'duration_ms':    duration,
                'current_ch':     current_ch,
                'recommended_ch': recommended_ch,
                'top':            top5,
            }
            self.parent.rf_scan_pending_since_ms = None
            self.parent.mark_state_dirty()
            print(
                f"scan_result: {len(cleaned)} bins, "
                f"current_ch={current_ch}, recommended_ch={recommended_ch}"
            )
        except Exception as e:
            print(f"scan_result handling failed: {e}")
            self.parent.rf_scan_pending_since_ms = None

    @staticmethod
    def _write_last_scan_atomic(payload):
        """Atomic write to LAST_SCAN_FILE_PATH so HTTP readers never see a
        truncated/partial file (same pattern as update_state_file)."""
        d = os.path.dirname(LAST_SCAN_FILE_PATH) or "."
        tmp_fd, tmp_path = tempfile.mkstemp(
            prefix=".last_scan.", suffix=".tmp", dir=d
        )
        try:
            with os.fdopen(tmp_fd, "w") as f:
                json.dump(payload, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, LAST_SCAN_FILE_PATH)
            tmp_path = None
        finally:
            if tmp_path is not None and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

    def updateRelevantStates(self):
        """Runs on the bridge read thread for every status / rxupd line.

        Only reads state and flips flags: completes the load as soon as
        every target reports loadComplete. All re-sending and timeouts live
        on the load supervisor thread (T15), so incoming status is never
        held up behind a re-send."""
        if self.load_waiting and self.show_id and not self.show_loaded:
            if not self.get_async_load_targets_not_with_status('loadComplete', True):
                self._complete_load()

    def _complete_load(self):
        with self._load_lock:
            if self.show_loaded or not self.load_waiting:
                return
            print("All receivers report loaded. Show loaded.")
            self.show_loaded = True
            self.load_waiting = False
            self.load_start_ts = 0
            self.status = START_SEQUENCE_STEPS.LOADED
            self._load_abort.set()   # ends the supervisor
        self.parent.signal_show_loaded(self.show_id)

    def _load_timeout_s(self):
        # Scales with fleet size until loads are fast (T14 windowed sends).
        return max(LOAD_TIMEOUT_SECONDS, 2.0 * len(self.async_load_targets))

    def _load_resend_after_s(self):
        csi_ms = self.parent.dongle_clock_sync_interval_ms or 2000
        return max(LOAD_RESEND_MIN_S, 2.0 * csi_ms / 1000.0)

    def _start_load_supervisor(self):
        threading.Thread(target=self._load_supervisor, name="load-supervisor",
                         daemon=True).start()

    def _load_supervisor(self):
        """Watches an async load until it completes, fails or is aborted.

        Every LOAD_SUPERVISOR_TICK_S: completes the load when every target
        reports loadComplete; re-sends a receiver's load only when it has
        been quiet for _load_resend_after_s() since its last send; fails the
        load (naming the receiver) after LOAD_MAX_ATTEMPTS sends, or when the
        overall timeout passes."""
        abort = self._load_abort
        while not abort.wait(LOAD_SUPERVISOR_TICK_S):
            if not self.load_waiting or self.show_loaded:
                return
            incomplete = self.get_async_load_targets_not_with_status('loadComplete', True)
            if not incomplete:
                self._complete_load()
                return
            now = time.monotonic()
            if self.load_start_ts and (time.time() - self.load_start_ts) > self._load_timeout_s():
                self._fail_load(
                    f"Show load timed out after {self._load_timeout_s():.0f}s. "
                    f"Receivers still not loaded: {incomplete}"
                )
                return
            resend_after = self._load_resend_after_s()
            for ident in incomplete:
                st = self._load_state.setdefault(ident, {"last_send": now, "attempts": 1})
                if now - st["last_send"] <= resend_after:
                    continue
                if st["attempts"] >= LOAD_MAX_ATTEMPTS:
                    self._fail_load(
                        f"Show load failed: {ident} did not report loaded after "
                        f"{st['attempts']} attempts. Still not loaded: {incomplete}"
                    )
                    return
                if abort.is_set():
                    return
                print(f"Re-sending show load to {ident} (attempt {st['attempts'] + 1})")
                targets = self.async_load_targets.get(ident)
                if targets is None:
                    continue
                self.load_async_fire_targets({ident: targets}, self.show_id, False,
                                             skip_startload=True)

    def _fail_load(self, reason):
        with self._load_lock:
            if not self.load_waiting:
                return
            self._teardown_async_load(send_reset=True)
            self.status = START_SEQUENCE_STEPS.ABORTED
        self.parent.signal_show_load_failed(reason)

    def get_async_load_targets_not_with_status(self, key, state):
        false_device_ids = []
        debug = self.parent.debug_mode
        for device_id, alt in list(self.async_load_targets.items()):
            # A receiver can exist in self.receivers (registered with the
            # dongle) but not yet have a `status` substructure if it hasn't
            # answered a poll. Treat "no status" as "not in desired state"
            # rather than KeyError-ing out of process_serial_in's JSON
            # handler (M3).
            status = self.receivers.get(device_id, {}).get('status')
            if not status:
                if debug:
                    print(f"{device_id}: no status yet; treating as not loaded")
                false_device_ids.append(device_id)
                continue
            if(status.get('showId') == self.show_id):
                if not status.get(key):
                    if debug:
                        print(f"{device_id}:{key} is FALSE as '{status.get(key)}'")
                    false_device_ids.append(device_id)
            else:
                if debug:
                    print(f"Show {self.show_id} not correct for {device_id}({status.get('showId')})")
                false_device_ids.append(device_id)
        return false_device_ids

    def invalidate_cached_start_ready(self):
        """Clear any cached `startReady` flag for this show's async targets.

        The start gate (get_async_load_targets_not_with_status('startReady'))
        trusts the last per-receiver status frame. A receiver that signalled
        startReady on a PRIOR start attempt for the same show id leaves that
        flag latched True in our cache, so a fresh start would sail straight
        past the wait loop without ever confirming THIS run's showstart
        actually landed -- e.g. if showstart was dropped over a flaky link
        right after a replug. Forcing the flag back to False makes the gate
        wait for a fresh startReady reported in response to the showstart we're
        about to send."""
        for device_id in self.async_load_targets:
            status = self.receivers.get(device_id, {}).get('status')
            if status and 'startReady' in status:
                status['startReady'] = False


    # Mapping from the dongle's abbreviated keys to the full-name dict
    # the rest of the daemon (and the UI) consume. Shared across the
    # per-second `status` aggregate AND the FW v7 `rxupd` push line so
    # both shapes parse through one code path.
    #
    # Dongle FW v16+ also includes the receiver-side config (when
    # configValid is true on the dongle) on each per-receiver status
    # entry. They land here so the in-memory `status` substructure
    # surfaces them in the broadcast state file -- the UI doesn't have
    # to round-trip back through the DB to render fw / fire_duration.
    _ABBR_KEY_MAP = {
        'i': 'ident',
        'n': 'node',
        'b': 'battery',
        's': 'showId',
        't': 'lmt',
        'l': 'loadComplete',
        'r': 'startReady',
        'c': 'continuity',
        'x': 'lat',
        'sp': 'successPercent',
        'fw':  'fwVersion',
        'bv':  'boardVersion',
        # Board type (product family): 0 = dedicated os4_receiver, 1 = omni.
        # Reported by dongle FW that reads config-response reserved[1]
        # (os4_dongle v31+, omni v35+). Absent on older dongles.
        'bt':  'boardType',
        'nb':  'numBoards',
        'nbd': 'noBoardsDetected',
        'ca':  'cuesAvailable',
        'fd':  'fireDurationMs',
        # Receiver play state, bit 0 playing / bit 1 paused. Only present
        # for receivers that advertise it (receiver FW with status flags),
        # so a missing key means "unknown", not "idle".
        'pf':  'stateFlags',
        # Average auto-retries per delivered frame x10 (link margin; rises
        # well before successPercent drops).
        'rt':  'retryAvgX10',
        # Receiver capability bits from its config response (bit 0 status
        # flags, bit 1 timestamped pause / resume).
        'rc':  'rxCaps',
        # Receiver's stored RF channel / system ID (rxcfg, T26).
        'sid': 'rfSystemId',
    }

    def _merge_receiver(self, abbr_dict, lmtoffset):
        """Merge one abbreviated receiver dict into self.receivers[ident].

        Returns True if the receiver was known and the merge happened,
        False if the ident is unknown (caller decides whether to log).
        Used by both the per-second `status` aggregate and the FW v7
        `rxupd` push path so the data shape stays identical.
        """
        ident = abbr_dict.get('i')
        if ident not in self.receivers:
            return False

        full_receiver = dict(self.receivers[ident].get('status') or {})
        for abbr_key, full_key in self._ABBR_KEY_MAP.items():
            if abbr_key not in abbr_dict:
                continue
            value = abbr_dict[abbr_key]
            if abbr_key == 't':
                value = value + lmtoffset
            elif abbr_key == 'x':
                # Sliding-average latency. Bounded deque drops the
                # oldest sample automatically once we hit maxlen.
                samples = self.latency_samples.get(ident)
                if samples is None:
                    samples = deque(maxlen=20)
                    self.latency_samples[ident] = samples
                samples.append(value)
                value = round(sum(samples) / len(samples))
            full_receiver[full_key] = value
        if 'pf' in abbr_dict:
            try:
                flags = int(abbr_dict['pf'])
                full_receiver['playing'] = bool(flags & 0x01)
                full_receiver['paused'] = bool(flags & 0x02)
            except (TypeError, ValueError):
                pass
        self.receivers[ident]['drift'] = lmtoffset
        self.receivers[ident]['status'] = full_receiver
        return True

    def process_status_msg(self, msg_obj):
        # Slow-path tick from the dongle: full per-receiver array. Used
        # for housekeeping fields (`x` averaged latency, `sp`
        # success%) that the v7 rxupd push deliberately omits. Acts as a
        # 1Hz heartbeat so dropped rxupd lines self-heal within a second.
        self.last_status_ts = msg_obj.get('timestamp', 0)
        lmtoffset = int(time.time() * 1000) - msg_obj.get('timestamp', 0)
        for receiver in msg_obj.get('receivers', []):
            if not self._merge_receiver(receiver, lmtoffset):
                print(f"Receiver {receiver.get('i')} is not known. Ignoring.")
        self.updateRelevantStates()

    def process_rxupd_msg(self, msg_obj):
        # Fast-path push from the dongle (FW v7+): exactly one receiver
        # update emitted the moment the radio ACK landed.
        #
        # IMPORTANT: the dongle emits rxupd from TWO paths:
        #   1. Successful TX/ACK -- carries `x` (fresh single-sample RTT)
        #      AND a freshly-bumped `t` (lastMessageTime).
        #   2. Failed TX (auto-retries exhausted) -- carries `sp` (success%
        #      now lower) but NO `x` and the OLD `t` from the last
        #      successful contact.
        #
        # We only want to overwrite `t` with host-now on path #1, otherwise
        # silent receivers will appear fresh because every dropped poll
        # still produces a TX-fail rxupd. Use the presence of `x` as the
        # "actually heard from radio" signal -- it's emitted iff the
        # ACK-payload bookkeeping just landed a real sample.
        msg_obj = dict(msg_obj)
        had_radio_contact = ('x' in msg_obj)
        if had_radio_contact:
            # USB-CDC delivery is sub-ms after the radio ACK, so host wall
            # clock at arrival is a more accurate "last seen" than the
            # dongle's tsOffset-corrected stamp (which drifts over hours).
            msg_obj['t'] = int(time.time() * 1000)
        else:
            # Drop `t` entirely so _merge_receiver doesn't clobber the
            # existing lmt with a stale value. The receiver's `lat`/`sp`
            # bookkeeping still updates, but freshness stays bounded by
            # the most recent successful poll -- which is exactly what
            # the UI's red/orange/green coding wants.
            msg_obj.pop('t', None)
        if not self._merge_receiver(msg_obj, lmtoffset=0):
            # Don't spam if the ident is still being learned -- the
            # per-second `status` tick will register it shortly.
            return
        self.updateRelevantStates()

    # Field set written into Receivers.config_data by process_rxcfg_msg.
    # Kept tiny on purpose -- only knobs the dongle/receiver actually
    # echo back belong in here. UI / API never read or write this dict
    # directly; they fetch the parsed object via the receiverQueries
    # helpers and present individual keys.
    _RXCFG_CONFIG_DATA_KEYS = ('fire_duration_ms',)

    # Host-side overrides parked in config_data by the UI / API. The
    # daemon NEVER writes these (they're operator-set), only reads them
    # to decide whether to honour the receiver-reported counts.
    #
    # force_cues_available: int | None -- when set (and > 0), the host
    #   pretends the receiver has exactly this many cues regardless of
    #   what the rxcfg response said. Lets an operator allocate fewer
    #   (or more) addressable cues than NUM_BOARDS auto-detected --
    #   useful when running a smaller show against a fully-populated
    #   receiver, or when a board is partially wired.
    _CONFIG_DATA_HOST_OVERRIDE_KEYS = ('force_cues_available',)

    # Set once the Receivers.board_type column is known to exist. The Next
    # app owns the schema (sqldb.js adds the column too), but the daemon can
    # start first against an older DB, so it adds the column itself rather
    # than failing the whole rxcfg persist.
    _board_type_column_ready = False

    def _ensure_board_type_column(self, cur):
        if BYHProtocolHandler._board_type_column_ready:
            return
        cols = {r[1] for r in cur.execute("PRAGMA table_info(Receivers)").fetchall()}
        if 'board_type' not in cols:
            try:
                cur.execute("ALTER TABLE Receivers ADD COLUMN board_type INTEGER")
            except sqlite3.OperationalError as e:
                # Lost a race with sqldb.js adding it -- fine.
                if 'duplicate column' not in str(e).lower():
                    raise
        BYHProtocolHandler._board_type_column_ready = True

    def _persist_rxcfg_to_db(self, ident, fw, bv, ca, fire_dur, bt=None, rf_ch=None, rf_sid=None):
        """Mirror the receiver-reported config into the Receivers table.

        Skips silently if the row doesn't exist (operator may have just
        deleted the receiver from the UI between the query going out and
        the response landing). config_data is merged into the existing
        JSON so unrelated keys the UI may have parked there survive.

        Also auto-syncs cues_data to reflect the receiver-reported
        cues_available -- the receiver's NUM_BOARDS detection is now
        the source of truth for which cue positions the UI can drive,
        replacing the old "operator types a number in edit mode" flow.
        Skipped for BILUSOCN_433_TX_ONLY (one-way 433MHz units don't
        participate in the CONFIG_QUERY protocol at all, so we never
        get a rxcfg for them, but we belt-and-suspenders the type
        check below for any future single-zone rework).
        """
        try:
            conn = sqlite3.connect(db_filepath)
            try:
                conn.row_factory = sqlite3.Row
                cur = conn.cursor()
                self._ensure_board_type_column(cur)
                cur.execute(
                    "SELECT type, cues_data, config_data FROM Receivers WHERE id = ?",
                    (ident,),
                )
                row = cur.fetchone()
                if row is None:
                    return  # receiver no longer in DB, drop the update
                try:
                    cfg = json.loads(row['config_data']) if row['config_data'] else {}
                except (json.JSONDecodeError, TypeError):
                    cfg = {}
                if not isinstance(cfg, dict):
                    cfg = {}
                if fire_dur is not None:
                    cfg['fire_duration_ms'] = int(fire_dur)
                # Receiver's stored RF channel / system ID (receiver FW with
                # SETRF; absent otherwise, which means the compiled-in 85 / 0).
                if rf_ch is not None:
                    cfg['rf_channel'] = int(rf_ch)
                if rf_sid is not None:
                    cfg['rf_system_id'] = int(rf_sid)

                # Board type picks the OTA image (os4_receiver vs byh_omni).
                # An rxcfg without `bt` comes from a dongle that predates
                # board-type reporting; every receiver it can describe is
                # treated as type 0 (dedicated), same as a zeroed reserved[1].
                try:
                    board_type = int(bt) if bt is not None else 0
                except (TypeError, ValueError):
                    board_type = 0

                # Auto-derive cues_data from the receiver-reported
                # cues_available count. Only touch cues_data when:
                #   * the type isn't 433MHz-only, AND
                #   * we actually have a count to apply (override or
                #     `ca` not None), AND
                #   * the new shape differs from what's already stored.
                # The "differs" check keeps configuration_version stable
                # when nothing changed, so the host doesn't churn the
                # daemon-reload signal on every periodic poll-driven
                # rxcfg.
                #
                # Host override: config_data.force_cues_available pins
                # the effective cue count regardless of what the receiver
                # reports. When the override is set, NUM_BOARDS auto-
                # detection is purely informational. We still record the
                # raw `ca` in the cues_available column so the UI can
                # show "you forced X but the receiver actually reports Y".
                cues_data_param = None
                rcv_type = row['type']
                force_raw = cfg.get('force_cues_available')
                try:
                    force_cues = int(force_raw) if force_raw is not None else None
                except (TypeError, ValueError):
                    force_cues = None
                if force_cues is not None and force_cues <= 0:
                    force_cues = None  # treat 0/negative as "no force"
                effective_cues = (
                    force_cues
                    if force_cues is not None
                    else (int(ca) if ca is not None else None)
                )
                if rcv_type != 'BILUSOCN_433_TX_ONLY' and effective_cues is not None:
                    new_cues_obj = {ident: list(range(1, effective_cues + 1))}
                    try:
                        existing_cues = json.loads(row['cues_data']) if row['cues_data'] else {}
                    except (json.JSONDecodeError, TypeError):
                        existing_cues = {}
                    if existing_cues != new_cues_obj:
                        cues_data_param = json.dumps(new_cues_obj)

                if cues_data_param is not None:
                    cur.execute(
                        """UPDATE Receivers SET
                              fw_version = ?,
                              board_version = ?,
                              board_type = ?,
                              cues_available = ?,
                              config_data = ?,
                              cues_data = ?,
                              configuration_version = configuration_version + 1,
                              updated_at = CURRENT_TIMESTAMP
                           WHERE id = ?""",
                        (
                            int(fw) if fw is not None else None,
                            int(bv) if bv is not None else None,
                            board_type,
                            int(ca) if ca is not None else None,
                            json.dumps(cfg),
                            cues_data_param,
                            ident,
                        ),
                    )
                else:
                    cur.execute(
                        """UPDATE Receivers SET
                              fw_version = ?,
                              board_version = ?,
                              board_type = ?,
                              cues_available = ?,
                              config_data = ?,
                              configuration_version = configuration_version + 1,
                              updated_at = CURRENT_TIMESTAMP
                           WHERE id = ?""",
                        (
                            int(fw) if fw is not None else None,
                            int(bv) if bv is not None else None,
                            board_type,
                            int(ca) if ca is not None else None,
                            json.dumps(cfg),
                            ident,
                        ),
                    )
                conn.commit()

                # Also reflect the new cues into our in-memory map so
                # the daemon's resolve_zone_target_to_device_id keeps
                # working without waiting for the next reload. We don't
                # call reload_receivers_from_db here (that would
                # re-issue sync/forget needlessly).
                if cues_data_param is not None and ident in self.receivers:
                    try:
                        self.receivers[ident]['cues'] = json.loads(cues_data_param)
                    except (json.JSONDecodeError, TypeError):
                        pass
            finally:
                conn.close()
        except sqlite3.Error as e:
            print(f"ERROR: persist rxcfg for {ident} failed: {e}")

    def process_rxcfg_msg(self, msg_obj):
        """Ingest a `rxcfg` JSON line emitted by the dongle (FW v16+) in
        response to a CONFIG_QUERY. Updates the in-memory receiver
        status snapshot AND mirrors the values back into the Receivers
        table so they survive a daemon / host restart.
        """
        ident = msg_obj.get('i')
        if not ident:
            return
        # Update in-memory status so the broadcast state file reflects
        # the new values immediately. Reuse _merge_receiver so the same
        # ABBR -> full-name mapping applies (incl. the new fw/bv/etc.
        # keys added above).
        if ident in self.receivers:
            self._merge_receiver(msg_obj, lmtoffset=0)
            if 'ch' in msg_obj:
                self.receivers[ident].setdefault('status', {})['rfChannel'] = msg_obj.get('ch')
            # Stamp lmt with host-now: the rxcfg arrived via the same
            # USB-CDC path as rxupd does for successful TX, so host time
            # is the most accurate "last contact" we have.
            self.receivers[ident].setdefault('status', {})
            self.receivers[ident]['status']['lmt'] = int(time.time() * 1000)
        else:
            print(f"rxcfg from unknown ident {ident}; ignoring")

        # Persist to DB. Cast through process_rxcfg_msg's input so a
        # missing key (older dongle FW or partial parse) drops gracefully
        # to NULL/None instead of crashing.
        self._persist_rxcfg_to_db(
            ident,
            msg_obj.get('fw'),
            msg_obj.get('bv'),
            msg_obj.get('ca'),
            msg_obj.get('fd'),
            msg_obj.get('bt'),
            msg_obj.get('ch'),
            msg_obj.get('sid'),
        )

    def fetch_receiver_config(self, ident, fire_duration_ms=None):
        """Send a `rxcfg` command to the dongle. With no args it's a
        pure fetch; pass `fire_duration_ms` to also write a new fire
        pulse width before the receiver sends its CONFIG_RESPONSE.

        The receiver's response lands asynchronously as a `rxcfg` JSON
        line that process_rxcfg_msg ingests + persists. Returns True if
        the command was queued on the dongle, regardless of whether the
        receiver eventually answers.
        """
        if ident not in self.receivers:
            print(f"fetch_receiver_config: unknown ident {ident}")
            return False
        if self.receivers[ident].get('type') == 'BILUSOCN_433_TX_ONLY':
            return False  # one-way device; nothing to fetch
        cmd = f"rxcfg {ident}"
        if fire_duration_ms is not None:
            try:
                fdv = int(fire_duration_ms)
            except (TypeError, ValueError):
                print(f"fetch_receiver_config: bad fire_duration_ms {fire_duration_ms!r}")
                return False
            # Receiver firmware clamps to [50, 5000]; reject outright on
            # the host side too so the operator gets immediate feedback
            # rather than silently discovering the clamp later.
            if not (50 <= fdv <= 5000):
                print(f"fetch_receiver_config: fire_duration_ms {fdv} out of range [50, 5000]")
                return False
            cmd += f" fd {fdv}"
        try:
            self.parent.send_serial_command(cmd)
            return True
        except Exception as e:
            print(f"fetch_receiver_config({ident}): {e}")
            return False

    def fetch_all_receiver_configs(self, fire_duration_ms=None):
        """Run fetch_receiver_config across every connected receiver.
        Used by the settings-panel "set fire duration for all receivers"
        action and the UI's "refresh everyone" button. Returns the list
        of ident -> bool results so the caller can surface partial
        failures."""
        results = {}
        for ident in list(self.receivers.keys()):
            if not self.receiver_is_connected(ident):
                results[ident] = False
                continue
            ok = self.fetch_receiver_config(ident, fire_duration_ms=fire_duration_ms)
            results[ident] = ok
            # Light spacing so the dongle's queue doesn't saturate when
            # broadcasting to many receivers. Not needed once the dongle
            # acks commands: then the queue depth is visible per command.
            if not self._acks_enabled():
                time.sleep(0.04)
        return results

    def process_serial_in(self, msg):
        if(self.parent.debug_mode):
            if not (msg.startswith('OA ') or msg.startswith('ON ')
                    or msg.startswith('OS ') or msg.startswith('OP ')
                    or msg.startswith('K ')):
                print("BYH handler got message to look at")
                print(msg)
        if msg.startswith('K '):
            # T14 command ack: K <seq> <result> <queue depth>.
            window = self._window()
            if window is not None:
                window.handle_line(msg)
            return True
        if msg.startswith('OA '):
            # Compact OTA ACK from dongle hot path:
            #   OA <idx> <state> <bytes> <attempts>
            # Avoids JSON overhead for 13k+ per-chunk events.
            try:
                _, idx, state, bytes_received, attempts = msg.split()
                self.ota_driver.feed_event({
                    'type': 'ota',
                    'phase': 'ack',
                    'idx': int(idx),
                    'state': int(state),
                    'bytes': int(bytes_received),
                    'att': int(attempts),
                })
            except Exception as e:
                print(f"OTA: bad compact ack {msg!r}: {e}")
            return True
        if msg.startswith('ON '):
            # Compact OTA NACK:
            #   ON <idx> <rf_ok> <got_ack> <state> <err> <last> <bytes> <fatal>
            try:
                _, idx, rf_ok, got_ack, state, err, last, bytes_received, fatal = msg.split()
                evt = {
                    'type': 'ota',
                    'phase': 'nack',
                    'idx': int(idx),
                    'rf_ok': bool(int(rf_ok)),
                    'got_ack': bool(int(got_ack)),
                    'state': int(state),
                    'err': int(err),
                    'last': int(last),
                    'bytes': int(bytes_received),
                }
                if int(fatal):
                    evt['fatal'] = 'rx_dropped_ota'
                self.ota_driver.feed_event(evt)
            except Exception as e:
                print(f"OTA: bad compact nack {msg!r}: {e}")
            return True
        if msg.startswith('OS '):
            # Compact OTA per-second heartbeat (FW v14+):
            #   v14: OS <attempted> <acked> <retries> <last> <bytes_acked> <phase>
            #   v15: ... <dropped>    -- # serial lines dropped due to
            #                            USB-CDC TX backpressure
            # Replaces the full status JSON during OTA so the dongle's
            # ~256B USB-CDC TX ring buffer doesn't choke under a slow
            # host. We use it only as a liveness signal -- per-chunk
            # OA/ON acks are still authoritative for progress.
            try:
                parts = msg.split()
                hb = {
                    'attempted': int(parts[1]),
                    'acked':     int(parts[2]),
                    'retries':   int(parts[3]),
                    'last':      int(parts[4]),
                    'bytes':     int(parts[5]) if len(parts) > 5 else 0,
                    'phase':     int(parts[6]) if len(parts) > 6 else 0,
                    'dropped':   int(parts[7]) if len(parts) > 7 else 0,
                }
                self.ota_driver.feed_heartbeat(hb)
            except Exception as e:
                print(f"OTA: bad heartbeat {msg!r}: {e}")
            return True
        if msg.startswith('OP '):
            # Compact OTA pong reply to flash_ping (FW v14+):
            #   v14: OP <millis> <attempted> <acked> <retries> <last>
            #   v15: ... <dropped>
            # Used by OtaFlashDriver to detect a wedged dongle before
            # escalating recovery levels.
            try:
                parts = msg.split()
                pong = {
                    'millis':    int(parts[1]),
                    'att':       int(parts[2]) if len(parts) > 2 else 0,
                    'acked':     int(parts[3]) if len(parts) > 3 else 0,
                    'retries':   int(parts[4]) if len(parts) > 4 else 0,
                    'last':      int(parts[5]) if len(parts) > 5 else 0,
                    'dropped':   int(parts[6]) if len(parts) > 6 else 0,
                }
                self.ota_driver.feed_pong(pong)
            except Exception as e:
                print(f"OTA: bad pong {msg!r}: {e}")
            return True
        # Dongle error / command-validation lines are plain text, not JSON.
        # These used to be silently ignored, which is exactly how C1 (433fire
        # rejected with "CV 433") and M7 (queue-full "ERR:" drops) went
        # unnoticed in live shows. Surface them to the operator.
        if msg.startswith('ERR:'):
            detail = msg[4:].strip()
            # A dropped fire command is safety-relevant: flag it loudly.
            if 'queue full' in detail.lower():
                self.parent.write_error(f"Dongle dropped a command (queue full): {detail}")
            else:
                self.parent.write_error(f"Dongle error: {detail}")
            return True
        # "CV ..." = command validation failure; "C? ..." = unknown command.
        # Both mean the dongle rejected something the daemon sent.
        if msg.startswith('CV ') or msg.startswith('C? ') or msg == 'CV' or msg == 'C?':
            # `forget IDENT` is idempotent: the daemon issues it during a
            # reload for every receiver that left the DB, but the dongle only
            # holds receivers it has actually heard from (or that survived its
            # last reboot). "RNF" (receiver-not-found) on a forget just means
            # it was already absent -- which is the exact end state we wanted.
            # Don't surface that benign reconcile no-op as an operator error.
            if msg.startswith('CV forget') and 'RNF' in msg:
                print(f"INFO: forget no-op (already absent): {msg.strip()}")
                return True
            self.parent.write_error(f"Dongle rejected command: {msg.strip()}")
            return True

        if(msg[0] == '{'):
            try:
                msg_obj = json.loads(msg)
                msg_type = msg_obj.get('type','status')
                # Switch-state lines ({"gpio": ...}) have no `type` either;
                # the daemon consumes them itself. They are not status ticks
                # and must not reset dongle fields (board type, caps).
                if msg_type == 'status' and 'gpio' in msg_obj:
                    return True

                if(msg_type == 'status'):
                    # Capture the dongle's own FW version from its
                    # heartbeat. We surface it in fw_state.dongle so the
                    # UI's update flow can show "currently running v15,
                    # uploading v16" before the operator clicks flash.
                    if 'fw' in msg_obj:
                        try:
                            self.parent.dongle_fw_version = int(msg_obj['fw'])
                        except (TypeError, ValueError):
                            pass
                    # Board type / version of the dongle itself (os4_dongle
                    # v31+, omni v35+). Picks os4_dongle vs byh_omni for
                    # USB flashing. A heartbeat without `bt` is from
                    # firmware that predates it: default to 0 (dedicated)
                    # but remember it was inferred so the UI can warn --
                    # a pre-v35 omni dongle also omits it.
                    try:
                        self.parent.dongle_board_type = int(msg_obj['bt']) if 'bt' in msg_obj else 0
                    except (TypeError, ValueError):
                        self.parent.dongle_board_type = 0
                    self.parent.dongle_board_type_reported = 'bt' in msg_obj
                    if 'bv' in msg_obj:
                        try:
                            self.parent.dongle_board_version = int(msg_obj['bv'])
                        except (TypeError, ValueError):
                            pass
                    # Capture the active RF channel from each status frame.
                    # The dongle started reporting `ch` in FW v6; older
                    # firmware just won't include the key (None on parent).
                    if 'ch' in msg_obj:
                        self.parent.current_rf_channel = int(msg_obj['ch'])
                    # Pipe the dongle's command-queue saturation through to
                    # the UI status bar. `q` is current depth, `qmax` was
                    # added in dongle FW v8 (older firmware just won't
                    # include the key, so we fall back to the prior value
                    # rather than clobbering with None).
                    if 'q' in msg_obj:
                        try:
                            self.parent.dongle_cmd_queue_depth = int(msg_obj['q'])
                        except (TypeError, ValueError):
                            pass
                    if 'qmax' in msg_obj:
                        try:
                            self.parent.dongle_cmd_queue_capacity = int(msg_obj['qmax'])
                        except (TypeError, ValueError):
                            pass
                    # FW v9+: the dongle echoes its post-clamp clock-sync
                    # interval. Surface it so the UI can confirm the
                    # actually-applied value (e.g. flag clamped settings
                    # back to the operator).
                    if 'csim' in msg_obj:
                        try:
                            self.parent.dongle_clock_sync_interval_ms = int(msg_obj['csim'])
                        except (TypeError, ValueError):
                            pass
                    # Capability bits (bit 0: `#<seq>` command acks). A
                    # tick without `caps` is from firmware that predates them.
                    window = self._window()
                    if window is not None:
                        window.note_caps(msg_obj.get('caps', 0))
                    try:
                        self.parent.dongle_caps = int(msg_obj.get('caps', 0) or 0)
                    except (TypeError, ValueError):
                        self.parent.dongle_caps = 0
                    # Receivers the dongle has put in poll backoff because
                    # they stopped answering (dongle FW with poll backoff).
                    if 'off' in msg_obj:
                        try:
                            self.parent.dongle_backed_off_receivers = int(msg_obj['off'])
                        except (TypeError, ValueError):
                            pass
                    self.process_status_msg(msg_obj)
                    # Per-second status carries a lot of state -- mark
                    # the daemon dirty so the WS server gets the new
                    # snapshot ASAP rather than at the next 100ms switch
                    # poll.
                    self.parent.mark_state_dirty()
                elif(msg_type == 'rxupd'):
                    self.process_rxupd_msg(msg_obj)
                    self.parent.mark_state_dirty()
                elif(msg_type == 'rxcfg'):
                    # FW v16+ receiver-config response. Lands every time
                    # the dongle finishes a CONFIG_QUERY round (operator-
                    # initiated rxcfg command, or auto-query on initial
                    # connect / post-prune re-discovery). Persists to DB
                    # AND updates the in-memory snapshot for the UI.
                    self.process_rxcfg_msg(msg_obj)
                    self.parent.mark_state_dirty()
                elif(msg_type == 'scan_result'):
                    self._handle_scan_result(msg_obj)
                elif(msg_type == 'ota'):
                    # Per-chunk ack/nack and lifecycle events from the
                    # dongle's flash mode. The driver thread is parked
                    # on these for synchronization; mark_state_dirty so
                    # the UI's progress bar advances in real time.
                    try:
                        self.ota_driver.feed_event(msg_obj)
                    except Exception as e:
                        print(f"OTA: feed_event failed: {e}")
                    if msg_obj.get('phase') not in ('ack', 'nack'):
                        self.parent.mark_state_dirty()
            except json.JSONDecodeError as e:
                print("Bad JSON status")

        return True

    def receiver_is_connected(self, receiver_id):
        rcv = self.receivers.get(receiver_id, None)
        if(rcv):
            status = rcv.get('status', None)
            if(status):
                if(status.get('lmt',0)):
                    if(int(time.time()*1000) - status['lmt'] < LATENCY_TO_CONSIDER_ONLINE_MS):
                        return True

        return False

    def fire_item(self, item):
        print(f"Issuing fire command for {item['id']} at {item['startTime']} with async_fire:{item['async_fire']}")
        if(item['async_fire']):
            print("Ignoring async fire item. It'll take care of it.")
        else:
            msg = BSCFireTranslator.translate_zone_target_to_tx_pkg(item['zone'], item['target'])
            # NB: no trailing " x" — the dongle's isValidMessage requires the
            # arg to be exactly ">>BITS:REPS<<"; a trailing token makes it end
            # with "<< x" and the dongle silently rejects it (replies "CV 433").
            # Must match the manual-fire path (handle_manual_fire) exactly.
            self.parent.send_serial_command(f"433fire {msg}")

    def handle_manual_fire(self, zone, target, kind=None):
        # Bilusocn manual fire is a direct broadcast: there is no DB
        # receiver row to resolve, since 433MHz zones now live on shows
        # and the manual-fire screen is gated to "no show loaded". The
        # host sends `kind="bilusocn"` to opt into the resolver bypass;
        # we just translate (zone, target) into a TX packet and ship it.
        if kind == "bilusocn":
            try:
                msg = BSCFireTranslator.translate_zone_target_to_tx_pkg(zone, target)
            except (TypeError, ValueError):
                msg = None
            if msg:
                print(f"Manual Bilusocn fire {zone}:{target}")
                self.parent.send_serial_command(f"433fire {msg}")
                return True
            self.parent.write_error(
                f"Manual Bilusocn fire failed: could not translate zone:{zone} target:{target} "
                "into a TX packet (zone must be numeric and within range)."
            )
            return False

        dev_id = self.resolve_zone_target_to_device_id(zone, target)
        if(dev_id):
            print(f"Firing {zone}:{target} on {dev_id}")
            if(self.receivers[dev_id]['type'] == "BILUSOCN_433_TX_ONLY"):
                print("Firing instant 433")
                msg = BSCFireTranslator.translate_zone_target_to_tx_pkg(zone, target)
                if(msg):
                    self.parent.send_serial_command(f"433fire {msg}")
                else:
                    self.parent.write_error("Can not manually fire Bilusocn as the zone/target couldnt be parsed... did you put a letter in a zone?")
            else:
                if(self.receiver_is_connected(dev_id)):
                    self.parent.send_serial_command(f"fire {dev_id} {target - 1}")
                else:
                    self.parent.write_error("Manual fire failed as device is not connected")
                    return False
        else:
            return False

    def resolve_zone_target_to_device_id(self, zone, target):
        rtn_device_id = None
        for device_id, device in self.receivers.items():
            cues = device.get("cues", {})
            if zone in cues and target in cues[zone]:
                if(not rtn_device_id):
                    rtn_device_id = device_id  # or return device_id, device if you need the key too
                else:
                    print("Multiple devices have this zone/target!!! You cant do that.")
                    rtn_device_id = None
        return rtn_device_id

    def resolve_fire_target_to_entry(self, fire_target):
        dev_id = self.resolve_zone_target_to_device_id(fire_target['zone'], fire_target['target'])
        if(not dev_id):
            self.errors.append(f"Load: Could not resolve cue {fire_target['zone']}:{fire_target['target']} to any device.")
        else:
            fire_target['type'] = self.receivers[dev_id]['type']
            fire_target['device_id'] = dev_id
            fire_target['async_fire'] = not fire_target['type'] == "BILUSOCN_433_TX_ONLY"
            if( fire_target['async_fire'] and not self.receiver_is_connected(dev_id)):
                self.errors.append(f"Load: Resolved cue {fire_target['zone']}:{fire_target['target']} to {dev_id}, but its not connected.")
            else:
                return fire_target
        
        return None

    # Max cues per packed SHOW_LOADN frame (must match SHOW_LOADN_MAX_CUES on
    # the dongle/receiver firmware). 6 cues fills the 32-byte nRF24 payload.
    SHOW_LOADN_MAX_CUES = 6

    def send_load_segment_to_dev(self, dev_id, st1, target1, st2, target2):
        """Legacy 2-cue showload helper.

        Kept for any callers still using the old API; new code should call
        send_load_chunk_to_dev() with up to SHOW_LOADN_MAX_CUES cues.
        """
        print(f"Loading segment to {dev_id}: {st1}, {target1}, {st2}, {target2}")
        cmd = f"showload {dev_id} {int(st1)} {int(target1)} {int(st2)} {int(target2)} 2"
        self.parent.send_serial_command(cmd)

    def send_load_chunk_to_dev(self, dev_id, cues, repeat=2):
        """Send up to SHOW_LOADN_MAX_CUES cues in a single RF frame.

        cues is a list of (time_ms, position_zero_indexed) tuples.
        """
        if not cues:
            return
        cues = cues[: self.SHOW_LOADN_MAX_CUES]
        # Wire format: showloadn IDENT COUNT t1 p1 t2 p2 ... [REPEAT]
        parts = ["showloadn", dev_id, str(len(cues))]
        for t, p in cues:
            parts.append(str(int(t)))
            parts.append(str(int(p)))
        parts.append(str(int(repeat)))
        cmd = " ".join(parts)
        self.parent.send_serial_command(cmd)

    def _dedupe_fire_targets(self, device_id, fire_targets):
        """Collapse cues that share a (device, target) position to a single
        entry (earliest start time wins) and surface a warning listing the
        dropped duplicates. See H4: duplicate positions would otherwise
        inflate expectedItemsCt past the receiver's single targetLoaded
        slot and stall the load forever."""
        seen = {}
        dropped = []
        for item in fire_targets:
            tgt = item.get("target")
            existing = seen.get(tgt)
            if existing is None:
                seen[tgt] = item
                continue
            # Keep whichever fires earliest; drop the other.
            if item.get("startTime", 0) < existing.get("startTime", 0):
                dropped.append(existing)
                seen[tgt] = item
            else:
                dropped.append(item)
        if dropped:
            desc = ", ".join(
                f"pos {d.get('target')}@{d.get('startTime')}s" for d in dropped
            )
            self.parent.write_error(
                f"Load: {device_id} has duplicate cue positions; kept earliest, "
                f"dropped {len(dropped)} duplicate(s): {desc}"
            )
        # Deterministic packing order by start time.
        return sorted(seen.values(), key=lambda it: it.get("startTime", 0))

    def _load_commands_for(self, ident, fire_targets, show_id, send_startload):
        """(startload line or None, [showloadn lines]) for one receiver."""
        # De-dupe (device, target) pairs before counting: the receiver
        # has exactly one targetLoaded slot per position, but
        # expectedItemsCt counts every cue. Two cues mapped to the same
        # position would make recheckLoadComplete never reach
        # expectedTargets, so the host retries the load forever (H4).
        fire_targets = self._dedupe_fire_targets(ident, fire_targets)
        startload = f"startload {ident} {len(fire_targets)} {show_id}" if send_startload else None
        chunks = []
        # Pack cues SHOW_LOADN_MAX_CUES at a time into single RF frames.
        for i in range(0, len(fire_targets), self.SHOW_LOADN_MAX_CUES):
            chunk = fire_targets[i:i + self.SHOW_LOADN_MAX_CUES]
            # (time_ms, zero_indexed_pos). Clamp a t=0 cue to 1ms: the
            # receiver's loadOneCue ignores time==0, so the cue would never
            # set targetLoaded and the load would never complete (H4).
            packed = [(max(1, round(item["startTime"] * 1000)), item["target"] - 1) for item in chunk]
            parts = ["showloadn", ident, str(len(packed))]
            for t, p in packed:
                parts += [str(int(t)), str(int(p))]
            parts.append("2")
            chunks.append(" ".join(parts))
        return startload, chunks

    def load_async_fire_targets(self, async_fire_targets, showId, setLoadTargets=True, skip_startload=False):
        if(setLoadTargets):
            self.async_load_targets = async_fire_targets
        if not skip_startload:
            # A stop_all() repeat pass from just before this load would make
            # the dongle scrub the queued load frames for those receivers.
            self.cancel_pending_stop_repeats()

        self.status = START_SEQUENCE_STEPS.LOADING
        abort = self._load_abort
        now = time.monotonic()

        plan = []   # (ident, startload or None, [chunks])
        for ident, fire_targets in async_fire_targets.items():
            # On a re-send, skip START_LOAD when the receiver already has
            # this show id: it would reset the cues it already holds.
            send_startload = not skip_startload
            if skip_startload:
                receiver_status = self.receivers.get(ident, {}).get('status') or {}
                send_startload = receiver_status.get('showId') != showId
            startload, chunks = self._load_commands_for(ident, fire_targets, showId, send_startload)
            plan.append((ident, startload, chunks))
            st = self._load_state.setdefault(ident, {"last_send": now, "attempts": 0})
            st["last_send"] = now
            st["attempts"] += 1

        if not self._acks_enabled():
            # Dongle without command acks: the original fixed pacing. The
            # 50ms after START_LOAD gives the dongle time to dispatch it.
            for ident, startload, chunks in plan:
                if abort.is_set():
                    return
                if startload:
                    self.parent.send_serial_command(startload)
                    time.sleep(0.05)
                for line in chunks:
                    if abort.is_set():
                        return
                    self.parent.send_serial_command(line)
                    time.sleep(0.03)
            return

        # Windowed: everything goes out back to back, up to 16 in flight.
        # The dongle queue is FIFO, so each receiver's START_LOAD still
        # reaches it before that receiver's cues.
        cmds = []
        for _ident, startload, chunks in plan:
            if startload:
                cmds.append(startload)
            cmds.extend(chunks)
        failures = self._send_batch(cmds, retry=0, abort_event=abort)
        if not failures or abort.is_set():
            return
        # Retry once. A receiver whose START_LOAD failed gets its whole load
        # again (re-sending START_LOAD alone would wipe cues it received);
        # otherwise only the failed frames are re-sent.
        failed_cmds = {cmd for cmd, _res in failures}
        retry_cmds = []
        for _ident, startload, chunks in plan:
            if startload and startload in failed_cmds:
                retry_cmds.append(startload)
                retry_cmds.extend(chunks)
            else:
                retry_cmds.extend(c for c in chunks if c in failed_cmds)
        failures = self._send_batch(retry_cmds, retry=0, abort_event=abort)
        if failures:
            # The supervisor re-sends on its timer and fails the load if a
            # receiver never completes; just log what the dongle reported.
            print(f"Load: frames not delivered: {self._describe_failures(failures)}")

    #Figure out which ones we need to preload (native) and which we fire via. daemon (433 Bilusocn).. or if we have zones+targets that we cant fire. Annotates firing array.
    def load_targets_to_devices(self, firing_array, showId):
        final_fire_array = []
        errors = []

        async_device_load_dict = {}

        for target in firing_array:
            fire_entry = self.resolve_fire_target_to_entry(target)
            #Returns error as string if fucked up
            if(fire_entry):
                if(fire_entry["async_fire"]):
                    if(not (fire_entry['device_id'] in async_device_load_dict)):
                        async_device_load_dict[fire_entry['device_id']] = [fire_entry]
                    else:
                        async_device_load_dict[fire_entry['device_id']].append(fire_entry)

                final_fire_array.append(fire_entry)
            else:
                self.errors.append("Load: Could not resolve fire target to a valid entry")

        if(len(self.errors) == 0 and async_device_load_dict):
            self.load_async_fire_targets(async_device_load_dict, showId)
            print("Waiting")

        self.firing_array = final_fire_array
        return True

    def load_show(self, firing_array, show_id, show_receivers=None):
        """Load a parsed firing array.

        `show_receivers` is the per-show receiver list as parsed JSON
        (the list-of-dicts shape from the Show table's `show_receivers`
        column). When the show owns Bilusocn 433MHz zones (entries with
        `kind == 'bilusocn'`), we synthesize ephemeral receiver rows for
        each zone before resolving fire targets so the existing
        zone/target -> device_id resolver finds them. The rows are
        cleared on unload_show. None / empty list is the no-op path
        for shows that only use native receivers (i.e. everything that
        was authorable before the rework).
        """
        # A previous load's supervisor (if any) ends; this load gets a
        # fresh abort event shared by the send loop and its supervisor.
        self._load_abort.set()
        self._load_abort = threading.Event()
        self._load_state = {}
        self.show_id=show_id
        self.errors = []
        if(len(firing_array) == 0):
            self.parent.write_error("Loaded a show with an empty firing array? No")
            return False
        self._materialize_show_bilusocn_receivers(show_receivers)
        self.load_start_ts = time.time()
        self.load_targets_to_devices(firing_array, show_id)

        if(self.errors):
            print("There were errors..")
            self.show_loaded = False
            return False

        print(f"Loaded firing array for Show {show_id}")
        if self.parent.debug_mode:
            print(self.firing_array)

        if self._load_abort.is_set():
            # Aborted by the operator while the cues were being sent.
            return False
        if(self.async_load_targets):
            self.load_waiting = True
            self._start_load_supervisor()
            # Status may already have reported everything loaded while the
            # cues were still going out.
            self.updateRelevantStates()
            print("Waiting for receivers to report loaded.")
            return False
        else:
            self.status = START_SEQUENCE_STEPS.LOADED
            return True

    def _teardown_async_load(self, send_reset=True):
        """Drop the in-flight async-load bookkeeping.

        Shared by the timeout path and the operator-initiated abort. When
        `send_reset` is set we first tell the receivers that were mid-load
        to `reset` so they discard the partially-loaded program instead of
        sitting on a stale half-show. We reassign async_load_targets to a
        fresh dict (rather than mutating in place) so a concurrent reader
        can't trip over a dict-changed-size error.
        """
        self._load_abort.set()   # stops the send loop and the supervisor
        targets = self.async_load_targets
        self.load_waiting = False
        self.load_start_ts = 0
        self.async_retry_ct = 0
        self.async_load_targets = {}
        self._load_state = {}
        self.show_loaded = False
        if send_reset and targets:
            self.send_to_active_nodes("reset", " 0", rcv_dict_override=targets, wait=False)

    def abort_show_load(self):
        """Operator-requested cancel of an in-progress show load.

        Valid whenever we're still sending cues (status LOADING) or waiting
        on async receivers to confirm loadComplete. Resets the partially
        loaded receivers, drops the wait, and parks the handler in ABORTED
        so the UI falls back to a clean "Load show" state. Returns
        (ok, message) mirroring abort_ota_flash / abort_dongle_flash.
        """
        if not (self.load_waiting or self.status == START_SEQUENCE_STEPS.LOADING):
            return False, "no show load in progress"
        incomplete = list(self.async_load_targets.keys())
        with self._load_lock:
            self._teardown_async_load(send_reset=True)
            self.status = START_SEQUENCE_STEPS.ABORTED
        self.parent.write_error(
            f"Show load cancelled by operator. Receivers reset: {incomplete}"
        )
        return True, "show load aborted"

    def request_load_abort(self):
        """Thread-safe signal used by the daemon's fast command lane: stops
        the cue-send loop between sends without waiting for it."""
        self._load_abort.set()

    def _nrf_receiver_idents(self, preferred=None):
        """Every nRF24 receiver ident (not 433MHz TX-only rows), with the
        idents in `preferred` first. No connectivity filter: a receiver that
        has gone quiet keeps running its loaded program through a dropout,
        so it is exactly the one that most needs a stop."""
        order = []
        seen = set()
        receivers = dict(self.receivers)
        for ident in list(preferred or ()):
            rcv = receivers.get(ident)
            if rcv is None or rcv.get('type') == 'BILUSOCN_433_TX_ONLY':
                continue
            if ident not in seen:
                order.append(ident)
                seen.add(ident)
        for ident, rcv in receivers.items():
            if ident in seen or rcv.get('type') == 'BILUSOCN_433_TX_ONLY':
                continue
            if rcv.get('__ephemeral'):
                continue
            order.append(ident)
            seen.add(ident)
        return order

    def _send_stop_pass(self, idents):
        # Priority, and never waits: delivery is confirmed by the repeat
        # passes and the playing flags, not by blocking the caller.
        self._send_batch([f"stop {ident} 0 5" for ident in idents], priority=True,
                         legacy_spacing_s=STOP_SEND_SPACING_S, retry=0, wait=False)

    def cancel_pending_stop_repeats(self):
        """Invalidate any in-flight stop_all() repeat thread. Called when a
        new load or show start begins so a late repeat pass can't knock a
        freshly armed receiver back out."""
        self._stop_generation += 1

    def stop_all(self, reason="stop"):
        """Send STOP to every nRF receiver, now and again shortly after.

        Independent of the show thread: works when run_show() has already
        returned or died, and does not filter on connectivity. The first
        pass is sent on the caller's thread (stop is safety-critical, so the
        caller pays ~5ms per receiver); repeat passes run in the background
        and the call returns straight after the first pass."""
        self._last_stop_all_mono = time.monotonic()
        self._stop_generation += 1
        gen = self._stop_generation
        idents = self._nrf_receiver_idents(self.async_load_targets)
        if not idents:
            return
        print(f"stop_all ({reason}): {len(idents)} receiver(s)")
        # One broadcast reaches every receiver within a few ms (T27, opt-in);
        # the unicast passes below still go to each receiver.
        self._broadcast(BCAST_STOP)
        self._send_stop_pass(idents)
        threading.Thread(
            target=self._stop_repeat_worker,
            args=(idents, gen, reason),
            name="stop-repeat",
            daemon=True,
        ).start()

    def _broadcast_enabled(self):
        """Broadcast control (T27) is opt-in: the dongle must support it and
        the protocol config must set `use_broadcast_control` (it depends on
        every nRF24 module in the fleet honouring no-ACK frames, which needs
        a bench test first)."""
        caps = int(getattr(self.parent, 'dongle_caps', 0) or 0)
        return bool(caps & DONGLE_CAP_BCAST) and bool(self.config.get('use_broadcast_control', False))

    def _broadcast(self, op, show_id=0, at_ms=0):
        """Send one broadcast control command ahead of the unicast fan-out.
        Additive: the unicast commands still follow, so a receiver that
        missed the broadcast is covered either way. Returns True if sent."""
        if not self._broadcast_enabled():
            return False
        self._send_batch([f"bcast {int(op)} {int(show_id or 0)} {int(at_ms or 0)}"],
                         priority=True, legacy_spacing_s=0, retry=0, wait=False)
        return True

    def _receiver_playing(self, ident):
        """True / False from the receiver's reported play state, or None
        when it doesn't report one (older firmware)."""
        status = self.receivers.get(ident, {}).get('status') or {}
        if 'playing' not in status:
            return None
        return bool(status.get('playing'))

    def _stop_repeat_worker(self, idents, gen, reason):
        t0 = time.monotonic()
        for offset in STOP_REPEAT_OFFSETS_S:
            delay = (t0 + offset) - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            if gen != self._stop_generation:
                return
            # Repeat only where the stop isn't confirmed: receivers still
            # reporting playing, plus every receiver that can't report.
            targets = [i for i in idents if self._receiver_playing(i) is not False]
            if not targets:
                break
            try:
                self._send_stop_pass(targets)
            except Exception as e:
                print(f"stop_all repeat ({reason}) failed: {e}")
                return
        delay = (t0 + STOP_CONFIRM_TIMEOUT_S) - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        if gen != self._stop_generation:
            return
        still_playing = [i for i in idents if self._receiver_playing(i)]
        if still_playing:
            self.parent.write_error(
                f"Stop not confirmed: still reporting playing "
                f"{STOP_CONFIRM_TIMEOUT_S:.0f}s after stop: {', '.join(still_playing)}"
            )

    def _stop_from_show_thread(self, reason):
        """run_show()'s own stop path. Skipped when stop_all() already ran
        for this stop (the operator path calls it directly); still needed
        when the stop event was set by something that does not send, such as
        a protocol-handler swap."""
        if time.monotonic() - self._last_stop_all_mono < STOP_DEDUPE_WINDOW_S:
            return
        self.stop_all(reason)

    def send_to_active_nodes(self, cmdpre, cmdpost="", repeat=1, rcv_dict_override=None,
                             require_connected=True, wait=True):
        """Send `cmdpre IDENT cmdpost repeat` to receivers.

        `rcv_dict_override` (when not None) limits the fan-out to those
        idents; an empty dict sends nothing. `require_connected=False` also
        targets receivers the host has not heard from recently. stop and
        pause go out as priority commands. Returns [(cmd, result)] for
        commands the dongle reported as not delivered (after one retry);
        always [] on a dongle without command acks.
        """
        receiver_dict = list(self.receivers.items())
        if rcv_dict_override is not None:
            receiver_dict = list(rcv_dict_override.items())

        cmds = []
        for rcv, _statusdata in receiver_dict:
            if self.receivers.get(rcv, {}).get('type') == 'BILUSOCN_433_TX_ONLY':
                continue
            if (not require_connected) or self.receiver_is_connected(rcv):
                cmds.append(f"{cmdpre} {rcv}{cmdpost} {repeat}")
            else:
                print(f"Not sending to {rcv} as not connected.")
        if not cmds:
            return []
        if self.parent.debug_mode:
            print(f"Sending {len(cmds)}x {cmdpre} (repeat={repeat})")
        failures = self._send_batch(cmds, priority=cmdpre in ("stop", "pause"),
                                    wait=wait)
        if failures:
            print(f"{cmdpre}: not delivered to {self._describe_failures(failures)}")
        return failures

    def unload_show(self):
        self.time_cursor=-1
        self.firing_array = []
        self.errors = []
        self.async_load_targets = {}
        self.show_id=0
        self.load_waiting = False
        self.show_loaded = False

        self.send_to_active_nodes("reset", " 0")
        # Drop any ephemeral Bilusocn rows the previously-loaded show
        # had us synthesize. They're recreated from the new show's
        # show_receivers on the next load_show; leaving stale entries
        # would just confuse the next zone/target resolver pass.
        self._clear_ephemeral_receivers()

    # -----------------------------------------------------------------
    # Ephemeral Bilusocn receivers
    #
    # When a show owns a Bilusocn 433MHz zone (showReceivers entry with
    # `kind == 'bilusocn'`), there is no DB receiver row backing it --
    # the show owns the zone outright. To keep resolve_zone_target_to_
    # device_id working unchanged, we synthesize three 4-cue rows per
    # zone (dipswitch ranges 1-4, 5-8, 9-12) into self.receivers at
    # load_show time and drop them on unload_show.
    #
    # These rows are flagged with `__ephemeral=True` so any code that
    # accidentally tries to persist them can bail; the daemon currently
    # never writes self.receivers back to disk so this is belt-and-
    # suspenders. Idents start with double underscore to make them
    # easy to spot in logs and to keep them well clear of the dongle's
    # `RX<digits>` namespace.
    # -----------------------------------------------------------------

    BILUSOCN_RANGE_LEN = 4
    BILUSOCN_RANGE_STARTS = (1, 5, 9)

    def _materialize_show_bilusocn_receivers(self, show_receivers):
        # Always start from a clean slate; the previous load may have
        # left rows for a different show / different zones. unload_show
        # also clears, but loads can chain (re-load with same id) so
        # we don't rely on the unload pass.
        self._clear_ephemeral_receivers()
        if not show_receivers:
            return
        if not isinstance(show_receivers, list):
            return
        for entry in show_receivers:
            if not isinstance(entry, dict):
                continue
            if entry.get("kind") != "bilusocn":
                continue
            zone_raw = entry.get("id")
            if zone_raw is None:
                continue
            try:
                zone = int(zone_raw)
            except (TypeError, ValueError):
                print(f"Skipping malformed Bilusocn show entry: {entry!r}")
                continue
            zone_str = str(zone)
            label = entry.get("label") or f"Bilusocn zone {zone_str}"
            for start in self.BILUSOCN_RANGE_STARTS:
                ident = f"__bilusocn_z{zone_str}_{start}"
                # Last-write-wins if the operator double-added a zone
                # somehow; the React side enforces zone uniqueness on
                # save so this is defensive.
                self.receivers[ident] = {
                    "type": "BILUSOCN_433_TX_ONLY",
                    "label": label,
                    "enabled": True,
                    "cues": {
                        zone_str: [
                            start + i for i in range(self.BILUSOCN_RANGE_LEN)
                        ],
                    },
                    "__ephemeral": True,
                }
                self.ephemeral_receiver_idents.add(ident)

    def _clear_ephemeral_receivers(self):
        if not self.ephemeral_receiver_idents:
            return
        for ident in list(self.ephemeral_receiver_idents):
            self.receivers.pop(ident, None)
        self.ephemeral_receiver_idents.clear()

    def get_fc_failures(self):
        self.errors = []
        if(len(self.firing_array) == 0):
            self.errors = ["System error - No firing strategy loaded in. Check other errors."]
        return self.errors

    def run_precheck(self):
        """
        Verify for the current firing_array that:
         - Every receiver's battery >= min_battery_to_fire_pct
         - For async_fire entries, the continuity bit for that cue is present
        Returns a list of error messages (empty list means precheck passed).
        """
        errors = []

        # Reload config to get latest settings (in case UI updated them).
        # Reads the merged base + systemcfg.user.json overrides.
        try:
            data = load_system_config()
            self.config = data.get('protocols', {}).get(self.protocol).get('config', {})
        except Exception as e:
            print(f"Warning: Could not reload config in run_precheck: {e}")
            # Continue with existing self.config if reload fails

        # 1) Load thresholds
        min_batt_pct = self.config.get('min_battery_to_fire_pct', 0)
        require_cont = self.config.get('require_continuity', False)

        # 2) Walk every scheduled cue
        for entry in self.firing_array:
            dev_id = entry['device_id']
            status = self.receivers.get(dev_id, {}).get('status', {})

            # --- Battery check ---
            batt = status.get('battery')
            if batt is None:
                errors.append(f"Precheck: No battery info for receiver '{dev_id}'.")
            elif batt < min_batt_pct:
                errors.append(
                    f"Precheck: Receiver '{dev_id}' battery at {batt}% "
                    f"(below minimum {min_batt_pct}%)."
                )

            # --- Continuity check (only if async and required) ---
            if require_cont and entry.get('async_fire'):
                cont_arr = status.get('continuity', [])
                print(cont_arr)
                # continuity is a 4-item array of 64-bit bitmasks
                if not isinstance(cont_arr, (list, tuple)) or len(cont_arr) != 2:
                    errors.append(
                        f"Precheck: Invalid continuity data for receiver '{dev_id}'."
                    )
                    continue

                # Convert to 0-based bit index
                bit_index = entry['target'] - 1
                mask_idx  = bit_index // 64
                bit_pos   = bit_index % 64

                if mask_idx < 0 or mask_idx >= len(cont_arr):
                    # Out-of-range cue index (e.g. a corrupt/imported show
                    # with a position >= 128) must be a visible warning, not
                    # an IndexError that kills the show-start thread (H5).
                    errors.append(
                        f"Precheck: Cue {entry['zone']}:{entry['target']} "
                        f"out of continuity range for '{dev_id}' (treating as no continuity)."
                    )
                else:
                    mask = cont_arr[mask_idx]
                    # make sure mask is int
                    try:
                        mask = int(mask)
                    except (TypeError, ValueError):
                        mask = 0
                    if ((mask >> bit_pos) & 1) == 0:
                        errors.append(
                            f"Precheck: Receiver '{dev_id}' continuity bit missing "
                            f"for cue {entry['zone']}:{entry['target']}."
                        )
        self.errors = errors
        return errors


    def _abort_show(self, reason, send_stop=True):
        """Common exit for every stop / abort branch of run_show()."""
        print(reason)
        self.running_show = False
        self.status = START_SEQUENCE_STEPS.ABORTED
        self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
        if send_stop:
            self._stop_from_show_thread(reason)

    def _timed_pause_supported(self):
        """(dongle forwards timestamps, every show receiver honours them)."""
        dongle = bool(int(getattr(self.parent, 'dongle_caps', 0) or 0) & DONGLE_CAP_TIMED_PAUSE)
        receivers = all(
            int((self.receivers.get(ident, {}).get('status') or {}).get('rxCaps', 0) or 0)
            & RX_CAP_TIMED_PAUSE
            for ident in self.async_load_targets
        )
        return dongle, dongle and receivers

    def _wait_while_paused(self):
        """Block while the show is paused. Sends PAUSE to the show's
        receivers on entry and PLAY on resume. Returns the seconds spent
        paused, or None when the show was stopped while paused.

        T25: PAUSE and PLAY carry the synchronized time they take effect at,
        so a receiver's delivery delay no longer becomes a permanent offset.
        When every show receiver supports it, the resume is scheduled
        RESUME_LEAD_S ahead and the host waits for that instant too, so 433
        cues and the audio cursor stay aligned with the receivers. Without
        full support the lead is 0 (legacy receivers resume on arrival)."""
        print("Schedule paused.")
        pause_mono = time.monotonic()
        pause_at_ms = int(time.time() * 1000)
        dongle_timed, all_timed = self._timed_pause_supported()
        stamp = pause_at_ms if dongle_timed else 0
        self._broadcast(BCAST_PAUSE, self.show_id, stamp)
        self.send_to_active_nodes("pause", f" {stamp}", 5, self.async_load_targets,
                                  require_connected=False)
        while self.schedule_pause_event.is_set():
            if self.schedule_stop_event.wait(0.1):
                # M4: ABORTED so the UI doesn't show a stale step after a
                # stop-during-pause.
                self._abort_show("Schedule stopped while paused.")
                return None
        dongle_timed, all_timed = self._timed_pause_supported()
        lead = 0.0
        if all_timed:
            lead = RESUME_LEAD_S + RESUME_LEAD_PER_RECEIVER_S * len(self.async_load_targets)
        # Express the resume instant in both clock domains from the same
        # monotonic reading: paused_for is then exact on both sides.
        paused_for = (time.monotonic() - pause_mono) + lead
        resume_at_ms = pause_at_ms + int(round(paused_for * 1000))
        paused_for = (resume_at_ms - pause_at_ms) / 1000.0
        print(f"Schedule resuming (lead {lead:.2f}s).")
        self._broadcast(BCAST_PLAY, self.show_id, resume_at_ms if dongle_timed else 0)
        self.send_to_active_nodes("play", f" {resume_at_ms if dongle_timed else 0}", 5,
                                  self.async_load_targets, require_connected=False)
        # Hold the host timeline until the receivers resume.
        while time.monotonic() < pause_mono + paused_for:
            if self.schedule_stop_event.wait(min(0.05, max(0.0, pause_mono + paused_for - time.monotonic()))):
                self._abort_show("Schedule stopped while resuming.")
                return None
        print("Schedule resumed.")
        self.parent.led_handler.update("show_run_state", RUN_STATE.RUNNING.value)
        return paused_for

    def run_show(self):
        self.schedule_stop_event.clear()  # Reset the stop event
        self.schedule_pause_event.clear()  # Reset the stop event
        # A stop_all() repeat pass still in flight from an earlier stop must
        # not land after this start's SHOW_START.
        self.cancel_pending_stop_repeats()
        self.parent.led_handler.update("show_run_state", RUN_STATE.RUNNING.value)
        self.status = START_SEQUENCE_STEPS.START_PENDING
        self.parent.led_handler.update("show_run_state", RUN_STATE.PRECHECK.value)
        print("Checking battery and continuity states")
        # run_precheck must never raise out of here unhandled — that would
        # leave the start thread dead with the UI hung in "starting" (H5).
        # Any unexpected exception fails the start visibly.
        try:
            precheck_errors = self.run_precheck()
        except Exception as e:
            import traceback
            traceback.print_exc()
            precheck_errors = [f"Precheck crashed: {e}"]
            self.errors = precheck_errors
        if(precheck_errors):
            self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
            self.status = START_SEQUENCE_STEPS.ABORTED
            self.parent.write_error("Precheck failed. Aborting show.")
            return

        try:
            self._run_show_body()
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"Error in schedule: {e}")
            # The receivers keep running their loaded schedule whatever
            # happened to this thread, so stop them before reporting.
            try:
                self.stop_all("schedule error")
            except Exception as stop_err:
                print(f"stop_all after schedule error failed: {stop_err}")
            self.running_show = False
            self.status = START_SEQUENCE_STEPS.ABORTED
            self.parent.led_handler.update("error_state", ERR_STATE.DAEMON.value)
            self.parent.write_error(f"Error in schedule: {e}")
            self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
            return

    def _run_show_body(self):
        # Re-sync the host->dongle wall clock immediately before every show
        # start. This is the recovery path for the case where the dongle has
        # rebooted WITHOUT the daemon noticing -- most commonly a USB hot-replug
        # after the PC sleeps (BHWB-17 and the more-severe follow-up). On boot
        # the dongle's tsOffset resets to 0, so its clock -- and every receiver's
        # clock, which the dongle drives via CLOCK_SYNC -- is boot-relative.
        # LOADING still works because `showloadn` carries *relative* cue offsets,
        # so cue LEDs light correctly and the show reads as "loaded". But
        # `showstart` below ships an *absolute* epoch-ms start time; against a
        # boot-relative clock getSynchronizedTime() never reaches showStartTime,
        # so receivers arm but NEVER fire -- the show "runs" on the host with
        # zero cues on the field. The dongle firmware explicitly expects the
        # daemon to re-msync after a replug (os4_dongle.ino handleReboot notes),
        # but a silent bridge-only USB reopen never recreates the handler that
        # would otherwise do it. Re-msyncing here makes the fire path
        # self-healing: we re-align the dongle to epoch before computing/sending
        # show_start_time, and the SHOW_START_TIME_SECONDS countdown gives the
        # dongle's CLOCK_SYNC frames time to propagate the new offset to every
        # receiver well before T-0.
        self.sync_tx_clock()
        # Let the dongle apply tsOffset before we sample time().
        if self.schedule_stop_event.wait(0.2):
            self._abort_show("Schedule stopped before show start.")
            return

        # `show_start_time` is sent to receivers over the wire, so it
        # has to be in the wall-clock (epoch ms) domain that msync set
        # up. `show_start_monotonic` is the same instant expressed on
        # the local monotonic clock; we use IT for every local wait
        # below so a mid-show wall-clock step (NTP catches up, operator
        # `date -s`, anything) can't make the daemon fire too early /
        # too late / out of order. The two are captured side-by-side so
        # they describe the same moment regardless of subsequent clock
        # adjustments.
        self.show_start_time = round(time.time()*1000)+(SHOW_START_TIME_SECONDS*1000)
        show_start_monotonic = time.monotonic() + SHOW_START_TIME_SECONDS
        print("Signaling connected async nodes to start")
        # Drop any latched startReady from a prior start attempt so the wait
        # loop below confirms THIS showstart was actually accepted, instead of
        # trusting stale status (e.g. a showstart dropped over a flaky post-
        # replug link).
        self.invalidate_cached_start_ready()
        self._broadcast(BCAST_SHOW_START, self.show_id, self.show_start_time)
        self.send_to_active_nodes("showstart",f" {self.show_start_time} 0 {self.show_id}", 6, self.async_load_targets)

        print("Waiting on start accept")
        not_ready_nodes = self.get_async_load_targets_not_with_status('startReady', True)
        nrnct=0
        while(not_ready_nodes):
            # Abort window is expressed on the monotonic clock so a
            # wall-clock step can't yank the abort threshold past "now"
            # and trigger a spurious abort.
            if(time.monotonic() > show_start_monotonic - ABORT_PRE_START_SECONDS):
                print("Abort time reached and nodes still not ready. Aborting")
                self.parent.led_handler.update("error_state", ERR_STATE.DAEMON.value)
                self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
                self.status = START_SEQUENCE_STEPS.ABORTED
                for shitty_node in not_ready_nodes:
                    self.errors.append(f"Start: {shitty_node} did not signal start ready by {ABORT_PRE_START_SECONDS} before start. Aborting show.")
                # Receivers that did accept SHOW_START are armed; disarm them.
                self.stop_all("start not confirmed")
                return
            print("Async nodes have not reported back. Still Waiting on: ")
            print(not_ready_nodes)
            if self.schedule_stop_event.wait(1):
                self._abort_show("Schedule stopped while waiting for start accept.")
                return
            if(nrnct > 5):
                print("Nodes not ready, reissuing start command")
                nrnct = 0
                #not_ready_nodes is a list - convert to a dict
                not_ready_targets = {dev: self.async_load_targets[dev] for dev in not_ready_nodes}
                self.send_to_active_nodes("showstart",f" {self.show_start_time} 0 {self.show_id}", 5, not_ready_targets)
            not_ready_nodes = self.get_async_load_targets_not_with_status('startReady', True)
            nrnct=nrnct+1

        if self.schedule_stop_event.wait(1):
            self._abort_show("Schedule stopped before countdown.")
            return
        self.status = START_SEQUENCE_STEPS.START_CONFIRMED
        self.parent.led_handler.update("show_run_state", RUN_STATE.COUNTDOWN.value)
        print("Waiting for show start.")

        # Pre-start countdown on the monotonic clock. Receivers are
        # waiting against their msynced wall clocks (= the same
        # instant in wall-clock terms), so as long as nothing steps
        # the Pi's wall clock between msync and showstart they fire
        # together. If something DOES step the wall clock the host
        # NTP guard re-msyncs (see byh-timesync-guard.service); the
        # monotonic wait here keeps THIS process honest in the
        # meantime. The waits are capped at the remaining countdown so
        # the host's own timeline starts at T-0 rather than up to 3s
        # late, and wake immediately on a stop.
        while(time.monotonic() < show_start_monotonic):
            self.send_to_active_nodes("play", " 0", 5, self.async_load_targets)
            remaining = show_start_monotonic - time.monotonic()
            if remaining <= 0:
                break
            if self.schedule_stop_event.wait(min(3.0, remaining)):
                self._abort_show("Schedule stopped during countdown.")
                return
        self.status = START_SEQUENCE_STEPS.STARTED
        self.parent.led_handler.update("show_run_state", RUN_STATE.RUNNING.value)
        print("Started show!")
        self.running_show = True  # Set running state
        print(self.firing_array)
        pause_offset = 0
        # All in-show timing is on the monotonic clock. firing_array
        # items carry RELATIVE offsets from t=0 so the wall clock
        # never enters the calculation again until the show ends.
        # Anchored on the planned T-0 (not "now"), which is the instant
        # the receivers count from.
        start_time_monotonic = show_start_monotonic
        last_write_time = time.monotonic()  # Track last file write time

        for item in self.firing_array:
            delay = item['startTime']  # Convert to MS
            while (time.monotonic() - start_time_monotonic) < (delay + pause_offset):
                if self.schedule_stop_event.is_set():
                    self._abort_show("Schedule stopped signaling nodes.")
                    return
                if self.schedule_pause_event.is_set():
                    paused_for = self._wait_while_paused()
                    if paused_for is None:
                        return
                    pause_offset += paused_for

                time.sleep(0.01)  # Check stop event frequently
                self.time_cursor = round((time.monotonic() - start_time_monotonic - pause_offset),2)

                # Overwrite file every second
                if time.monotonic() - last_write_time >= 1:
                    self.parent.write_time_cursor(self.time_cursor)
                    last_write_time = time.monotonic()

            self.fire_item(item)
            print(f"Executing scheduled command: {item}")
        print("All commands fired.")

        # The last cue FIRING is not the end of the show. Each cue keeps
        # playing for its `duration` (a shell's rise+break, a cake's run,
        # etc.), so the real content end is the latest cue end across the
        # whole array -- not just the last-fired cue, since an earlier cue
        # with a long duration can outlast it. On top of that the operator
        # can configure a grace period so the host keeps reporting the show
        # as running for a few extra seconds (song tails, finale smoke,
        # etc.). Receivers finishing after their last cue is expected and
        # fine; this wait only governs how long the HOST considers the show
        # live so the UI (audio playback, cursor) doesn't stop early.
        content_end = max(
            (it['startTime'] + it.get('duration', 0) for it in self.firing_array),
            default=0,
        )
        grace_seconds = 0.0
        try:
            grace_seconds = max(0.0, float(self.config.get('show_end_grace_seconds', 0) or 0))
        except (TypeError, ValueError):
            grace_seconds = 0.0
        show_end = content_end + grace_seconds
        print(
            f"Last cue fired. Holding show live until content end "
            f"{content_end:.2f}s + grace {grace_seconds:.2f}s = {show_end:.2f}s"
        )

        while (time.monotonic() - start_time_monotonic) < (show_end + pause_offset):
            if self.schedule_stop_event.is_set():
                self._abort_show("Schedule stopped during post-show grace.")
                return
            if self.schedule_pause_event.is_set():
                paused_for = self._wait_while_paused()
                if paused_for is None:
                    return
                pause_offset += paused_for

            time.sleep(0.01)
            self.time_cursor = round((time.monotonic() - start_time_monotonic - pause_offset), 2)
            if time.monotonic() - last_write_time >= 1:
                self.parent.write_time_cursor(self.time_cursor)
                last_write_time = time.monotonic()

        print("Show grace period complete.")
        self.running_show = False
        self.parent.led_handler.update("show_run_state", RUN_STATE.OFF.value)
        self.status = START_SEQUENCE_STEPS.LOADED
        return
