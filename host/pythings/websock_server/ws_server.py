import asyncio
import os
import socket
import errno
import websockets
import json
import time
import hashlib
import psutil
from datetime import datetime

from enum import Enum

LED_FILE_PATH = "/data/webactstate"
STATE_FILE_PATH = "/data/state"
CURSOR_FILE_PATH = "/tmp/fw_cursor"
FIRING_FILE_PATH = "/tmp/fw_firing"
ERR_LOG_PATH = "/data/log/daemon.err"

# Unix datagram socket path the daemon publishes state snapshots to. We
# bind it; the daemon does fire-and-forget sendto(). Lets us push state
# to clients with sub-millisecond latency from "daemon mutated state" to
# "browser sees the new value" -- much faster than the previous
# polling-on-a-500ms-sleep loop.
STATE_SOCKET_PATH = "/tmp/byh_state.sock"

# Prime psutil.cpu_percent so subsequent non-blocking calls return a real
# delta-since-last-call instead of 0.0. Without this we'd either have to
# block (interval=1) every read or always get 0 on the first call.
psutil.cpu_percent(interval=None)


class WEB_ACT_STATE(Enum):
    OFF = 0
    RUNNING = 1
    DISCONNECTED = 2
    CRASHED = 3


def updateWebLEDState(value):
    # Read the JSON file
    try:
        with open(LED_FILE_PATH, 'w') as file:
            file.write(str(value))
    except (FileNotFoundError, json.JSONDecodeError):
        pass


DAEMON_INAC_SECONDS = 10
# How often to force a full payload even if nothing changed, so a freshly
# (re)connected client picks up state without waiting for a real change.
HEARTBEAT_FORCE_SECONDS = 5
# Cap how often we re-render and ship the full payload, even when state
# changes faster than this. 30 Hz is generous for an operations console
# and keeps a chatty daemon (or a pathological inotify storm) from
# saturating the WS.
MIN_SEND_INTERVAL_S = 1.0 / 30.0


def get_system_usage():
    # Non-blocking sample: returns the % CPU used since the previous call.
    # The first call after import is primed above so we always have a baseline.
    cpu_percent = psutil.cpu_percent(interval=None)

    # Memory usage
    memory = psutil.virtual_memory()
    total_memory = memory.total / (1024 ** 2)  # Convert bytes to MB
    available_memory = memory.available / (1024 ** 2)  # Convert bytes to MB
    used_memory = memory.used / (1024 ** 2)  # Convert bytes to MB
    memory_percent = memory.percent

    return {
        "cpu_percent": cpu_percent,
        "total_memory_mb": total_memory,
        "available_memory_mb": available_memory,
        "used_memory_mb": used_memory,
        "memory_percent": memory_percent,
    }

def get_cpu_temperature():
    try:
        # Open the thermal zone file to read CPU temperature
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as file:
            temp_c = int(file.read().strip()) / 1000.0  # Convert from millidegrees to Celsius
            temp_f = (temp_c * 9/5) + 32  # Convert Celsius to Fahrenheit
            return round(temp_f)
    except FileNotFoundError:
        return 0

