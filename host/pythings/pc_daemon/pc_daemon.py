import os
import time
import serial
import sqlite3
import threading
import tempfile
from datetime import datetime
import json
from enum import Enum
from led_control import *
import socket
import select

from protocol_handler.BYHProtocolHandler import BYHProtocolHandler

# Configuration
LED_FILE_PATH = "/data/ledstate"
LED_FILE_PATH_WEB = "/data/webactstate"
COMMAND_DIR = "/tmp/d_cmd"
CURSOR_FILE = "/tmp/fw_cursor"
SERIAL_PORT = "/dev/ttyACM0"
BAUD_RATE = 115200
DB_PATH = "/data/backyardhero.db"
STATE_FILE_PATH = "/data/state"
# Optional unix datagram socket the WS server can bind. When the daemon's
# state changes we fire a packet at it so the WS server doesn't have to
# wait for inotify on the state file. Falls back silently to file-based
# delivery if no listener is bound.
STATE_SOCKET_PATH = "/tmp/byh_state.sock"
LAST_SCAN_FILE_PATH = "/data/last_scan.json"
CONFIG_PATH = "/config/systemcfg.json"
ERR_LOG_PATH = "/data/log/daemon.err"
LED_DATA_PATH = "/data/leddata"  # Path for persisting LED states
SWITCH_GPIO_PIN = 20  # GPIO pin for the start/stop switch
ARMING_GPIO_PIN = 21  # GPIO pin for the arming switch
MAN_FIRE_GPIO_PIN = 12  # GPIO pin for the arming switch

SWITCH_GPIO_KEY = 'switch'
ARMING_GPIO_KEY = 'arm'
MAN_FIRE_GPIO_KEY = 'manfire' 

BAD_TX_THRESHOLD = 10 #its broken then

FUCKED_UP_SERIAL_TOKEN = "invalid start byte"

DEBUG=True


HIGH=1
LOW=0


def get_handler_cls_for_msg(line_token):
    print(line_token)
    token_to_handler = {
        "{": BYHProtocolHandler
    }

    if(token_to_handler.get(line_token[0], False)):
        return token_to_handler.get(line_token[0])
    else:
        print(f"Cannot find a handler for '{line_token}'")
        return 

class LEDHandler:
    def __init__(self, parent):
        self.led_states = {
            "daemon_act": 1,
            "web_act_state": 1,
            "tx_active": 1,
            "show_load_state": 0,
            "show_run_state": 0,
            "error_state": 0,
            "arm_state": 0,
            "led_brightness": 10,
            "receiver_timeout_ms": 30000,
            # With ACK-payload protocol, a single dongle TX returns within
            # ~3ms (success) to ~22ms (5 retries fail). 50ms is plenty.
            "command_response_timeout_ms": 50,
            "clock_sync_interval_ms": 2000,
            "debug_mode": 0
        }
        self.parent = parent
        self._load_persisted_states()

    def debug_enabled(self):
        return self.led_states.get("debug_mode", 0) == 1

    def _load_persisted_states(self):
        try:
            if os.path.exists(LED_DATA_PATH):
                with open(LED_DATA_PATH, 'r') as f:
                    loaded_states = json.load(f)
                    # Merge loaded states with defaults, ensuring all default keys are present
                    # and loaded states don't overwrite with unexpected types if possible
                    for key in self.led_states:
                        if key in loaded_states and isinstance(loaded_states[key], type(self.led_states[key])):
                            self.led_states[key] = loaded_states[key]
                        elif key in loaded_states:
                            print(f"Warning: Type mismatch for key '{key}' in {LED_DATA_PATH}. Using default.")
                    print(f"LED states loaded from {LED_DATA_PATH}")
            else:
                # If file doesn't exist, persist the default states
                print(f"No LED states found at {LED_DATA_PATH}, using defaults")
                self._persist_led_states()
        except (FileNotFoundError, json.JSONDecodeError, TypeError) as e:
            print(f"Error loading LED states from {LED_DATA_PATH}, using defaults: {e}")
            # In case of error, ensure defaults are written back
            self._persist_led_states()


    def _persist_led_states(self):
        try:
            with open(LED_DATA_PATH, 'w') as f:
                json.dump(self.led_states, f, indent=4)
        except Exception as e:
            print(f"Error persisting LED states to {LED_DATA_PATH}: {e}")
            # Optionally, you could add an error state to the LED itself here
            # self.parent.write_error(f"Failed to persist LED state: {e}")

    def update(self, key, value):
        if key in self.led_states:
            if self.led_states[key] is not value:
                self.led_states[key] = value
                self.parent.send_serial_command(json.dumps(self.led_states))
                self._persist_led_states()
                # Write to LED state file for light daemon
                try:
                    with open(LED_FILE_PATH, 'w') as f:
                        json.dump(self.led_states, f, indent=4)
                except Exception as e:
                    print(f"Error writing LED state to {LED_FILE_PATH}: {e}")
        else:
            print(f"Warning: Attempted to update non-existent LED state key '{key}'")

class GPIOHandler:
    def __init__(self, chip_name="/dev/gpiochip0"):
        # self.chip = gpiod.Chip(chip_name)
        # self.lines = {}
        self.sgpio = {
            'arm': LOW,
            'switch': LOW,
            'manfire': LOW
        }
        pass
    def setup_line(self, pin, consumer="pull_up_input"):
        pass
    def read_line(self, pin):
        return False

    def read_key(self, key):
        if(key in self.sgpio):
            return self.sgpio.get(key)
        else:
            print("Unknown Read Key")

    def set_gpio(self, gpio_dict):
        self.sgpio = gpio_dict

    def release_all(self):
        pass

gpio_handler=GPIOHandler()


