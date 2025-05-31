import asyncio
import websockets
import os
import json
import time
import psutil
from datetime import datetime

from enum import Enum

LED_FILE_PATH = "/data/webactstate"


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

def get_system_usage():
    # CPU usage percentage
    cpu_percent = psutil.cpu_percent(interval=1)  # 1-second sampling

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

def get_last_n_lines(file_path, n):
    """Efficiently reads the last n lines of a file."""
    try:
        with open(file_path, "rb") as file:
            file.seek(0, os.SEEK_END)
            buffer = bytearray()
            pointer_location = file.tell()
            while pointer_location > 0 and buffer.count(b"\n") <= n:
                pointer_location -= 1
                file.seek(pointer_location)
                buffer.extend(file.read(1))
            # Decode and split lines, returning the last n lines
            return buffer.decode("utf-8").strip().splitlines()[-n:]
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

async def read_file_content():
    """
    Reads the content of the files /tmp/fw_cursor, /tmp/fw_firing, and /home/jeezy/proj/firework/host/data/log/daemon.err.
    Returns a dictionary with their data or None if they don't exist.
    """
    result = {
        "fw_cursor": None,
        "fw_firing": None,
        "fw_states": None,
        "fw_last_update": int(time.time() * 1000),
        "fw_system": {},
        "fw_error": []
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
    except Exception as e:
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

    # Check for states
    fws_retry_ct = 0
    fws_complete = False
    result["fw_state"] = {}
    while(fws_retry_ct < 2 and not fws_complete):
        try:
            result["fw_state"] = get_fw_state()
            fws_complete = True
        except Exception as e:
            print(f"EXC RETRY {fws_retry_ct}")
            print(str(e))
            fws_retry_ct = fws_retry_ct + 1
            time.sleep(0.250)

    # Check for daemon.err
    try:
        error_log_path = "/data/log/daemon.err"
        if os.path.exists(error_log_path):
            result["fw_d_error"] = [ s[::-1] for s in get_last_n_lines(error_log_path, 5) ]
        else:
            result["fw_d_error"] = []
    except Exception as e:
        result["fw_error"] = {"err": str(e)}

    return result

async def file_update_server(websocket):
    """
    WebSocket server that sends updated file data every 500ms to connected clients.
    """

    updateWebLEDState(WEB_ACT_STATE.RUNNING.value)
    try:
        while True:
            file_data = await read_file_content()
            await websocket.send(json.dumps(file_data))
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