def get_last_n_lines(file_path, n, chunk_size=4096):
    """Efficiently read the last n lines of a file by walking backwards in
    chunks rather than one byte at a time. The previous implementation
    issued one read() per byte which becomes O(filesize) syscalls per WS
    tick once the error log grows.
    """
    try:
        n = max(0, int(n))
        if n == 0:
            return []
        with open(file_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            if end == 0:
                return []
            buffer = bytearray()
            pos = end
            # Stop once we have at least n+1 newlines (so we can confidently
            # drop a possibly-partial first line) or once we hit the file
            # start.
            while pos > 0 and buffer.count(b"\n") <= n:
                read_size = min(chunk_size, pos)
                pos -= read_size
                f.seek(pos)
                chunk = f.read(read_size)
                buffer[:0] = chunk  # prepend
            text = buffer.decode("utf-8", errors="replace")
            lines = text.splitlines()
            return lines[-n:] if len(lines) > n else lines
    except Exception as e:
        return {"err": str(e)}

def _augment_fw_state(fw_state):
    """Tag in `daemon_active` based on the file's daemon_lup timestamp.

    Shared between the unix-socket fast path and the file fallback so
    both paths produce identical envelopes.
    """
    if not fw_state:
        return fw_state
    try:
        fw_state["daemon_active"] = not (
            datetime.now().timestamp() - (int(fw_state["daemon_lup"]) / 1000)
            > DAEMON_INAC_SECONDS
        )
    except Exception:
        fw_state["daemon_active"] = False
    return fw_state


def _read_fw_state_from_file():
    """Fallback path used when no unix-socket snapshot has arrived yet
    (e.g. WS server started before the daemon, or the daemon hasn't
    published since this client connected).
    """
    try:
        if not os.path.exists(STATE_FILE_PATH):
            return {}
        with open(STATE_FILE_PATH, "r") as state_file:
            return _augment_fw_state(json.loads(state_file.read().strip()))
    except Exception:
        return {}


# Module-global "latest snapshot from the daemon" cache. Populated by the
# state-socket consumer task; read by every connected WS client. Keeping
# this at module scope lets the consumer parse the JSON exactly once per
# daemon publish, then fan it out to N clients without per-client work.
LATEST_FW_STATE = {}
LATEST_FW_STATE_TS = 0.0
# A signal every WS client coroutine waits on so they wake immediately on
# new state instead of polling a deadline. asyncio.Event would only allow
# one wake-and-clear cycle to be observed cleanly across many waiters; we
# use a small "version counter + Condition" pattern instead.
STATE_VERSION = 0
STATE_COND = None  # populated in main() once the loop is running


def _gather_aux_blocking():
    """Read the small auxiliary inputs that aren't carried on the
    unix-socket fast path: timeline cursor, last-fired marker, daemon
    error log tail, system stats. Synchronous so it lives in
    asyncio.to_thread.
    """
    aux = {
        "fw_cursor": None,
        "fw_firing": None,
        "fw_system": {},
        "fw_error": [],
        "fw_d_error": [],
    }

    aux["fw_system"]["temp"] = get_cpu_temperature()
    aux["fw_system"]["usage"] = get_system_usage()

    try:
        if os.path.exists(CURSOR_FILE_PATH):
            with open(CURSOR_FILE_PATH, "r") as cursor_file:
                aux["fw_cursor"] = float(cursor_file.read().strip())
        else:
            aux["fw_cursor"] = -1
    except Exception:
        aux["fw_cursor"] = -2

    try:
        if os.path.exists(FIRING_FILE_PATH):
            with open(FIRING_FILE_PATH, "r") as firing_file:
                aux["fw_firing"] = json.loads(firing_file.read().strip())
        else:
            aux["fw_firing"] = {}
    except Exception as e:
        aux["fw_firing"] = {"err": str(e)}

    try:
        if os.path.exists(ERR_LOG_PATH):
            tail = get_last_n_lines(ERR_LOG_PATH, 5)
            aux["fw_d_error"] = tail if isinstance(tail, list) else []
        else:
            aux["fw_d_error"] = []
    except Exception as e:
        aux["fw_error"] = {"err": str(e)}

    return aux


async def _bind_state_socket():
    """Bind the unix datagram socket the daemon publishes to.

    Removes any stale socket file from a previous crash; if binding still
    fails we fall back to the file-watcher path (the daemon's
    update_state_file write still happens, so we never go blind).
    """
    try:
        if os.path.exists(STATE_SOCKET_PATH):
            os.unlink(STATE_SOCKET_PATH)
    except OSError:
        pass

    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.setblocking(False)
        # Generous receive buffer so a daemon burst doesn't drop packets.
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
        except OSError:
            pass
        sock.bind(STATE_SOCKET_PATH)
        # World-writable so the daemon (which may run under a different
        # uid in some deployments) can sendto() us. Inside our single
        # docker container today this is moot, but it's the right default.
        try:
            os.chmod(STATE_SOCKET_PATH, 0o666)
        except OSError:
            pass
        return sock
    except Exception as e:
        print(f"State socket bind failed (will rely on file fallback): {e}")
        return None


def _ingest_state_datagram(data):
    """Synchronous helper that parses one daemon-published snapshot and
    bumps STATE_VERSION. Pulled out so the add_reader callback (which
    runs on the loop thread, not in a coroutine) can call it directly.
    """
    global LATEST_FW_STATE, LATEST_FW_STATE_TS, STATE_VERSION
    try:
        fw_state = json.loads(data.decode("utf-8"))
    except Exception as e:
        print(f"state datagram json error: {e}")
        return
    LATEST_FW_STATE = _augment_fw_state(fw_state)
    LATEST_FW_STATE_TS = time.time()
    STATE_VERSION += 1


async def state_socket_consumer():
    """Drain the unix datagram socket and notify STATE_COND waiters.

    Each datagram is exactly one JSON snapshot of fw_state (the same
    bytes the daemon's update_state_file writes to /data/state). We
    parse once and stash in LATEST_FW_STATE so every connected WS
    client sees the same object without re-parsing.

    Uses loop.add_reader rather than the higher-level
    create_datagram_endpoint because AF_UNIX SOCK_DGRAM support in the
    transport layer is uneven across Python versions; add_reader is
    universally available.
    """
    sock = await _bind_state_socket()
    if sock is None:
        # No socket -> rely entirely on the file watcher.
        return

    loop = asyncio.get_running_loop()

    async def _notify():
        async with STATE_COND:
            STATE_COND.notify_all()

    def on_readable():
        # Coalesce a burst of datagrams: drain everything currently
        # queued and publish only the most recent. This is what gives
        # us "one notify per dongle ack burst" rather than 16.
        latest = None
        while True:
            try:
                data, _addr = sock.recvfrom(1 << 20)
            except (BlockingIOError, InterruptedError):
                break
            except OSError as e:
                if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    break
                print(f"state_socket_consumer recv error: {e}")
                return
            latest = data
        if latest is None:
            return
        _ingest_state_datagram(latest)
        # add_reader's callback runs synchronously on the loop thread,
        # so we can't `await` here. Schedule the notify_all in a task.
        asyncio.create_task(_notify())

    loop.add_reader(sock.fileno(), on_readable)
    try:
        # Park forever -- the add_reader callback does all the work.
        # We just hold the socket alive and clean it up on cancel.
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass
    finally:
        try:
            loop.remove_reader(sock.fileno())
        except Exception:
            pass
        try:
            sock.close()
        except Exception:
            pass
        try:
            if os.path.exists(STATE_SOCKET_PATH):
                os.unlink(STATE_SOCKET_PATH)
        except Exception:
            pass


async def _publish_new_state(fw_state):
    """Adopt a fresh fw_state snapshot and notify all WS clients."""
    global LATEST_FW_STATE, LATEST_FW_STATE_TS, STATE_VERSION
    if not fw_state:
        return
    LATEST_FW_STATE = fw_state
    LATEST_FW_STATE_TS = time.time()
    STATE_VERSION += 1
    async with STATE_COND:
        STATE_COND.notify_all()


async def state_file_watcher():
    """Inotify-driven fallback for when the daemon publishes via file
    only (older daemon, socket bind failed, etc.). Uses watchfiles which
    sits on inotify (Linux) / FSEvents (macOS) -- sub-5ms reaction to
    os.replace().
    """
    # Initial population: read the file once at startup so a freshly
    # connected client doesn't have to wait for the daemon's next write.
    await _publish_new_state(_read_fw_state_from_file())

    try:
        from watchfiles import awatch
    except ImportError:
        # Library missing -- degrade to a slow poll so we still serve
        # clients, just at higher latency. (The unix-socket fast path
        # may already be feeding us real-time updates regardless.)
        print("watchfiles not installed; falling back to 500ms polling")
        while True:
            await asyncio.sleep(0.5)
            await _publish_new_state(_read_fw_state_from_file())
        return

    # Watch the dir (not the file) so the daemon's atomic rename pattern
    # doesn't make the watch go stale. debounce=10ms folds a
    # mkstemp+rename pair into one wake-up.
    state_dir = os.path.dirname(STATE_FILE_PATH) or "."
    async for _changes in awatch(state_dir, debounce=10):
        await _publish_new_state(_read_fw_state_from_file())


async def aux_watcher():
    """Inotify watch for /tmp/fw_cursor and /tmp/fw_firing, the auxiliary
    files the daemon updates during show playback. Notifying STATE_COND
    on changes triggers an immediate WS push that includes the fresh
    cursor / firing values along with the latest fw_state.
    """
    global STATE_VERSION
    try:
        from watchfiles import awatch
    except ImportError:
        return

    async for changes in awatch("/tmp", debounce=10):
        if any(p in (CURSOR_FILE_PATH, FIRING_FILE_PATH) for _ev, p in changes):
            STATE_VERSION += 1
            async with STATE_COND:
                STATE_COND.notify_all()


def _stable_signature(payload):
    """Hash the payload *excluding* the per-tick timestamp so we only treat
    it as 'changed' when something meaningful actually moved."""
    snapshot = {k: v for k, v in payload.items() if k != "fw_last_update"}
    encoded = json.dumps(snapshot, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()


async def _build_payload():
    """Combine the cached fw_state with freshly-read auxiliary inputs."""
    aux = await asyncio.to_thread(_gather_aux_blocking)
    payload = dict(aux)
    payload["fw_state"] = LATEST_FW_STATE or _read_fw_state_from_file()
    payload["fw_last_update"] = int(time.time() * 1000)
    return payload


async def file_update_server(websocket):
    """
    Per-client task: send a fresh payload whenever STATE_COND fires (i.e.
    new daemon snapshot or new cursor/firing tick). Sends a heartbeat at
    least every HEARTBEAT_FORCE_SECONDS so a just-connected client sees
    state even during a quiet period. Also rate-limits sends to
    MIN_SEND_INTERVAL_S so a chatty daemon can't drown the WS pipe.
    """
    updateWebLEDState(WEB_ACT_STATE.RUNNING.value)
    last_signature = None
    last_full_send_ts = 0.0
    last_seen_version = -1

    try:
        # Send an initial snapshot immediately so the UI doesn't have to
        # wait for a state mutation to render.
        initial = await _build_payload()
        last_signature = _stable_signature(initial)
        last_full_send_ts = time.time()
        last_seen_version = STATE_VERSION
        await websocket.send(json.dumps(initial))

        while True:
            # Wake on either a state-version bump or a heartbeat timeout.
            # Use wait_for with the heartbeat as an upper bound rather
            # than a fixed sleep -- otherwise a hot daemon would still
            # send at heartbeat cadence at minimum.
            try:
                async with STATE_COND:
                    if STATE_VERSION == last_seen_version:
                        await asyncio.wait_for(
                            STATE_COND.wait(),
                            timeout=HEARTBEAT_FORCE_SECONDS,
                        )
            except asyncio.TimeoutError:
                pass

            # Rate-limit to MIN_SEND_INTERVAL_S so a daemon publishing at
            # > 30 Hz can't melt the WS frame budget.
            since_last = time.time() - last_full_send_ts
            if since_last < MIN_SEND_INTERVAL_S:
                await asyncio.sleep(MIN_SEND_INTERVAL_S - since_last)

            payload = await _build_payload()
            sig = _stable_signature(payload)
            now = time.time()
            unchanged = (sig == last_signature)
            within_force_window = (now - last_full_send_ts) < HEARTBEAT_FORCE_SECONDS

            if unchanged and within_force_window:
                # No meaningful change; send a tiny heartbeat so the
                # client knows we're still here.
                hb = {"_hb": True, "fw_last_update": payload["fw_last_update"]}
                await websocket.send(json.dumps(hb))
            else:
                last_signature = sig
                last_full_send_ts = now
                await websocket.send(json.dumps(payload))

            last_seen_version = STATE_VERSION
    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")
        updateWebLEDState(WEB_ACT_STATE.DISCONNECTED.value)
    except Exception as e:
        updateWebLEDState(WEB_ACT_STATE.CRASHED.value)
        print(f"Error: {e}")


async def main():
    """Start the WebSocket server + the state pumps."""
    global STATE_COND
    STATE_COND = asyncio.Condition()

    # Spin up the state pumps before accepting clients so an
    # immediately-connected client doesn't see stale state.
    pumps = [
        asyncio.create_task(state_socket_consumer(), name="state_socket"),
        asyncio.create_task(state_file_watcher(),    name="state_file"),
        asyncio.create_task(aux_watcher(),           name="aux_watch"),
    ]

    server = await websockets.serve(file_update_server, "0.0.0.0", 8090)
    print("WebSocket server is running")
    try:
        await server.wait_closed()
    finally:
        for t in pumps:
            t.cancel()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Server stopped")