class FireworkDaemon:
    def __init__(self):
        self.serial_connection = None
        self.running = True
        self.running_show = False
        self.command_timer_threads = []  # Tracks all schedule threads
        self.schedule_stop_event = threading.Event()  # Used to stop schedules
        self.schedule_pause_event = threading.Event() # that but pause
        self.last_switch_state = HIGH
        self.last_arming_state = HIGH
        self.last_man_fire_state = HIGH
        self.man_fire_enabled = False
        self.current_schedule = None
        self.last_serial_received = None
        self.last_serial_sent = None
        self.is_armed = False
        self.start_sw_active = False
        self.fire_repetition = 6
        self.led_brightness = 10
        self.bad_serial_ct = 0
        self.serial_baud = BAUD_RATE
        self.serial_addr = SERIAL_PORT
        self.loaded_show_name = None
        self.loaded_show_id = None
        self.time_cursor = None
        self.protocol_handler = None
        self.delegate_start_to_client = True
        self.waiting_for_client_start = False
        self.fire_check_failures = []
        self.tcp_buffer = ""
        # Bytes carried over from the previous recv() that didn't end on a
        # newline yet. Without this, splitlines() can hand us a partial line
        # and we'll misinterpret it.
        self.tcp_recv_buffer = bytearray()
        self.receiver_timeout_ms = 30000
        self.command_response_timeout_ms = 100
        self.clock_sync_interval_ms = 2000
        self.debug_mode = 0

        # RF spectrum diagnostics. `current_rf_channel` is updated from each
        # dongle status broadcast (the dongle now includes `ch`).
        # `last_rf_scan_summary` is a small dict (no per-channel bins —
        # those go to LAST_SCAN_FILE_PATH) we publish in /data/state so the
        # UI can show "last scanned X minutes ago, recommended ch Y" without
        # a second fetch.
        self.current_rf_channel = None
        self.last_rf_scan_summary = None
        # Dongle command-queue saturation. Updated from the per-second
        # status frame. `_capacity` defaults to None until the dongle
        # (FW v8+) reports it; the UI treats a missing capacity as
        # "unknown" rather than 0.
        self.dongle_cmd_queue_depth = 0
        self.dongle_cmd_queue_capacity = None
        # Live (post-clamp) clock-sync interval the dongle is running with.
        # Echoed back from the dongle's per-second status (FW v9+ field
        # `csim`). UI uses this to confirm the operator's edit took
        # effect (or got clamped).
        self.dongle_clock_sync_interval_ms = None
        # When set, /data/last_scan.json holds the full per-channel result
        # from the most recent scan_result we've received from the dongle.
        self.rf_scan_pending_since_ms = None

        self.led_handler = LEDHandler(self)

        # State-publish plumbing. `_state_dirty` is a threading.Event the
        # state flusher coalesces on -- any code path that mutates state
        # the UI cares about should call mark_state_dirty() rather than
        # update_state_file() directly. The flusher debounces tightly
        # (~10ms) so a burst of dongle ACK-payload status updates produces
        # one snapshot, not 16. The unix datagram socket is opened lazily
        # the first time we publish.
        self._state_dirty = threading.Event()
        self._state_pub_sock = None
        self._state_pub_warned = False

        self.load_config()

        self.clear_states()

    def mark_state_dirty(self):
        """Signal the flusher that a snapshot needs to be published.

        Cheap and lock-free: just sets a threading.Event. Safe to call
        from any thread (read_from_tcp, monitor_switch, command handlers,
        protocol handler callbacks).
        """
        self._state_dirty.set()

    def _publish_state_to_socket(self, state_json_bytes):
        """Best-effort fire-and-forget push to the WS server.

        Uses an abstract-namespace-free unix datagram so the WS server
        can `recv()` on the same path without coordination. If no
        listener is bound (WS server not running yet, or crashed), the
        send raises ENOENT/ECONNREFUSED -- we swallow it and keep going.
        The state file write still happens, so the WS server will pick
        up the next snapshot via its inotify fallback the moment it
        reconnects.
        """
        try:
            if self._state_pub_sock is None:
                self._state_pub_sock = socket.socket(
                    socket.AF_UNIX, socket.SOCK_DGRAM
                )
                # Don't block on a full socket buffer -- prefer dropping
                # an in-flight snapshot over stalling the daemon.
                self._state_pub_sock.setblocking(False)
            self._state_pub_sock.sendto(state_json_bytes, STATE_SOCKET_PATH)
            self._state_pub_warned = False
        except (FileNotFoundError, ConnectionRefusedError, BlockingIOError):
            # Most common case: WS server hasn't bound yet. The file
            # write is the fallback; don't spam the log.
            pass
        except Exception as e:
            if not self._state_pub_warned:
                print(f"State socket publish failed (will keep trying): {e}")
                self._state_pub_warned = True

    def state_flusher(self):
        """Coalesce state-dirty signals into snapshot writes.

        Wakes on every set() of the dirty event, sleeps a short debounce
        window so a burst of mutations produces a single write, then
        flushes. The 10ms window is well below human-perceptible latency
        but big enough to fold a typical 16-receiver burst into one
        snapshot.
        """
        DEBOUNCE_S = 0.01
        while self.running:
            # Block until somebody marks state dirty. Timeout periodically
            # so a quiet daemon still publishes a heartbeat snapshot
            # (handy for newly-connected WS clients during an idle moment).
            triggered = self._state_dirty.wait(timeout=1.0)
            if triggered:
                # Coalesce a burst of dirty-marks within the debounce
                # window, then publish once.
                time.sleep(DEBOUNCE_S)
            self._state_dirty.clear()
            try:
                self.update_state_file()
            except Exception as e:
                print(f"state_flusher write error: {e}")

    def debug_enabled(self):
        return self.led_handler.debug_enabled()

    def load_config(self):
        try:
            with open(CONFIG_PATH, 'r') as file:
                data = json.load(file)

                cfg_file = data.get('system')
                if(cfg_file):
                    self.serial_addr = data['system'].get("dongle_port", SERIAL_PORT)
                    self.serial_baud = data['system'].get("dongle_baud", BAUD_RATE)
                else:
                    print("No system config.")
                    

        except (FileNotFoundError, json.JSONDecodeError):
            print("Could not initialize from config. Oh well.")

    def _init_blank_webact_file(self):
        with open(LED_FILE_PATH_WEB, 'w') as file:
            file.write('0')

    def load_webact_state_and_settings(self):
        try:
            # Try to open and read the file
            with open(LED_FILE_PATH_WEB, 'r') as file:
                content = file.read().strip()
                try:
                    state = int(content)
                    self.led_handler.update('web_act_state', state)
                except ValueError:
                    print(f"Error: File content '{content}' is not a valid integer")
                    # Reset to default if content is invalid
                    self._init_blank_webact_file()
        except FileNotFoundError:
            print(f"File {LED_FILE_PATH_WEB} not found, creating with default state 0")
            self._init_blank_webact_file()
        except PermissionError:
            print(f"Error: No permission to read {LED_FILE_PATH_WEB}")
        except Exception as e:
            print(f"Error loading LED state: {e}")

    def setup_settings(self):
        try:
            with open(STATE_FILE_PATH, 'r') as file:
                data = json.load(file)

                cfg_file = data.get('settings')
                if(cfg_file):
                    self.led_brightness = int(cfg_file.get("led_brightness",50))
                    self.fire_repetition = int(cfg_file.get("fire_repeat_ct",6))
                    self.led_handler.update("led_brightness", self.led_brightness)


            
        except (FileNotFoundError, json.JSONDecodeError):
            print("Oh noooo")

    def setup_serial(self):
        """Set up the TCP connection to the serial bridge."""
        try:
            if hasattr(self, 'tcp_socket') and self.tcp_socket:
                self.tcp_socket.close()
                
            self.tcp_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.tcp_socket.connect(('host.docker.internal', 9000))  # Use the service name in Docker Compose
            
            # Configure the serial port on the bridge
            config_cmd = {
                'type': 'config_serial',
                'port': self.serial_addr,
                'baud': self.serial_baud
            }

            self.tcp_socket.sendall((json.dumps(config_cmd) + '\n').encode('utf-8'))
                
        except Exception as e:
            print(f"Error setting up TCP connection to serial bridge: {e}")
            self.write_error(f"Error setting up TCP connection to serial bridge: {e}")
            self.led_handler.update("tx_active", TX_ACTIVE_STATE.DEVICE_ERROR.value)

    def read_from_tcp(self):
        """Read data from the TCP socket and process it like serial data."""
        while self.running:
            try:
                if hasattr(self, 'tcp_socket') and self.tcp_socket:
                    # Short select timeout keeps the loop responsive (better
                    # error/state-change reactivity) without hot-spinning.
                    readable, _, _ = select.select([self.tcp_socket], [], [], 0.05)
                    data = None
                    if readable:
                        data = self.tcp_socket.recv(4096)
                    if data:
                        # Append to the carry-over buffer and only process
                        # complete newline-terminated lines. Anything after
                        # the last \n stays for the next read.
                        self.tcp_recv_buffer.extend(data)
                        last_nl = self.tcp_recv_buffer.rfind(b"\n")
                        if last_nl < 0:
                            # No complete line yet; wait for more bytes.
                            continue
                        complete = bytes(self.tcp_recv_buffer[: last_nl + 1])
                        del self.tcp_recv_buffer[: last_nl + 1]

                        # splitlines() now sees only complete lines.
                        lines = complete.decode("utf-8", errors="replace").splitlines()
                        for line in lines:
                            if line:
                                if DEBUG:
                                    print(line)
                                bypass=False
                                if line[0] == '{':
                                    try:
                                        tcpsrvmsg = json.loads(line)
                                        if('tcpstatus' in tcpsrvmsg):
                                            bypass = True
                                            print("Special TCPserv Message")
                                            if('error' in tcpsrvmsg):
                                                self.write_error(tcpsrvmsg.get('error'))
                                            if('serial_config' in tcpsrvmsg and tcpsrvmsg['tcpstatus']):
                                                if(self.debug_enabled()):
                                                    print("Acked serial set")
                                                self.serial_addr = tcpsrvmsg['serial_config'].get('port')
                                                self.serial_baud = tcpsrvmsg['serial_config'].get('baud')
                                                self.protocol_handler = BYHProtocolHandler(self)
                                        elif('gpio' in tcpsrvmsg):
                                            if(self.debug_enabled()):
                                                print("GPIO set")
                                                print(tcpsrvmsg)
                                            gpio_handler.set_gpio({
                                                'arm': int(tcpsrvmsg.get('armed')),
                                                'switch':  int(tcpsrvmsg.get('start_stop')),
                                                'manfire': int(tcpsrvmsg.get('man_fire')),
                                            })
                                        else:
                                            bypass = False

                                    except Exception as e:
                                        if(self.debug_enabled()):
                                            print("Could not process assumedly TCP. Building backup buffer")
                                        self.tcp_buffer = (self.tcp_buffer or "") + line
                                elif line[-1] == '}' and self.tcp_buffer:
                                    line = self.tcp_buffer + line 
                                    if(self.debug_enabled()):
                                        print("End fragment detected - reassembling JSON message from buffer")
                                        print(f"Line: '{line}'")
                                    self.tcp_buffer = "" 
                                elif self.tcp_buffer:
                                    if(self.debug_enabled()):
                                        print("TCP buffer set but no end fragment. Clearing buffer")
                                        print(f"Line was '{line}'")
                                    self.tcp_buffer = "" 
                                if not bypass:
                                    if not self.protocol_handler:
                                        if line[0] == '{' or line[0] == 'O':
                                            self.bad_serial_ct = 0
                                            self.led_handler.update("tx_active", TX_ACTIVE_STATE.CONNECTED.value)
                                            print("Got a state but no protocol handler. Attempting to assign")
                                            self.assign_handler_class(line)
                                    else:
                                        if not self.protocol_handler.process_serial_in(line):
                                            self.bad_serial_ct = self.bad_serial_ct + 1
                                self.last_serial_received = datetime.now()
            except Exception as e:
                self.bad_serial_ct = self.bad_serial_ct + 1
                if self.bad_serial_ct > BAD_TX_THRESHOLD:
                    self.write_error(f"Error reading from TCP socket: {e}")
                    self.led_handler.update("tx_active", TX_ACTIVE_STATE.DEVICE_ERROR.value)
                print(f"Error reading from TCP socket: {e}")
                time.sleep(0.25)  # Avoid tight loop on error

    # Replace send_serial_command as well:
    def send_serial_command(self, data):
        """Send a command over the TCP connection."""
        if hasattr(self, 'tcp_socket') and self.tcp_socket:
            try:
                wd=(data + '\n').encode('utf-8')
                self.tcp_socket.sendall((data + '\n').encode('utf-8'))
                if(self.debug_enabled()):
                    # Skip echoing OTA chunk bodies to stdout -- a single
                    # transfer is 13K+ lines of opaque hex which buries
                    # the rest of the log and (depending on the docker
                    # log driver) backpressures the daemon's read loop
                    # enough to wedge serial flow control. The OTA
                    # driver already emits structured progress events.
                    if not data.startswith("flash_data "):
                        print(f"Sent to serial via TCP: '{wd}'")
                self.last_serial_sent = datetime.now()
                self.led_handler.update("tx_active", TX_ACTIVE_STATE.TRANSMITTING.value)
            except Exception as e:
                print(f"Error sending to TCP socket: {e}")

    def setup_gpio(self):
        """Set up the GPIO pins for the switches."""
        pass

    def clear_states(self):
        self.led_handler.update("show_load_state", LOAD_STATE.OFF.value)
        self.led_handler.update("error_state", ERR_STATE.OFF.value)

    def monitor_switch(self):
        """Monitor the GPIO switches for state changes."""

        # Wait for protocol handler to be assigned. Poll instead of spinning so
        # this thread doesn't peg a CPU core during the dongle handshake.
        while self.running and not self.protocol_handler:
            time.sleep(0.05)

        while self.running:
            try:
                self.load_webact_state_and_settings()
                switch_state = gpio_handler.read_key(SWITCH_GPIO_KEY)
                arming_state = gpio_handler.read_key(ARMING_GPIO_KEY)
                man_fire_state = gpio_handler.read_key(MAN_FIRE_GPIO_KEY)


                if self.last_man_fire_state == LOW and man_fire_state == HIGH:
                    print("Manual Fire Disabled.")
                    if self.protocol_handler.show_loaded:
                        self.led_handler.update("show_run_state", RUN_STATE.STOPPED.value)
                    else:
                        self.led_handler.update("show_run_state", RUN_STATE.OFF.value)
                    self.man_fire_enabled=False

                elif self.last_man_fire_state == HIGH and man_fire_state == LOW:
                    
                    print("Manual Fire Enabled. Schedule Stopped")
                    self.stop_schedule(False)
                    self.man_fire_enabled=True
                    self.led_handler.update("show_run_state",RUN_STATE.MANUAL_FIRE.value)

                # Arming switch logic
                if self.last_arming_state == LOW and arming_state == HIGH:
                    print("Arming switch deactivated. Disarming the system.")
                    self.stop_schedule()
                    self.is_armed=False
                    self.led_handler.update("arm_state", ARM_STATE.DISARMED.value)
                elif self.last_arming_state == HIGH and arming_state == LOW:
                    print("Arming switch activated. System is armed.")
                    if self.protocol_handler:
                        if self.protocol_handler.show_loaded:
                            self.led_handler.update("show_run_state", RUN_STATE.ARMED.value)
                    self.is_armed=True
                    self.led_handler.update("arm_state", ARM_STATE.ARMED.value)

                # Start/stop switch logic
                if arming_state == LOW:  # Only allow actions if the system is armed
                    if self.last_switch_state == HIGH and switch_state == LOW:
                        print("Start/stop switch transitioned from HIGH to LOW")
                        if not self.protocol_handler:
                            pass
                        else:
                            if self.protocol_handler.show_loaded:
                                print("Schedule found")
                                if(not self.man_fire_enabled):
                                    self.start_schedule()
                                else:
                                    self.write_error(f"Cannot start a show when manual fire is enabled. Hit Stop, disengage manual fire, then try again.")
                                    self.led_handler.update("error_state", ERR_STATE.DAEMON.value)
                            elif(self.man_fire_enabled):
                                self.led_handler.update("show_run_state",RUN_STATE.MANUAL_FIRE.value)
                            else:
                                self.write_error(f"Tried to start show but no show loaded and manual fire is off.")

                        self.start_sw_active=True
                    elif self.last_switch_state == LOW and switch_state == HIGH:
                        print("Start/stop switch transitioned from LOW to HIGH. Stopping schedule...")
                        if not self.protocol_handler:
                            pass
                        else:
                            self.protocol_handler.bounce()
                            self.waiting_for_client_start = False
            
                            if(self.running_show):
                                self.pause_schedule()
                            else:
                                if(not self.protocol_handler.show_loaded):
                                    print("Stopped, but not even a show loaded.. so nothing to do.")
                                    self.led_handler.update("show_run_state", RUN_STATE.OFF.value)
                                else:
                                    self.stop_schedule(False)
                                    self.led_handler.update("show_run_state", RUN_STATE.ARMED.value)

                        self.start_sw_active=False
                elif self.last_switch_state is not switch_state:
                    self.write_error("Start/Stop switch changed while system was not armed. This is not allowed.")

                self.last_switch_state = switch_state
                self.last_arming_state = arming_state
                self.last_man_fire_state = man_fire_state
                # The flusher will coalesce this with any other dirty
                # signal that arrived in the last debounce window.
                self.mark_state_dirty()
                time.sleep(0.1)  # Check every 100ms
            except Exception as e:
                print(f"Error monitoring switches: {e}")

    def poll_command_dir(self):
        """Poll the /tmp/d_cmd directory for command files."""
        while self.running:
            try:
                if not os.path.exists(COMMAND_DIR):
                    os.makedirs(COMMAND_DIR)

                for filename in os.listdir(COMMAND_DIR):
                    file_path = os.path.join(COMMAND_DIR, filename)
                    if os.path.isfile(file_path):
                        with open(file_path, 'r') as file:
                            command = json.load(file)
                            print(f"Loaded command from file: {command}")
                            self.handle_command(command)

                        os.remove(file_path)
                        print(f"Deleted command file: {file_path}")

            except Exception as e:
                print(f"Error polling command directory: {e}")

            self.mark_state_dirty()
            time.sleep(0.5)  # Poll every 500ms

    def write_error(self, err_msg):
        """Appends a line to a file with a timestamp prepended in square brackets."""
        try:
            # Get the current timestamp
            timestamp = datetime.now().strftime("[%Y-%m-%d %H:%M:%SZ]")
            
            # Prepend the timestamp to the line
            line_with_timestamp = f"{timestamp} {err_msg}"
            
            # Create the directory if it doesn't exist
            log_dir = os.path.dirname(ERR_LOG_PATH)
            if not os.path.exists(log_dir):
                os.makedirs(log_dir)
            
            # Append the line to the file
            with open(ERR_LOG_PATH, 'a') as file:  # Open the file in append mode
                file.write(line_with_timestamp + '\n')
            
            print(f"Wrote Error: {line_with_timestamp}")
        except Exception as e:
            print(f"Error appending to file: {e}")

    def switch_serial(self, addr, baud):
        self.serial_addr = addr
        self.serial_baud = baud
        self.setup_serial()

    def handle_manual_fire(self, zone, target):
        if(gpio_handler.read_key(ARMING_GPIO_KEY) != LOW):
            self.write_error(f"Cannot manually fire zone:{zone} target:{target} if arming switch is not on.")
        elif(self.last_switch_state != LOW):
            self.write_error(f"Cannot manually fire zone:{zone} target:{target}  if start switch is not on.")
        elif(self.last_man_fire_state != LOW):
            self.write_error(f"Cannot manually fire zone:{zone} target:{target} if system is not in manual fire mode.")
        else:
            self.protocol_handler.handle_manual_fire(zone, target)

    def handle_command(self, command):
        """Handle a single command."""
        if 'type' in command:
            if command['type'] == 'serial':
                self.send_serial_command(command.get('data', ''))
            elif command['type'] == 'manual_fire':
                cmddata = command.get('data', {})
                self.handle_manual_fire(cmddata['zone'], cmddata['target'])
            elif command['type'] == 'db_query':
                query = command.get('query', '')
                self.query_database(query)
            elif command['type'] == 'delegate_launch':
                self.delegate_start_to_client = command.get('do_it', False)
            elif command['type'] == 'start_show':
                if(self.delegate_start_to_client and self.waiting_for_client_start):
                    self.start_schedule(True)
            elif command['type'] == 'stop_show':
                if(self.delegate_start_to_client and not self.waiting_for_client_start):
                    self.stop_schedule(True)
            elif command['type'] == 'pause_show':
                if(self.delegate_start_to_client and not self.waiting_for_client_start):
                    self.led_handler.update("show_run_state", RUN_STATE.DELEGATE_WAIT.value)
                    self.waiting_for_client_start = True
                    self.pause_schedule(True)
            elif command['type'] == 'schedule':
                schedule = command.get('schedule', [])
                self.current_schedule = schedule
            elif command['type'] == 'stop_schedule':
                self.stop_schedule()
            elif command['type'] == 'load_show':
                show_id = command.get('id', None)
                if show_id is not None:
                    self.load_show(show_id)
                else:
                    print("Invalid load_show command: Missing 'id'.")
            elif command['type'] == 'unload_show':
                self.unload_show()
            elif command['type'] == 'select_serial':
                self.switch_serial(command.get('device'), int(command.get('baud')))
            elif command['type'] == 'set_brightness':
                brightness = int(command.get('brightness', 100))
                if(int(brightness)==0):
                    brightness=1
                self.led_brightness = brightness
                self.led_handler.update("led_brightness", int(brightness))
            elif command['type'] == 'set_receiver_timeout':
                self.led_handler.update("receiver_timeout_ms", int(command.get('timeout_ms', 30000)))
            elif command['type'] == 'set_command_response_timeout':
                self.led_handler.update("command_response_timeout_ms", int(command.get('timeout_ms', 100)))
            elif command['type'] == 'set_clock_sync_interval':
                self.led_handler.update("clock_sync_interval_ms", int(command.get('interval_ms', 2000)))
            elif command['type'] == 'set_debug_mode':
                self.led_handler.update("debug_mode", int(command.get('debug_mode', 0)))
                self.debug_mode = int(command.get('debug_mode', 0))
            elif command['type'] == 'set_fire_repeat':
                repeat_ct = int(command.get('repeat_ct', 6))
                if(repeat_ct==0):
                    repeat_ct=6
                self.fire_repetition = repeat_ct
            elif command['type'] == 'reload_receivers':
                # UI dropped this after editing the Receivers DB table.
                # Re-read from DB and reconcile the dongle's poll list.
                if self.protocol_handler and hasattr(self.protocol_handler, 'reload_receivers_from_db'):
                    if self.protocol_handler.show_loaded:
                        # Refuse silently — the UI already gates the unlock
                        # button on this, but a stray cmd file could still
                        # land here. Don't trash a loaded show.
                        print("Ignoring reload_receivers: a show is currently loaded.")
                    else:
                        try:
                            self.protocol_handler.reload_receivers_from_db()
                        except Exception as e:
                            self.write_error(f"reload_receivers failed: {e}")
                else:
                    print("reload_receivers: protocol handler not ready.")
            elif command['type'] == 'retry_receiver':
                ident = command.get('ident')
                if not ident:
                    print("retry_receiver: missing 'ident'.")
                elif self.protocol_handler and hasattr(self.protocol_handler, 'retry_receiver'):
                    try:
                        self.protocol_handler.retry_receiver(ident)
                    except Exception as e:
                        self.write_error(f"retry_receiver({ident}) failed: {e}")
                else:
                    print("retry_receiver: protocol handler not ready.")
            elif command['type'] == 'set_rf_channel':
                # Apply a new RF channel to the dongle. The dongle's
                # parseLedJSON path accepts `rf_channel` and calls
                # applyRfConfig() which hot-swaps without a reboot. We
                # refuse if a show is loaded or the system is armed —
                # mid-show channel changes would leave existing receivers
                # deaf until they're reflashed (no auto-discovery yet).
                try:
                    new_ch = int(command.get('channel', -1))
                except (TypeError, ValueError):
                    new_ch = -1
                if not (0 <= new_ch <= 125):
                    self.write_error(f"set_rf_channel refused: channel must be 0..125 (got {command.get('channel')!r}).")
                elif self.protocol_handler and self.protocol_handler.show_loaded:
                    self.write_error("set_rf_channel refused: a show is currently loaded. Unload first.")
                elif self.is_armed:
                    self.write_error("set_rf_channel refused: system is armed. Disarm first.")
                else:
                    self.send_serial_command(json.dumps({"rf_channel": new_ch}))
                    print(f"set_rf_channel: requested ch={new_ch}")
            elif command['type'] == 'ota_flash_start':
                # Operator-initiated OTA firmware flash for a single
                # receiver. The Next.js upload handler stages the .bin
                # file at `image_path` (typically under /tmp/ota_staging)
                # and drops this command. The protocol handler enforces
                # show-not-loaded / disarmed / receiver-online gating so
                # the dongle isn't monopolized at a bad time.
                ident = command.get('ident')
                image_path = command.get('image_path')
                rate = int(command.get('rate', 2))
                if not ident or not image_path:
                    self.write_error(
                        "ota_flash_start refused: missing ident or image_path"
                    )
                elif not (self.protocol_handler and hasattr(
                    self.protocol_handler, 'start_ota_flash'
                )):
                    self.write_error("ota_flash_start: protocol handler not ready.")
                else:
                    ok, msg = self.protocol_handler.start_ota_flash(
                        ident=ident, image_path=image_path, rate=rate
                    )
                    if not ok:
                        self.write_error(f"ota_flash_start: {msg}")
                    else:
                        print(f"ota_flash_start: queued ({msg})")
            elif command['type'] == 'ota_flash_abort':
                if not (self.protocol_handler and hasattr(
                    self.protocol_handler, 'abort_ota_flash'
                )):
                    print("ota_flash_abort: protocol handler not ready.")
                else:
                    ok, msg = self.protocol_handler.abort_ota_flash()
                    if not ok:
                        self.write_error(f"ota_flash_abort: {msg}")
            elif command['type'] == 'scan_radio':
                # Operator-initiated RF spectrum scan. We refuse if a show
                # is loaded or the system is armed because the dongle blocks
                # all polling for ~250ms-1s during the sweep, and we don't
                # want any ambiguity around radio silence vs. real-time
                # firing reliability. The UI gates on the same flags.
                if not (self.protocol_handler and hasattr(self.protocol_handler, 'start_rf_scan')):
                    print("scan_radio: protocol handler not ready.")
                elif self.protocol_handler.show_loaded:
                    self.write_error("scan_radio refused: a show is currently loaded. Unload first.")
                elif self.is_armed:
                    self.write_error("scan_radio refused: system is armed. Disarm first.")
                else:
                    try:
                        passes  = int(command.get('passes', 10))
                        ch_start = int(command.get('ch_start', 0))
                        ch_end   = int(command.get('ch_end', 125))
                        self.protocol_handler.start_rf_scan(
                            passes=passes, ch_start=ch_start, ch_end=ch_end
                        )
                    except Exception as e:
                        self.write_error(f"scan_radio failed: {e}")
            else:
                print(f"Unknown command type: {command['type']}")
        else:
            print("Invalid command format.")

    def assign_handler_class(self, token_line):
        handler_cls = get_handler_cls_for_msg(token_line)
        if(handler_cls):
            self.protocol_handler = handler_cls(self)
        else:
            print("Cannot identify protocol handler class")


    def query_database(self, query):
        """Execute a query on the SQLite database."""
        try:
            with sqlite3.connect(DB_PATH) as conn:
                cursor = conn.cursor()
                cursor.execute(query)
                results = cursor.fetchall()
                print(f"Query results: {results}")
                return results
        except Exception as e:
            print(f"Error querying database: {e}")

    def write_time_cursor(self, tc):
        self.time_cursor = tc
        with open(CURSOR_FILE, "w") as f:
            f.write(f"{tc:.6f}")

    def refresh_check_errors(self):
        errors = []
        if(not self.is_armed):
            errors.append("System is not armed. Re-arm, then reload the show.")
        if(self.delegate_start_to_client and self.waiting_for_client_start):
            errors.append("System is in delegated mode and is waiting on the green START button on the box to be pressed")
        if(not (self.last_serial_received is not None and (datetime.now() - self.last_serial_received).total_seconds() <= 10)):
            errors.append("System has not heard from TX device in 10 seconds. Figure that out.")

        self.fire_check_failures = errors + self.protocol_handler.get_fc_failures()


    def unload_show(self):
        print("Unloading show")
        self.led_handler.update("show_load_state",RUN_STATE.OFF.value)
        if(self.protocol_handler):
            self.protocol_handler.unload_show()
        self.current_schedule = None
        self.loaded_show_name = None
        self.loaded_show_id = None
        self.write_time_cursor(-1)
        
    def signal_show_loaded(self, show_id):
        self.loaded_show_id = show_id
        self.led_handler.update("show_load_state", LOAD_STATE.LOADED.value)
        self.write_time_cursor(0)

    def load_show(self, show_id):
        """Load a show from the database, process it, and save the runtime payload."""
        self.led_handler.update("show_load_state", LOAD_STATE.LOADING.value)
        self.led_handler.update("error_state", ERR_STATE.OFF.value)
        time.sleep(1)
        if(not self.protocol_handler):
            self.write_error("Cannot load a show as there is no available protocol to run")
            self.led_handler.update("show_load_state", LOAD_STATE.LOAD_ERROR.value)
            return

        if(self.start_sw_active):
            self.write_error("Cannot load a show when the START button is active. Hit STOP on the box.")
            self.led_handler.update("show_load_state", LOAD_STATE.LOAD_ERROR.value)
            return
        try:
            with sqlite3.connect(DB_PATH) as conn:
                cursor = conn.cursor()

                # Fetch the show data
                cursor.execute("SELECT name, display_payload, protocol FROM Show WHERE id = ?", (show_id,))
                row = cursor.fetchone()

                if row is None:
                    self.write_error(f"No show found with ID {show_id}.")
                    self.led_handler.update("show_load_state", LOAD_STATE.LOAD_ERROR.value)
                    return

                if not row[2] == self.protocol_handler.protocol:
                    self.write_error(f"Protocol {row[2]} for show does not match loaded protocol {self.protocol_handler.protocol}")
                    self.led_handler.update("show_load_state", LOAD_STATE.LOAD_ERROR.value)
                    return

                display_payload = json.loads(row[1])
                firing_array = self.process_display_payload(display_payload)
                
                # Save the processed firing array back to the database
                cursor.execute(
                    "UPDATE Show SET runtime_payload = ? WHERE id = ?",
                    (json.dumps(firing_array), show_id)
                )
                conn.commit()
                
                if(self.protocol_handler.load_show(firing_array, show_id)):
                    self.led_handler.update("show_load_state", LOAD_STATE.LOADED.value)
                    print(f"Show ID {show_id} loaded and processed.")
                    self.loaded_show_name = row[0]
                    self.loaded_show_id = show_id
                    self.write_time_cursor(0)
                    # Set the schedule but don't start it yet
                    self.current_schedule = firing_array
                    if(self.is_armed):
                        print("SRS ARM")
                        self.led_handler.update("show_run_state", RUN_STATE.ARMED.value)
                    self.refresh_check_errors()
                else:
                    if(self.protocol_handler.load_waiting):
                        print("Waiting on load success")
                    else:
                        print(f"Error loading show ID {show_id}")
                        self.led_handler.update("show_load_state", LOAD_STATE.LOAD_ERROR.value)

        except Exception as e:
            print(f"Error loading show ID {show_id}: {e}")
            self.led_handler.update("show_load_state", LOAD_STATE.LOAD_ERROR.value)


    def process_display_payload(self, display_payload):
        """Convert the display payload to the firing array used by the schedule.

        Items missing ``startTime`` (or other required keys) are skipped and
        logged rather than discarding the entire show, which used to silently
        produce a no-op load if a single item was malformed.
        """
        firing_array = []
        skipped = []

        for item in display_payload:
            item_id = item.get('id', '<no-id>')
            if 'startTime' not in item:
                skipped.append((item_id, "missing startTime"))
                continue
            try:
                firing_array.append({
                    'startTime': item['startTime'] - item['delay'],
                    'zone': item['zone'],
                    'target': item['target'],
                    'id': item['id'],
                })
            except KeyError as ke:
                skipped.append((item_id, f"missing key {ke}"))
                continue

        if skipped:
            for item_id, reason in skipped:
                msg = f"Skipping show item {item_id}: {reason}"
                print(f"WARN: {msg}")
                self.write_error(msg)

        firing_array.sort(key=lambda x: x['startTime'])  # Ensure sorted by time
        return firing_array

    def start_schedule(self, from_delegate=False):
        """Start a timed schedule based on an array of commands."""
        self.led_handler.update("error_state", ERR_STATE.OFF.value)
        if(from_delegate):
            self.waiting_for_client_start = False

        self.refresh_check_errors()

        if not self.protocol_handler.show_loaded:
            self.write_error("No show is loaded. Cannot start.")

        if self.protocol_handler.running_show:
            print("A show is already running. Cannot start another.")
            self.write_error(f"A show is already running. Cannot start another.")
            return

        if self.delegate_start_to_client and not from_delegate:
            print("Delegating show control to client. Waiting")
            self.led_handler.update("show_run_state", RUN_STATE.DELEGATE_WAIT.value)
            self.waiting_for_client_start = True
            return

        if not len(self.fire_check_failures) == 0:
            self.write_error(f"Cannot start schedule when there are pre-fire check failures. Fix them and reload")
            return

        print("Running show")

        # Drop any threads that have already finished so the list doesn't
        # grow without bound across runs.
        self.command_timer_threads = [
            t for t in self.command_timer_threads if t.is_alive()
        ]

        thread = threading.Thread(target=self.protocol_handler.run_show, daemon=True)
        thread.start()
        self.command_timer_threads.append(thread)

    def pause_schedule(self, from_delegate=False):
        """Pause all running schedules."""
        print("Pausing schedule...")
        if(self.dstc):
            self.led_handler.update("show_run_state", RUN_STATE.DELEGATE_WAIT.value)
            self.waiting_for_client_start = True
        else:
            self.led_handler.update("show_run_state", RUN_STATE.PAUSED.value)
        if(self.protocol_handler):
            self.protocol_handler.schedule_pause_event.set()  # Signal all schedules to pause

    def stop_schedule(self, update_led=True):
        """Stop all running schedules."""
        print("Stopping all schedules...")
        if(self.protocol_handler):
            self.protocol_handler.schedule_stop_event.set()  # Signal all schedules to stop

        # Wait for all schedule threads to terminate, but never block the
        # operator's stop indefinitely if a thread is wedged.
        STOP_JOIN_TIMEOUT_SEC = 5.0
        for thread in self.command_timer_threads:
            thread.join(timeout=STOP_JOIN_TIMEOUT_SEC)
            if thread.is_alive():
                print(
                    f"WARN: schedule thread {thread.name} did not terminate within "
                    f"{STOP_JOIN_TIMEOUT_SEC:.1f}s; abandoning."
                )
        if(update_led):
            self.led_handler.update("show_run_state",RUN_STATE.STOPPED.value)

        # Drop dead threads but keep any wedged ones around so we don't lose
        # the reference (their daemon=True flag will let the process exit).
        self.command_timer_threads = [
            t for t in self.command_timer_threads if t.is_alive()
        ]
        self.is_running = False
        print("All schedules stopped.")

    def update_state_file(self):
        """Update the state file with the current daemon state."""
        state = {
            "device_running": self.last_serial_received is not None and (datetime.now() - self.last_serial_received).total_seconds() <= 10,
            "device_found": self.serial_connection is not None,
            "device_address": SERIAL_PORT,
            "daemon_lup": int(datetime.now().timestamp() * 1000),
            "show_loaded": self.protocol_handler is not None and self.protocol_handler.show_loaded,
            "loaded_show_name": self.loaded_show_name,
            "loaded_show_id": self.loaded_show_id,
            "show_running": any(thread.is_alive() for thread in self.command_timer_threads),
            "device_is_transmitting": self.last_serial_sent is not None and (datetime.now() - self.last_serial_sent).total_seconds() <= 10,
            # Dongle command-queue saturation, fed from the per-second
            # status frame. `capacity` is None until a v8+ dongle reports
            # `qmax` -- older firmware just keeps `depth` and the UI hides
            # the saturation bar. Surfaced as a top-level block (not under
            # settings) since it's runtime telemetry, not a knob.
            "dongle_cmd_queue": {
                "depth": self.dongle_cmd_queue_depth,
                "capacity": self.dongle_cmd_queue_capacity,
            },
            # Active clock-sync interval the dongle is running with
            # (post-clamp). None until a FW v9+ dongle reports `csim`.
            # Lets the UI show the operator the value the firmware
            # actually accepted, e.g. when their config request was
            # out-of-range and got bounded.
            "dongle_clock_sync_interval_ms": self.dongle_clock_sync_interval_ms,
            "device_is_armed": gpio_handler.read_key(ARMING_GPIO_KEY) == LOW,
            "manual_fire_active": gpio_handler.read_key(MAN_FIRE_GPIO_KEY) == LOW,
            "start_sw_active": self.start_sw_active,
            "fire_check_failures": self.fire_check_failures,
            "proto_handler_errors": self.protocol_handler is not None and self.protocol_handler.errors,
            "proto_handler_status": self.protocol_handler is not None and self.protocol_handler.status.name,
            "active_protocol": self.protocol_handler is not None and self.protocol_handler.protocol,
            "dstc": self.delegate_start_to_client,
            "sst": self.protocol_handler is not None and self.protocol_handler.show_start_time,
            "receivers": self.protocol_handler is not None and self.protocol_handler.receivers,
            "waiting_for_client_start": self.waiting_for_client_start,
            # OTA flash mode state (None when no job has ever run).
            # Mirrors the OtaState snapshot from OtaFlashDriver so the
            # UI can render a progress bar without a separate fetch.
            "ota": (
                self.protocol_handler.get_ota_state()
                if self.protocol_handler is not None
                and hasattr(self.protocol_handler, 'get_ota_state')
                else None
            ),
            "settings": {
                "led_brightness": self.led_brightness,
                "fire_repeat_ct": self.fire_repetition,
                "receiver_timeout_ms": self.led_handler.led_states.get("receiver_timeout_ms", 30000),
                "command_response_timeout_ms": self.led_handler.led_states.get("command_response_timeout_ms", 100),
                "clock_sync_interval_ms": self.led_handler.led_states.get("clock_sync_interval_ms", 2000),
                "debug_mode": self.led_handler.led_states.get("debug_mode", 0),
                "rf": {
                    "addr": self.serial_addr,
                    "baud": self.serial_baud,
                    # Live channel from the dongle's per-second status.
                    # None until the first dongle status arrives.
                    "current_channel": self.current_rf_channel,
                    # Truthy while a scan is in flight (used for UI
                    # spinner). Cleared by the scan_result handler.
                    "scan_pending_since_ms": self.rf_scan_pending_since_ms,
                    # Compact last-scan summary; the full per-channel
                    # bins live in /data/last_scan.json.
                    "last_scan": self.last_rf_scan_summary,
                }
            }
        }
        # Atomic write: serialize to a sibling tempfile in the same directory,
        # then os.replace() it over the real path. POSIX rename(2) is atomic,
        # so any reader (WS server, UI HTTP handlers, ...) sees either the
        # previous complete file or the new one — never the empty/partial
        # intermediate state that `open(path, "w")` produces between truncate
        # and write.
        #
        # We use mkstemp() to get a UNIQUE tmp path because two threads call
        # this method (monitor_switch every 100ms + poll_command_dir after
        # each command). A shared tmp path causes the loser of the
        # truncate-then-replace race to see ENOENT on os.replace(). Per-call
        # unique tmp files let both writers finish independently; whichever
        # replace() runs last just wins as the published snapshot, which is
        # exactly what we want.
        # Render once. We push the same bytes both to disk (for legacy
        # readers and the WS server's inotify fallback) and to the unix
        # datagram socket (for sub-millisecond delivery to the WS server
        # when it's bound).
        try:
            state_bytes = json.dumps(state, indent=4).encode("utf-8")
        except Exception as e:
            print(f"Error serializing daemon state: {e}")
            return

        # Best-effort push to the in-process WS subscriber FIRST. This
        # gives the lowest-latency path priority; the file write is the
        # robust fallback. Order matters because the file write does
        # disk I/O which can take milliseconds on a busy SD card.
        self._publish_state_to_socket(state_bytes)

        # Atomic file publish for any out-of-process reader and for the
        # WS server's inotify fallback. We deliberately do NOT fsync()
        # here -- the state file is regenerated state, not durable data,
        # and fsync on SD-card-backed filesystems is the dominant cost
        # of this function (5-50ms per call under contention).
        state_dir = os.path.dirname(STATE_FILE_PATH) or "."
        tmp_fd = None
        tmp_path = None
        try:
            tmp_fd, tmp_path = tempfile.mkstemp(
                prefix=".state.", suffix=".tmp", dir=state_dir
            )
            with os.fdopen(tmp_fd, "wb") as state_file:
                tmp_fd = None  # ownership passed to the file object
                state_file.write(state_bytes)
                # No fsync: we publish via os.replace below, which is
                # atomic on POSIX, and the data is regenerated each tick.
            os.replace(tmp_path, STATE_FILE_PATH)
            tmp_path = None  # successfully published, nothing to clean up
        except Exception as e:
            print(f"Error updating state file: {e}")
        finally:
            # If anything went wrong before/after the replace, make sure we
            # don't leak the tempfile.
            if tmp_fd is not None:
                try:
                    os.close(tmp_fd)
                except Exception:
                    pass
            if tmp_path is not None and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

    def stop(self):
        """Stop the daemon."""
        self.running = False
        # Wake the flusher if it's parked on the dirty event so it can
        # exit cleanly instead of waiting out its 1s heartbeat timeout.
        try:
            self._state_dirty.set()
        except Exception:
            pass
        if self._state_pub_sock is not None:
            try:
                self._state_pub_sock.close()
            except Exception:
                pass
        if self.serial_connection:
            self.serial_connection.close()
        #GPIO.cleanup()  # Clean up GPIO resources
        print("Daemon stopped.")

    def run(self):
        """Run the daemon."""
        self.setup_serial()
        self.setup_gpio()
        self.setup_settings()

        threads = [
            threading.Thread(target=self.poll_command_dir),
            threading.Thread(target=self.read_from_tcp),
            #threading.Thread(target=self.listen_serial),
            threading.Thread(target=self.monitor_switch),
            # The state flusher coalesces state-dirty signals into
            # snapshot writes (file + unix-socket push). It replaces the
            # ad-hoc per-tick update_state_file() calls that used to live
            # in monitor_switch/poll_command_dir and adds an immediate
            # path for dongle status updates.
            threading.Thread(target=self.state_flusher, daemon=True),
        ]

        for thread in threads:
            thread.start()

        try:
            while self.running:
                time.sleep(0.1)
        except KeyboardInterrupt:
            print("Daemon interrupted.")
            self.stop()

        # Wait for all threads to finish
        for thread in threads:
            thread.join()

        # Wait for timer threads to finish
        for timer_thread in self.command_timer_threads:
            timer_thread.join()


if __name__ == "__main__":
    daemon = FireworkDaemon()
    print("Waiting 10 seconds to start.. just to give everyone time to take their places.")
    time.sleep(5)
    daemon.run()
