import os
import serial
import socket
import sys
import threading
import time
import json
from pathlib import Path

# The shared esptool/port helpers live in devices/utils (dongle_flasher.py).
# Add it to sys.path so we can reuse resolve_dongle_port for VID-based
# auto-reconnect. Import stays lazy (inside the helper) so a missing dep
# degrades to "no auto-redetect" rather than failing startup. The dir's
# location differs by deployment:
#   - source checkout / Docker: <repo>/devices/utils (two levels up from here)
#   - desktop bundle: no repo tree; build-resources.mjs ships a copy under
#     resources/devices/utils and the supervisor exports BYH_DEVICES_UTILS_DIR.
_REPO_ROOT = Path(__file__).resolve().parents[2]


def _resolve_devices_utils():
    here = Path(__file__).resolve()
    candidates = []
    env_dir = os.environ.get("BYH_DEVICES_UTILS_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    candidates.append(_REPO_ROOT / "devices" / "utils")       # source checkout
    candidates.append(here.parents[1] / "devices" / "utils")  # desktop bundle
    for cand in candidates:
        if (cand / "dongle_flasher.py").is_file():
            return cand
    return _REPO_ROOT / "devices" / "utils"


_DEVICES_UTILS = _resolve_devices_utils()
if str(_DEVICES_UTILS) not in sys.path:
    sys.path.insert(0, str(_DEVICES_UTILS))

# Default configuration.
#
# Startup precedence for the port: the operator's configured dongle port
# (systemcfg.json overlaid with systemcfg.user.json) wins, then an env-supplied
# value (desktop auto-detect / docker-compose), then the hardcoded fallback.
#
# Why read the config here at all: the daemon connects shortly after startup
# and issues a config_serial with exactly this configured port. If the bridge
# instead opened its own default first, it would make a doomed connection
# attempt against the wrong device (the classic "tries /dev/tty.usbmodem01
# before choosing the right one" symptom) until the daemon's reconfigure
# landed. Seeding from the same config the daemon reads makes the bridge's
# very first open target the right port.
#
# Config-dir resolution mirrors the rest of the stack (BYH_CONFIG_DIR, default
# /config under Docker/desktop) but also falls back to the repo-relative
# host/config -- the macOS host-native bridge (run/osx/start.sh) launches with
# cwd=host/ and no BYH_CONFIG_DIR, so /config doesn't exist there.
def _resolve_config_dir():
    env_dir = os.environ.get('BYH_CONFIG_DIR')
    candidates = []
    if env_dir:
        candidates.append(env_dir)
    candidates.append('/config')
    candidates.append(str(_REPO_ROOT / 'host' / 'config'))
    for d in candidates:
        if os.path.exists(os.path.join(d, 'systemcfg.json')):
            return d
    return candidates[0]


_CONFIG_DIR = _resolve_config_dir()


def _deep_merge(base, override):
    if not isinstance(base, dict) or not isinstance(override, dict):
        return override
    out = dict(base)
    for k, v in override.items():
        if isinstance(out.get(k), dict) and isinstance(v, dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _load_system_block():
    """Best-effort read of the merged `system` block. Returns {} on any
    failure so a missing/garbled config never keeps the bridge from starting."""
    def read(name):
        try:
            with open(os.path.join(_CONFIG_DIR, name)) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    merged = _deep_merge(read('systemcfg.json'), read('systemcfg.user.json'))
    system = merged.get('system')
    return system if isinstance(system, dict) else {}


def _initial_serial_config():
    system = _load_system_block()
    port = system.get('dongle_port') or os.environ.get('SERIAL_PORT') or '/dev/tty.usbmodem01'
    baud = system.get('dongle_baud') or os.environ.get('SERIAL_BAUD') or 115200
    try:
        baud = int(baud)
    except (TypeError, ValueError):
        baud = 115200
    return {'port': port, 'baud': baud}


SERIAL_CONFIG = _initial_serial_config()
# Bind address for the serial-injection TCP port. This port lets any
# client write raw serial straight to the dongle ("fire <ident> <cue>"),
# so it must NOT be exposed on the LAN / Wi-Fi AP interface (C4.1).
# Default to loopback (works on Docker Desktop where host.docker.internal
# forwards to the host loopback). On Linux/Pi the launcher sets
# BYH_BRIDGE_BIND to the docker bridge gateway (e.g. 172.17.0.1) so the
# container can still reach it while wlan0 clients cannot.
TCP_HOST = os.environ.get('BYH_BRIDGE_BIND', '127.0.0.1')
TCP_PORT = 9000

# Global serial connection
serial_conn = None
serial_lock = threading.Lock()

# Set to True while the flasher service has the dongle's USB-CDC port
# checked out for esptool. While True the forwarder threads must NOT
# hold the port open (esptool needs exclusive access) and the auto-
# reconnect helper must not race with esptool's own port management.
# Cleared by flash_resume_serial() once the flash finishes (or aborts);
# the existing _try_auto_reopen path then reattaches as the dongle
# re-enumerates after the post-flash hard reset.
flashing = False

# Auto-reconnect bookkeeping. The dongle may reboot during operation
# (e.g. its hardware task watchdog firing during a hostile OTA RF link,
# or the operator unplug/replug). On macOS, the /dev/tty.usbmodem* path
# usually stays the same across a reboot -- we just need to wait ~1-3s
# for re-enumeration and re-open it. Without this, every dongle reboot
# turned into "bridge spams 'Errno 6: Device not configured' until
# someone restarts the bridge", and the OTA driver had no path back to
# the dongle.
RECONNECT_BACKOFF_S      = 1.0   # initial delay between reconnect attempts
RECONNECT_BACKOFF_MAX_S  = 5.0   # cap so we keep retrying briskly
_last_reconnect_attempt  = 0.0   # monotonic timestamp of last attempt
_consecutive_failures    = 0
# After this many consecutive failures to open the configured port, try
# re-resolving the dongle by USB vendor id -- it may have re-enumerated
# onto a different COM/tty (ESP32-S2 native USB-CDC does this on reboot
# or replug, and always on Windows where COM numbers aren't stable).
PORT_REDETECT_AFTER_FAILURES = 3
# Stale-handle watchdog. The dongle emits a ~1Hz status frame the whole
# time it's connected, so a serial handle that reports "open" yet delivers
# no bytes for this long is almost certainly a zombie. This is the classic
# Windows sleep/resume failure: the USB-CDC file handle survives suspend,
# but after resume it never delivers data again AND never raises on read,
# so the normal disconnect-detection path (read error -> reopen) never
# fires and the dongle stays "Silent" until a physical replug. When we hit
# this threshold we force a close + reopen (which re-resolves the port by
# VID) so the link self-heals without operator intervention.
SERIAL_SILENCE_TIMEOUT_S = 10.0


def _resolve_dongle_port_safe(prefer=None, before=None):
    """Best-effort VID-based dongle port resolution. Returns None on any
    failure (missing pyserial, import error) so callers stay robust."""
    try:
        from dongle_flasher import resolve_dongle_port
    except Exception:
        return None
    try:
        return resolve_dongle_port(prefer=prefer, before=before)
    except Exception:
        return None

def _try_auto_reopen():
    """Attempt to re-open the serial port using the last-known config.

    Throttled so we don't spin in a tight loop while the dongle is
    physically gone. Safe to call from either the read or write thread;
    the serial_lock + idempotent close serialize concurrent calls.
    """
    global serial_conn, _last_reconnect_attempt, _consecutive_failures

    # The flasher service holds the dongle's USB-CDC port exclusively
    # while esptool is mid-flash. Re-opening here would race with
    # esptool and at best produce a corrupted flash, at worst leave
    # the dongle bricked. Bail out cleanly; the post-flash teardown
    # in flash_server clears `flashing` so the next iteration of the
    # forwarder loops will resume normal auto-reconnect.
    if flashing:
        return False

    now = time.monotonic()
    backoff = min(RECONNECT_BACKOFF_MAX_S,
                  RECONNECT_BACKOFF_S * (1 + _consecutive_failures))
    if now - _last_reconnect_attempt < backoff:
        return False
    _last_reconnect_attempt = now

    with serial_lock:
        if serial_conn:
            try:
                serial_conn.close()
            except Exception:
                pass
            serial_conn = None
        # If the configured port keeps failing, the dongle has probably
        # re-enumerated onto a different COM/tty. Re-resolve by USB vendor
        # id and follow it. Threshold-guarded so a momentary blip doesn't
        # make us thrash ports.
        if _consecutive_failures >= PORT_REDETECT_AFTER_FAILURES:
            new_port = _resolve_dongle_port_safe(prefer=SERIAL_CONFIG['port'])
            if new_port and new_port != SERIAL_CONFIG['port']:
                print(f"Serial: configured port {SERIAL_CONFIG['port']} "
                      f"unavailable; following dongle to {new_port}")
                SERIAL_CONFIG['port'] = new_port
        try:
            serial_conn = serial.Serial(
                SERIAL_CONFIG['port'],
                SERIAL_CONFIG['baud'],
                timeout=1,
            )
            print(f"Serial auto-reconnected: {SERIAL_CONFIG['port']} "
                  f"after {_consecutive_failures} failed attempt(s)")
            _consecutive_failures = 0
            return True
        except Exception as e:
            _consecutive_failures += 1
            # Log first failure + one every ~10s so the operator can
            # see something but the log isn't flooded.
            if _consecutive_failures == 1 or (_consecutive_failures % 10) == 0:
                print(f"Serial auto-reconnect attempt "
                      f"{_consecutive_failures} failed: {e}")
            serial_conn = None
            return False

def reconnect_serial(client_socket):
    """Reconnect to the serial port with current settings.

    Tries the configured port first, then -- if that can't be opened --
    falls back to re-resolving the dongle by USB vendor id and following
    it to wherever it now lives. This mirrors the auto-reconnect path
    (_try_auto_reopen) so the OPERATOR-triggered reconnect is just as
    robust: after a host sleep/resume the ESP32-S2's USB-CDC port commonly
    re-enumerates onto a different COM number (always on Windows, where COM
    numbers aren't stable), and a reconnect that only ever retried the
    stale configured port would silently fail. This is the path the
    StatusBar "Restart" affordance takes (select_serial -> config_serial),
    so without the VID fallback that button could never recover a dongle
    that moved ports.
    """
    global serial_conn, _consecutive_failures

    # Resolve a VID-based fallback BEFORE taking the lock (port enumeration
    # can be slow and we don't want to stall the forwarders). Only used if
    # the configured port fails to open.
    configured = SERIAL_CONFIG['port']
    redetected = _resolve_dongle_port_safe(prefer=configured)
    candidates = [configured]
    if redetected and redetected != configured:
        candidates.append(redetected)

    with serial_lock:
        # Close existing connection if open
        if serial_conn:
            try:
                serial_conn.close()
            except:
                pass
            serial_conn = None

        last_err = None
        for port in candidates:
            try:
                serial_conn = serial.Serial(
                    port,
                    SERIAL_CONFIG['baud'],
                    timeout=1
                )
                if port != SERIAL_CONFIG['port']:
                    print(f"Serial: configured port {SERIAL_CONFIG['port']} "
                          f"unavailable; following dongle to {port}")
                    SERIAL_CONFIG['port'] = port
                print(f"Serial connected: {SERIAL_CONFIG['port']} at {SERIAL_CONFIG['baud']} baud")
                _consecutive_failures = 0
                return True
            except Exception as e:
                last_err = e
                serial_conn = None

        print(f"Serial connection error: {last_err}")
        if(client_socket):
            response = {
                'type': 'config_response',
                'error': str(last_err)
            }
            try:
                client_socket.sendall((json.dumps(response) + '\n').encode('utf-8'))
            except Exception:
                pass
        return False

def process_command(command_data, client_socket):
    """Process configuration commands from the client"""
    global SERIAL_CONFIG
    
    try:
        # Parse the command
        cmd = json.loads(command_data.decode('utf-8'))
        
        if cmd.get('type') == 'config_serial':
            # Update configuration
            if 'port' in cmd:
                SERIAL_CONFIG['port'] = cmd['port']
            if 'baud' in cmd:
                SERIAL_CONFIG['baud'] = int(cmd['baud'])
            
            # Reconnect with new settings
            success = reconnect_serial(client_socket)
            
            # Send response
            response = {
                'tcpstatus': success,
                'serial_config': SERIAL_CONFIG
            }
            if(success):
                print("Acking success")
                client_socket.sendall((json.dumps(response) + '\n').encode('utf-8'))
            return True
            
        elif cmd.get('type') == 'get_status':
            # Return current status
            response = {
                'type': 'status_response',
                'connected': serial_conn is not None and serial_conn.is_open,
                'config': SERIAL_CONFIG
            }
            client_socket.sendall((json.dumps(response) + '\n').encode('utf-8'))
            return True
            
        return False  # Not a command
        
    except json.JSONDecodeError:
        # Not JSON, so not a command
        return False
    except Exception as e:
        print(f"Error processing command: {e}")
        return False

def serial_to_tcp(client):
    """Forward data from serial to TCP client.

    NOTE: We deliberately read only what's already in pyserial's input buffer
    (`in_waiting`) instead of `serial_conn.read(N)` with a long timeout.

    pyserial's `read(N)` on POSIX loops on `select+os.read` until either N
    bytes accumulate or the configured `serial_conn.timeout` expires. With
    `timeout=1` and small messages (e.g. an 80-byte OTA ack), a single
    `read(8192)` will hold the lock for nearly a full second waiting for the
    buffer to fill. While we hold `serial_lock`, `tcp_to_serial` cannot
    write the next outbound command -- that turned the OTA chunk loop into
    a ~2 Hz round-trip.

    By polling `in_waiting` we hold the lock for microseconds per iteration,
    which lets the OTA path (and high-rate command bursts in general) run
    at the dongle's actual radio cadence.
    """
    global serial_conn
    POLL_INTERVAL_S = 0.001   # 1ms idle poll -- plenty fast for full-speed USB CDC
    last_disconnect_log = 0.0
    # Monotonic timestamp of the last byte we actually read from serial.
    # Drives the stale-handle watchdog (see SERIAL_SILENCE_TIMEOUT_S). Reset
    # whenever we (re)open the port or park for flashing so a fresh handle
    # gets a full silence window before we suspect it.
    last_rx = time.monotonic()
    try:
        while True:
            if flashing:
                # The flasher service has the port. Park here cheaply --
                # no auto-reopen attempts, no reads. We come back to
                # life once `flashing` clears.
                time.sleep(0.1)
                last_rx = time.monotonic()
                continue
            if not (serial_conn and serial_conn.is_open):
                # Try to auto-reopen instead of just waiting passively
                # for a config_serial command to revive us. The dongle
                # may have rebooted (WDT, panic, operator replug) and
                # we want to be back online as soon as it re-enumerates.
                _try_auto_reopen()
                last_rx = time.monotonic()
                time.sleep(0.05)
                continue

            try:
                with serial_lock:
                    if not (serial_conn and serial_conn.is_open):
                        continue
                    n = serial_conn.in_waiting
                    if n > 0:
                        data = serial_conn.read(n)
                    else:
                        data = b''
            except (OSError, serial.SerialException) as e:
                # Disconnected mid-read. Drop the dead handle, kick off
                # the auto-reconnect path. Throttle the log line so a
                # multi-second outage doesn't flood the daemon log.
                now = time.monotonic()
                if now - last_disconnect_log > 2.0:
                    print(f"serial_to_tcp: read error ({e}); "
                          f"will auto-reconnect")
                    last_disconnect_log = now
                with serial_lock:
                    if serial_conn:
                        try:
                            serial_conn.close()
                        except Exception:
                            pass
                        serial_conn = None
                _try_auto_reopen()
                last_rx = time.monotonic()
                time.sleep(0.05)
                continue

            if data:
                last_rx = time.monotonic()
                try:
                    client.sendall(data)
                except OSError as e:
                    print(f"serial_to_tcp: client gone: {e}")
                    return
            else:
                # No bytes this poll. A handle that's been open but silent
                # for too long is a zombie (Windows sleep/resume): force a
                # close + reopen so we recover without a physical replug.
                if time.monotonic() - last_rx > SERIAL_SILENCE_TIMEOUT_S:
                    now = time.monotonic()
                    if now - last_disconnect_log > 2.0:
                        print(f"serial_to_tcp: no serial traffic for "
                              f"{SERIAL_SILENCE_TIMEOUT_S:.0f}s though the port "
                              f"reports open; forcing reconnect (stale handle?)")
                        last_disconnect_log = now
                    with serial_lock:
                        if serial_conn:
                            try:
                                serial_conn.close()
                            except Exception:
                                pass
                            serial_conn = None
                    _try_auto_reopen()
                    last_rx = time.monotonic()
                    continue
                time.sleep(POLL_INTERVAL_S)
    except Exception as e:
        print(f"Error in serial_to_tcp: {e}")

def tcp_to_serial(client):
    """Forward data from TCP client to serial, process commands"""
    global serial_conn
    
    try:
        buffer = b''
        while True:
            data = client.recv(2048)
            if not data:
                break  # Client disconnected

            buffer += data

            # The daemon delimits EVERY line it sends (serial commands and
            # bridge control JSON alike) with '\n'. Only act on complete
            # lines: a control JSON ('config_serial', 'get_status') split
            # across two TCP segments used to fail json.loads in
            # process_command and then get forwarded to the dongle as a
            # partial garbage line (M6). Buffer until newline first.
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                if not line:
                    continue

                # Bridge control command? (JSON object). Try to consume it
                # locally; only fall through to serial if it's genuinely
                # not a bridge command.
                if line.lstrip().startswith(b'{'):
                    if process_command(line, client):
                        continue

                # While the flasher has the port, drop everything we'd
                # forward to serial. The daemon's OTA driver tolerates
                # silent gaps via its existing dongle-silence-abort path,
                # and the receiver-OTA driver isn't running concurrently
                # (the daemon refuses to start a dongle flash while a
                # receiver flash is mid-flight, and vice versa).
                if flashing:
                    continue

                # Re-attach the newline the dongle's line parser expects.
                out = line + b'\n'

                if serial_conn and serial_conn.is_open:
                    try:
                        with serial_lock:
                            if serial_conn and serial_conn.is_open:
                                serial_conn.write(out)
                            else:
                                # Race: closed by serial_to_tcp between
                                # the outer check and lock acquisition.
                                raise serial.SerialException("closed mid-write")
                    except (OSError, serial.SerialException) as e:
                        # Dongle disappeared between checks. Drop this
                        # outbound line (host will retry the OTA chunk
                        # via timeout) and let serial_to_tcp's auto-
                        # reconnect bring the link back.
                        print(f"tcp_to_serial: write error ({e}); "
                              f"dropping {len(out)}B and continuing")
                        with serial_lock:
                            if serial_conn:
                                try:
                                    serial_conn.close()
                                except Exception:
                                    pass
                                serial_conn = None
                else:
                    # Can't send now -- drop the line rather than letting
                    # the buffer grow unbounded while the dongle is offline.
                    # Host-side OTA retry will resend whatever we lose.
                    print(f"tcp_to_serial: serial offline, "
                          f"dropping {len(out)}B")

    except Exception as e:
        print(f"Error in tcp_to_serial: {e}")

def handle_client(client_socket):
    """Handle a client connection"""
    client_socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    print("Client connected")
    
    # Create threads for bidirectional communication
    thread_serial_to_tcp = threading.Thread(target=serial_to_tcp, args=(client_socket,))
    thread_tcp_to_serial = threading.Thread(target=tcp_to_serial, args=(client_socket,))
    
    thread_serial_to_tcp.daemon = True
    thread_tcp_to_serial.daemon = True
    
    thread_serial_to_tcp.start()
    thread_tcp_to_serial.start()
    
    # Wait for client thread to finish
    thread_tcp_to_serial.join()
    client_socket.close()
    print("Client disconnected")

def start_tcp_server():
    """Start the TCP server"""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((TCP_HOST, TCP_PORT))
    server.listen(1)
    print(f"TCP server listening on {TCP_HOST}:{TCP_PORT}")
    
    try:
        while True:
            client_socket, addr = server.accept()
            print(f"Accepted connection from {addr}")
            client_thread = threading.Thread(target=handle_client, args=(client_socket,))
            client_thread.daemon = True
            client_thread.start()
    except KeyboardInterrupt:
        print("Shutting down server")
    finally:
        server.close()
        if serial_conn:
            serial_conn.close()


# ---------------------------------------------------------------------------
# Flash server hooks
# ---------------------------------------------------------------------------
#
# These three functions form the contract between the bridge (which
# owns the dongle's USB-CDC port) and the flash server (which needs to
# borrow that port for esptool).
#
# pause: close the serial fd and tell the forwarder threads to stop
#        trying to reopen it. Until resume() is called, the bridge is
#        a no-op for both directions.
# resume: clear the flag. The forwarder threads' existing
#         _try_auto_reopen path will reattach within a few hundred ms,
#         picking up the dongle on whatever /dev/ttyACMx it re-enumerated
#         to (the udev symlink /dev/byh_dongle stays put).
# current_port: what port the flasher should hand to esptool. We
#         deliberately read SERIAL_CONFIG['port'] each time -- if the
#         operator changed the port via /api/system/serial_config we
#         want the new value, not a stale snapshot.

def flash_pause_serial():
    """Release the serial port for esptool."""
    global serial_conn, flashing
    flashing = True
    with serial_lock:
        if serial_conn:
            try:
                serial_conn.close()
            except Exception as e:
                print(f"flash_pause_serial: close raised {e}")
            serial_conn = None
    print("[bridge] paused serial forwarders for dongle flash")


def flash_resume_serial():
    """Hand the port back to the bridge."""
    global flashing
    flashing = False
    print("[bridge] resumed serial forwarders post-flash")
    # Don't proactively re-open here: serial_to_tcp's _try_auto_reopen
    # loop is already calling us within 100ms, and the dongle may not
    # be back on the USB bus yet (it takes ~1-3s to re-enumerate after
    # esptool's hard reset). The auto-reconnect path handles that
    # waiting cleanly.


def flash_current_port() -> str:
    return SERIAL_CONFIG.get('port') or ''


def flash_set_port(port: str) -> None:
    """Update the bridge's target serial port.

    The flasher calls this when it follows the dongle to a re-enumerated
    port so the post-flash auto-reconnect targets the right device. We
    only update the config; the forwarder threads' _try_auto_reopen loop
    picks it up on its next iteration.
    """
    global SERIAL_CONFIG
    if port and port != SERIAL_CONFIG.get('port'):
        print(f"[bridge] flasher set serial port to {port}")
        SERIAL_CONFIG['port'] = port


if __name__ == '__main__':
    # Establish initial serial connection
    reconnect_serial(False)

    # Start the flasher HTTP server. Imported here (not at module top)
    # to keep the bridge's startup path lightweight: a missing/broken
    # dongle_flasher import shouldn't keep the regular forwarder from
    # coming up.
    try:
        from flash_server import BridgeIO, start_flash_server
        bridge_io = BridgeIO(
            pause_serial=flash_pause_serial,
            resume_serial=flash_resume_serial,
            current_port=flash_current_port,
            set_port=flash_set_port,
        )
        start_flash_server(bridge_io)
    except Exception as e:
        print(f"WARN: flash server failed to start: {e}")
        print("WARN: dongle UI updates will be unavailable; "
              "the forwarder is still up.")

    # Start TCP server
    start_tcp_server()