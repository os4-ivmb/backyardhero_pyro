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

# Path for the full per-channel RF scan dump. Kept separate from
# /data/state because it's bulky (~3KB JSON for 126 channels) and
# infrequent (only updated on operator-initiated scans).
LAST_SCAN_FILE_PATH = '/data/last_scan.json'

DEBUG = False

#T- to show start when signaled to start.
SHOW_START_TIME_SECONDS = 25
#If we havent gotten start statuses from async nodes by ABORT_PRE_START_SECONDS before the start, abort.
ABORT_PRE_START_SECONDS = 10

cfg_filepath = '/config/systemcfg.json'
# The Receivers table in this DB is the source of truth for which receivers
# the dongle should know about. systemcfg.json still owns protocols / types /
# system block.
db_filepath = '/data/backyardhero.db'

LATENCY_TO_CONSIDER_ONLINE_MS = 8000
ASYNC_LOAD_TIMEOUT_MS = 5000

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
        self.async_retry_ct = 0
        self.status = START_SEQUENCE_STEPS.STANDBY
        self.config = {}

        self.firing_array = []
        self.receivers = {}
        self.types = {}
        self.async_load_targets = {}
        self.show_start_time = 0
        
        # Track latency samples for sliding average (max 20 samples per receiver).
        # deque(maxlen=20) gives us O(1) append + automatic eviction instead of
        # O(n) list.pop(0).
        self.latency_samples = {}  # Key: receiver ident, Value: deque of values

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
        traffic. Spaced lightly to avoid bursting the queue."""
        for rcv_ident, rcv_cfg in self.receivers.items():
            if self._register_receiver_with_dongle(rcv_ident, rcv_cfg):
                time.sleep(0.03)

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
            with open(cfg_filepath, 'r') as file:
                data = json.load(file)
            self.types = data.get('types', {})
            self.config = data.get('protocols', {}).get(self.protocol, {}).get('config', {}) or {}
        except FileNotFoundError:
            print(f"Error: The file '{cfg_filepath}' does not exist.")
            self.types = {}
            self.config = {}
        except json.JSONDecodeError as e:
            print(f"Error decoding JSON: {e}")
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
            self._forget_receiver_on_dongle(ident)
            forgotten.append(ident)
            time.sleep(0.03)

        # Register anyone new (or re-enabled). Always re-issuing sync for
        # already-known receivers is harmless — the dongle's TDMA poller will
        # absorb the no-op.
        registered = []
        for ident, def_ in new_map.items():
            if ident not in old_map:
                if self._register_receiver_with_dongle(ident, def_):
                    registered.append(ident)
                    time.sleep(0.03)

        # Drop dropped latency sample buffers so memory doesn't grow forever
        # across many enable/disable cycles.
        for ident in list(self.latency_samples.keys()):
            if ident not in new_map:
                self.latency_samples.pop(ident, None)

        self.receivers = new_map
        print(
            f"Reloaded receivers from DB: total={len(new_map)} "
            f"registered={registered} forgotten={forgotten}"
        )
        return {'registered': registered, 'forgotten': forgotten,
                'total': len(new_map)}

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
        try:
            self.parent.update_state_file()
        except Exception:
            pass

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
            try:
                self.parent.update_state_file()
            except Exception:
                pass
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
        if self.load_waiting and self.show_id and not self.show_loaded:
            print("Detected async load wait state. Checking statuses")
            incomplete_devices = self.get_async_load_targets_not_with_status('loadComplete', True)
            if not incomplete_devices:
                print("No more devices to wait on. calling it loaded.")
                self.show_loaded = True
                self.load_waiting = False
                self.status = START_SEQUENCE_STEPS.LOADED
                self.parent.signal_show_loaded(self.show_id)
            else:
                print("Waiting on targets to load:", incomplete_devices)
                self.async_retry_ct += 1
                if self.async_retry_ct > 10:
                    print(f"Retrying show load for incomplete devices: {incomplete_devices}")
                    # Retry only for devices that haven't completed loading
                    # Skip START_LOAD on retry to avoid resetting receivers that are already loading
                    incomplete_targets = {dev: self.async_load_targets[dev] for dev in incomplete_devices}
                    self.load_async_fire_targets(incomplete_targets, self.show_id, False, skip_startload=True)
                    self.async_retry_ct = 0

    def get_async_load_targets_not_with_status(self, key, state):
        false_device_ids = []
        for device_id, alt in self.async_load_targets.items():
            status = self.receivers[device_id]['status']
            if(status['showId'] == self.show_id):
                if(status[key]):
                    print(f"{device_id}:{key} is TRUE as '{status[key]}'")
                    pass
                else:
                    print(f"{device_id}:{key} is FALSE as '{status[key]}'")
                    false_device_ids.append(device_id)
            else:
                print(f"Show {self.show_id} not correct for {device_id}({status['showId']})")
                false_device_ids.append(device_id)
        return false_device_ids


    def process_status_msg(self, msg_obj):
        self.last_status_ts = msg_obj.get('timestamp', 0)

        # Define a mapping for abbreviated keys to full keys
        key_map = {
            'i': 'ident',
            'n': 'node',
            'b': 'battery',
            's': 'showId',
            't': 'lmt',
            'l': 'loadComplete',
            'r': 'startReady',
            'c': 'continuity',
            'x': 'lat',
            'sp': 'successPercent'
        }

        lmtoffset = int(time.time() * 1000) - msg_obj.get('timestamp', 0)

        for receiver in msg_obj.get('receivers', []):
            if receiver.get('i') in self.receivers:
                receiver_ident = receiver.get('i')
                # Create a new dictionary with full keys
                full_receiver = {}
                for abbr_key, full_key in key_map.items():
                    if abbr_key in receiver:
                        full_receiver[full_key] = receiver[abbr_key]
                        if(abbr_key == 't'):
                            full_receiver[full_key] = full_receiver[full_key] + lmtoffset
                        elif(abbr_key == 'x'):
                            # Sliding-average latency. Bounded deque drops the
                            # oldest sample automatically once we hit maxlen.
                            latency_value = receiver[abbr_key]
                            samples = self.latency_samples.get(receiver_ident)
                            if samples is None:
                                samples = deque(maxlen=20)
                                self.latency_samples[receiver_ident] = samples
                            samples.append(latency_value)

                            avg_latency = sum(samples) / len(samples)
                            full_receiver[full_key] = round(avg_latency)
                self.receivers[receiver['i']]['drift'] = lmtoffset
                self.receivers[receiver['i']]['status'] = full_receiver
            else:
                print(f"Receiver {receiver.get('i')} is not known. Ignoring.")
        
        self.updateRelevantStates()

    def process_serial_in(self, msg):
        if(self.parent.debug_mode):
            print("BYH handler got message to look at")
            print(msg)
        if(msg[0] == '{'):
            try:
                msg_obj = json.loads(msg)
                msg_type = msg_obj.get('type','status')

                if(msg_type == 'status'):
                    # Capture the active RF channel from each status frame.
                    # The dongle started reporting `ch` in FW v6; older
                    # firmware just won't include the key (None on parent).
                    if 'ch' in msg_obj:
                        self.parent.current_rf_channel = int(msg_obj['ch'])
                    self.process_status_msg(msg_obj)
                elif(msg_type == 'scan_result'):
                    self._handle_scan_result(msg_obj)
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
            self.parent.send_serial_command(f"433fire {msg} x")

    def handle_manual_fire(self, zone, target):
        dev_id = self.resolve_zone_target_to_device_id(zone, target)
        if(dev_id):
            print(f"Firing {zone}:{target} on {dev_id}")
            if(self.receivers[dev_id]['type'] == "BILUSOCN_433_TX_ONLY"):
                print("Firing instant 433")
                msg = BSCFireTranslator.translate_zone_target_to_tx_pkg(zone, target)
                if(msg):
                    self.parent.send_serial_command(f"433fire {msg} x")
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

    def load_async_fire_targets(self, async_fire_targets, showId, setLoadTargets=True, skip_startload=False):
        if(setLoadTargets):
            self.async_load_targets = async_fire_targets

        self.status = START_SEQUENCE_STEPS.LOADING

        for target_key, fire_targets in async_fire_targets.items():
            print(f"Processing {target_key}:")
            
            # Only send START_LOAD if skip_startload is False (initial load) or if receiver has wrong showId
            should_send_startload = not skip_startload
            if skip_startload:
                # Check if receiver already has the correct showId - if so, skip START_LOAD to avoid resetting
                receiver_status = self.receivers.get(target_key, {}).get('status', {})
                if receiver_status.get('showId') == showId:
                    print(f"Skipping START_LOAD for {target_key} - already loading show {showId}")
                    should_send_startload = False
            
            if should_send_startload:
                expectedItemsCt = len(fire_targets)
                self.parent.send_serial_command(f"startload {target_key} {expectedItemsCt} {showId}")
                # Brief settle: dongle just needs to enqueue + dispatch one cmd
                # (~3-5ms with ACK-payload protocol). 50ms is plenty.
                time.sleep(0.05)

            # Pack cues SHOW_LOADN_MAX_CUES at a time into single RF frames.
            # With 6 cues per frame, a 30-cue receiver loads in ~5 frames
            # instead of 15 — roughly 3x fewer round-trips.
            chunk_size = self.SHOW_LOADN_MAX_CUES
            for i in range(0, len(fire_targets), chunk_size):
                chunk = fire_targets[i:i + chunk_size]
                # Convert to (time_ms, zero_indexed_pos) tuples.
                packed = [(round(item["startTime"] * 1000), item["target"] - 1) for item in chunk]
                self.send_load_chunk_to_dev(target_key, packed, repeat=2)
                # Light spacing so we don't outrun the dongle's 128-deep queue
                # when loading huge shows. Dongle dispatch is ~3-5ms/cmd, so
                # 30ms per host send leaves ~6x headroom.
                time.sleep(0.03)

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

    def load_show(self, firing_array, show_id):
        self.show_id=show_id
        self.errors = []
        if(len(firing_array) == 0):
            self.parent.write_error("Loaded a show with an empty firing array? No")
            return False
        self.load_targets_to_devices(firing_array, show_id)
        
        if(self.errors):
            print("There were errors..")
            self.show_loaded = False
            return False

        print(f"Loaded firing array for Show {show_id}")
        print( self.firing_array)

        if(self.async_load_targets):
            self.load_waiting = True
            print("Failure signaled, but implied that process is waiting for async load.")
            return False
        else:
            self.status = START_SEQUENCE_STEPS.LOADED
            return True

    def send_to_active_nodes(self, cmdpre, cmdpost="", repeat=1, rcv_dict_override=None):
        receiver_dict = self.receivers.items()
        print("STAN")
        print(rcv_dict_override)
        if(rcv_dict_override):
            receiver_dict = rcv_dict_override.items()

        for rcv, statusdata in receiver_dict:
            if self.receiver_is_connected(rcv):
                # Include repeat count in the command itself
                cmd = f"{cmdpre} {rcv}{cmdpost} {repeat}"
                print(f"Sending cmd: {cmd} (repeat={repeat})")
                self.parent.send_serial_command(cmd)
                # Dongle now dispatches each cmd in ~3-5ms (down from ~30ms).
                # 30ms host spacing keeps the dongle queue comfortably below
                # its 128-deep limit even when broadcasting to 32 receivers.
                time.sleep(0.03)
            else:
                print(f"Not sendinf to {rcv} as not connected.")
        


    def unload_show(self):
        self.time_cursor=-1
        self.firing_array = []
        self.errors = []
        self.async_load_targets = {}
        self.show_id=0
        self.load_waiting = False
        self.show_loaded = False

        self.send_to_active_nodes("reset", " 0")

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

        # Reload config to get latest settings from file (in case UI updated them)
        try:
            with open(cfg_filepath, 'r') as file:
                data = json.load(file)
            self.config = data.get('protocols',{}).get(self.protocol).get('config', {})
        except (FileNotFoundError, json.JSONDecodeError, AttributeError) as e:
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

                if mask_idx < 0 or mask_idx >= 4:
                    errors.append(
                        f"Precheck: Cue {entry['zone']}:{entry['target']} "
                        f"out of continuity range for '{dev_id}'."
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


    def run_show(self):
        self.schedule_stop_event.clear()  # Reset the stop event
        self.schedule_pause_event.clear()  # Reset the stop event
        self.parent.led_handler.update("show_run_state", RUN_STATE.RUNNING.value)
        self.status = START_SEQUENCE_STEPS.START_PENDING
        self.parent.led_handler.update("show_run_state", RUN_STATE.PRECHECK.value)
        print("Checking battery and continuity states")
        if(self.run_precheck()):
            self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
            self.status = START_SEQUENCE_STEPS.ABORTED
            self.parent.write_error("Precheck failed. Aborting show.")
            return

        self.show_start_time = round(time.time()*1000)+(SHOW_START_TIME_SECONDS*1000)
        print("Signaling connected async nodes to start")
        self.send_to_active_nodes("showstart",f" {self.show_start_time} 0 {self.show_id}", 6, self.async_load_targets)

        print("Waiting on start accept")
        not_ready_nodes = self.get_async_load_targets_not_with_status('startReady', True)
        nrnct=0
        while(not_ready_nodes):
            if(time.time()*1000 > self.show_start_time-(ABORT_PRE_START_SECONDS*1000)):
                print("Abort time reached and nodes still not ready. Aborting")
                self.parent.led_handler.update("error_state", ERR_STATE.DAEMON.value)
                self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
                self.status = START_SEQUENCE_STEPS.ABORTED
                for shitty_node in not_ready_nodes:
                    self.errors.append(f"Start: {shitty_node} did not signal start ready by {ABORT_PRE_START_SECONDS} before start. Aborting show.")
                return
            print("Async nodes have not reported back. Still Waiting on: ")
            print(not_ready_nodes)
            time.sleep(1)
            if(nrnct > 5):
                print("Nodes not ready, reissuing start command")
                nrnct = 0
                #not_ready_nodes is a list - convert to a dict
                not_ready_targets = {dev: self.async_load_targets[dev] for dev in not_ready_nodes}
                self.send_to_active_nodes("showstart",f" {self.show_start_time} 0 {self.show_id}", 5, not_ready_targets)
            not_ready_nodes = self.get_async_load_targets_not_with_status('startReady', True)
            nrnct=nrnct+1
        try:
            time.sleep(1)
            self.status = START_SEQUENCE_STEPS.START_CONFIRMED
            self.parent.led_handler.update("show_run_state", RUN_STATE.COUNTDOWN.value)
            print("Waiting for show start.")

            while(time.time()*1000 < self.show_start_time):
                self.send_to_active_nodes("play", " 0", 5, self.async_load_targets)
                time.sleep(3)
                if self.schedule_stop_event.is_set():
                    print("Schedule stopped signaling nodes.")
                    self.running_show = False
                    self.status = START_SEQUENCE_STEPS.ABORTED
                    self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
                    self.send_to_active_nodes("stop", " 0", 5)
                    return
            self.status = START_SEQUENCE_STEPS.STARTED
            self.parent.led_handler.update("show_run_state", RUN_STATE.RUNNING.value)
            print("Started show!")
            self.running_show = True  # Set running state
            print(self.firing_array)
            pause_start = 0
            pause_offset = 0
            start_time_epoch_sms = time.time()
            last_write_time = time.time()  # Track last file write time

            for item in self.firing_array:
                delay = item['startTime']  # Convert to MS
                while (time.time() - start_time_epoch_sms) < (delay + pause_offset):
                    if self.schedule_stop_event.is_set():
                        print("Schedule stopped signaling nodes.")
                        self.running_show = False
                        self.status = START_SEQUENCE_STEPS.ABORTED
                        self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
                        self.send_to_active_nodes("stop", " 0", 5)
                        return
                    if self.schedule_pause_event.is_set():
                        print("Schedule paused.")
                        pause_start = time.time()
                        self.send_to_active_nodes("pause", " 0", 5)
                        while self.schedule_pause_event.is_set():  # Stay in paused state
                            time.sleep(0.1)
                            if self.schedule_stop_event.is_set():
                                print("Schedule stopped.")
                                self.send_to_active_nodes("stop", " 0", 5)
             
                                self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
                                self.running_show = False
                                return

                        if pause_start:
                            pause_offset += (time.time() - pause_start)
                            pause_start = 0

                        print("Schedule resumed.")
                        self.parent.led_handler.update("show_run_state", RUN_STATE.RUNNING.value)
                        self.send_to_active_nodes("play", " 0", 5)

                    time.sleep(0.01)  # Check stop event frequently
                    self.time_cursor = round((time.time() - start_time_epoch_sms + pause_offset),2)

                    # Overwrite file every second
                    if time.time() - last_write_time >= 1:
                        self.parent.write_time_cursor(self.time_cursor)
                        last_write_time = time.time()

                self.fire_item(item)
                print(f"Executing scheduled command: {item}")
            print("All commands fired.")
            self.running_show = False
            self.parent.led_handler.update("show_run_state", RUN_STATE.OFF.value)
            self.status = START_SEQUENCE_STEPS.LOADED
            return
        except Exception as e:
            print(f"Error in schedule: {e}")
            self.parent.led_handler.update("error_state", ERR_STATE.DAEMON.value)
            self.parent.write_error(f"Error in schedule: {e}")
            self.parent.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
            return
