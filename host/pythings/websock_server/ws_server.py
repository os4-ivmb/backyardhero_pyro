import asyncio
import websockets
import os
import json
import time
import hashlib
import psutil
from datetime import datetime

from enum import Enum

LED_FILE_PATH = "/data/webactstate"

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

def get_fw_state():
    fw_state = {}
    if os.path.exists("/data/state"):
        with open("/data/state", "r") as state_file:
            state_content = state_file.read().strip()
            fw_state = json.loads(state_content)
            fw_state["daemon_active"] = not (
                datetime.now().timestamp() - (int(fw_state["daemon_lup"]) / 1000) > DAEMON_INAC_SECONDS
            )
    else:
  
        fw_state = {}

    return fw_state


def _gather_state_blocking():
    """All synchronous I/O (file reads + psutil) lives here so we can hand
    the whole thing to ``asyncio.to_thread`` and avoid blocking the event
    loop (and therefore every other connected WebSocket client)."""
    result = {
        "fw_cursor": None,
        "fw_firing": None,
        "fw_states": None,
        "fw_system": {},
        "fw_error": [],
    }

    result["fw_system"]["temp"] = get_cpu_temperature()
    result["fw_system"]["usage"] = get_system_usage()

    # Check for /tmp/fw_cursor
    try:
        if os.path.exists("/tmp/fw_cursor"):
            with open("/tmp/fw_cursor", "r") as cursor_file:
                cursor_content = cursor_file.read().strip()
                result["fw_cursor"] = float(cursor_content)
        else:
            result["fw_cursor"] = -1
    except Exception:
        print("ERR reading /tmp/fw_cursor")
        result["fw_cursor"] = -2

    # Check for /tmp/fw_firing
    try:
        if os.path.exists("/tmp/fw_firing"):
            with open("/tmp/fw_firing", "r") as firing_file:
                firing_content = firing_file.read().strip()
                result["fw_firing"] = json.loads(firing_content)
        else:
            result["fw_firing"] = {}
    except Exception as e:
        result["fw_firing"] = {"err": str(e)}

    # Read the daemon state file. Single attempt here; the async caller
    # handles retry so we don't block the loop with time.sleep().
    try:
        result["fw_state"] = get_fw_state()
    except Exception as e:
        # Re-raise so the caller can decide whether to retry.
        raise

    # Tail the daemon error log. Lines are emitted in chronological
    # order (oldest first) so the client's timestamp regex can parse
    # them. A long-standing typo here did `[s[::-1] for s in tail]`,
    # which reverses each *line's characters* (not the list order) and
    # broke timestamp extraction on the client -- daemon.err entries
    # silently never made it to toasts.
    try:
        error_log_path = "/data/log/daemon.err"
        if os.path.exists(error_log_path):
            tail = get_last_n_lines(error_log_path, 5)
            result["fw_d_error"] = tail if isinstance(tail, list) else []
        else:
            result["fw_d_error"] = []
    except Exception as e:
        result["fw_error"] = {"err": str(e)}

    return result


async def read_file_content():
    """
    Reads the content of the files /tmp/fw_cursor, /tmp/fw_firing, and the
    daemon error log. Heavy work is offloaded to a worker thread so other
    connected WebSocket clients aren't blocked while it runs.
    """
    last_exc = None
    for attempt in range(2):
        try:
            result = await asyncio.to_thread(_gather_state_blocking)
            result["fw_last_update"] = int(time.time() * 1000)
            return result
        except Exception as e:
            print(f"EXC RETRY {attempt}")
            print(str(e))
            last_exc = e
            # Async sleep so other coroutines (and other WS clients) can run
            # while we wait for the daemon to finish writing /data/state.
            await asyncio.sleep(0.25)

    # Both attempts failed -- still return a minimal payload so the client
    # gets something rather than the connection silently stalling.
    return {
        "fw_cursor": -2,
        "fw_firing": {"err": str(last_exc) if last_exc else "unknown"},
        "fw_state": {},
        "fw_d_error": [],
        "fw_system": {},
        "fw_error": [],
        "fw_last_update": int(time.time() * 1000),
    }


def _stable_signature(payload):
    """Hash the payload *excluding* the per-tick timestamp so we only treat
    it as 'changed' when something meaningful actually moved."""
    snapshot = {k: v for k, v in payload.items() if k != "fw_last_update"}
    encoded = json.dumps(snapshot, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()


async def file_update_server(websocket):
    """
    WebSocket server that sends updated file data every 500ms to connected
    clients. When the meaningful state hasn't changed we send a small
    heartbeat instead of resending the multi-KB payload, but we still emit
    a full snapshot at least every ``HEARTBEAT_FORCE_SECONDS`` so a
    just-connected client doesn't have to wait for a real change.
    """

    updateWebLEDState(WEB_ACT_STATE.RUNNING.value)
    last_signature = None
    last_full_send_ts = 0.0
    try:
        while True:
            file_data = await read_file_content()
            sig = _stable_signature(file_data)
            now = time.time()
            unchanged = (sig == last_signature)
            within_force_window = (now - last_full_send_ts) < HEARTBEAT_FORCE_SECONDS

            if unchanged and within_force_window:
                payload = {
                    "_hb": True,
                    "fw_last_update": file_data["fw_last_update"],
                }
            else:
                payload = file_data
                last_signature = sig
                last_full_send_ts = now

            await websocket.send(json.dumps(payload))
            await asyncio.sleep(0.5)  # Send updates every 500ms
    except websockets.exceptions.ConnectionClosed as e:
        print("Client disconnected")
        updateWebLEDState(WEB_ACT_STATE.DISCONNECTED.value)
    except Exception as e:
        updateWebLEDState(WEB_ACT_STATE.CRASHED.value)
        print(f"Error: {e}")

async def main():
    """
    Starts the WebSocket server on port 8080.
    """
    server = await websockets.serve(file_update_server, "0.0.0.0", 8090)
    print("WebSocket server is running")
    await server.wait_closed()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Server stopped")
