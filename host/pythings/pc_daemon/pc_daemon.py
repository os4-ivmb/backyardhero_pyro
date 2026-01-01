import os
import time
import serial
import sqlite3
import threading
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
            "led_brightness": 10,
            "receiver_timeout_ms": 30000,
            "command_response_timeout_ms": 100,
            "clock_sync_interval_ms": 2000,  # Dongle syncs receivers at this interval
            "dongle_sync_interval_ms": 60000,  # Python daemon syncs dongle at this interval (default 10s)
            "config_query_interval_ms": 120000,  # Default 1 minute
            "debug_mode": 0,
            "debug_commands": 0
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
        self.tcp_buffer_time = None  # Timestamp when buffer was last updated
        self.receiver_timeout_ms = 30000
        self.command_response_timeout_ms = 100
        self.clock_sync_interval_ms = 2000
        self.debug_mode = 0

        self.led_handler = LEDHandler(self)

        self.load_config()
        
        self.clear_states()

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
                # Clear stale buffer if it's been more than 2 seconds
                if self.tcp_buffer and self.tcp_buffer_time:
                    if time.time() - self.tcp_buffer_time > 2.0:
                        if(self.debug_enabled()):
                            print(f"Clearing stale TCP buffer (timeout): '{self.tcp_buffer[:100]}...'")
                        self.tcp_buffer = ""
                        self.tcp_buffer_time = None
                
                if hasattr(self, 'tcp_socket') and self.tcp_socket:
                    readable, _, _ = select.select([self.tcp_socket], [], [], 0.5)
                    data = None
                    if readable:
                        data = self.tcp_socket.recv(4096)
                    if data:
                        # Process each line like in listen_serial
                        lines = data.decode('utf-8', errors='replace').splitlines()
                        for line in lines:
                            if line:
                                if DEBUG:
                                    print(line)
                                bypass=False
                                
                                # Handle fragmented JSON: if line starts with '{' but doesn't end with '}', buffer it
                                if line[0] == '{' and not line.rstrip().endswith('}'):
                                    # Incomplete JSON - add to buffer
                                    self.tcp_buffer = (self.tcp_buffer or "") + line
                                    self.tcp_buffer_time = time.time()
                                    if(self.debug_enabled()):
                                        print(f"Buffering incomplete JSON fragment: '{line[:50]}...'")
                                    continue
                                
                                # If we have a buffer, append this line to it
                                if self.tcp_buffer:
                                    line = self.tcp_buffer + line
                                    self.tcp_buffer = ""  # Clear buffer after reassembly
                                    self.tcp_buffer_time = None
                                    if(self.debug_enabled()):
                                        print(f"Reassembled JSON from buffer: '{line[:100]}...'")
                                
                                # Now try to parse JSON
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

                                    except json.JSONDecodeError as e:
                                        # JSON parse failed - might be incomplete, try buffering
                                        if not line.rstrip().endswith('}'):
                                            # Doesn't end with '}', likely incomplete - buffer it
                                            self.tcp_buffer = line
                                            self.tcp_buffer_time = time.time()
                                            if(self.debug_enabled()):
                                                print(f"JSON parse failed, buffering incomplete JSON: '{line[:50]}...'")
                                            continue
                                        else:
                                            # Ends with '}' but still failed - malformed JSON, log and skip
                                            if(self.debug_enabled()):
                                                print(f"Bad JSON status (malformed): {e}")
                                                print(f"Line was: '{line[:200]}...'")
                                            # Clear buffer if it exists (might be stale)
                                            self.tcp_buffer = ""
                                            self.tcp_buffer_time = None
                                            continue
                                
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

        while not self.protocol_handler:
            pass

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
                elif self.last_arming_state == HIGH and arming_state == LOW:
                    print("Arming switch activated. System is armed.")
                    if self.protocol_handler:
                        if self.protocol_handler.show_loaded:
                            self.led_handler.update("show_run_state", RUN_STATE.ARMED.value)
                    self.is_armed=True

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
                self.update_state_file()
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

            self.update_state_file()
            
            # Periodically call protocol handler bounce (which handles config queries)
            if self.protocol_handler:
                self.protocol_handler.bounce()
            
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
            elif command['type'] == 'set_dongle_sync_interval':
                self.led_handler.update("dongle_sync_interval_ms", int(command.get('interval_ms', 20000)))
            elif command['type'] == 'set_config_query_interval':
                self.led_handler.update("config_query_interval_ms", int(command.get('interval_ms', 120000)))
            elif command['type'] == 'set_debug_mode':
                self.led_handler.update("debug_mode", int(command.get('debug_mode', 0)))
                self.debug_mode = int(command.get('debug_mode', 0))
            elif command['type'] == 'set_debug_commands':
                self.led_handler.update("debug_commands", int(command.get('debug_commands', 0)))
            elif command['type'] == 'set_fire_repeat':
                repeat_ct = int(command.get('repeat_ct', 6))
                if(repeat_ct==0):
                    repeat_ct=6
                self.fire_repetition = repeat_ct
            elif command['type'] == 'set_receiver_settings':
                # Set receiver settings: fire_ms_duration, status_interval, tx_power
                receiver_ident = command.get('receiver_ident')
                fire_ms_duration = command.get('fire_ms_duration')
                status_interval = command.get('status_interval')
                tx_power = command.get('tx_power')
                
                if receiver_ident and self.protocol_handler:
                    self.protocol_handler.query_receiver_config(
                        receiver_ident,
                        fire_ms_duration=fire_ms_duration,
                        status_interval=status_interval,
                        tx_power=tx_power
                    )
                else:
                    print(f"Invalid receiver settings command: missing receiver_ident or protocol_handler")
            elif command['type'] == 'query_all_receiver_configs':
                # Query config for all connected receivers
                if self.protocol_handler:
                    self.protocol_handler.query_all_receiver_configs()
                else:
                    print(f"Invalid query_all_receiver_configs command: protocol_handler not available")
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
        """Convert the display payload to the firing array used by the schedule."""
        firing_array = []

        for item in display_payload:
            if 'startTime' in item:
                firing_array.append({
                    'startTime': item['startTime'] - item['delay'],
                    'zone': item['zone'],
                    'target': item['target'],
                    'id': item['id']
                })
            else:
                print(f"WARN: item {item['id']} does not have a startTime key. This is dangerous. returning []")
                return []

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

        thread = threading.Thread(target=self.protocol_handler.run_show)
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

        # Wait for all schedule threads to terminate
        for thread in self.command_timer_threads:
            thread.join()
        if(update_led):
            self.led_handler.update("show_run_state",RUN_STATE.STOPPED.value)

        self.command_timer_threads = []  # Clear the list of threads
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
            "settings": {
                "led_brightness": self.led_brightness,
                "fire_repeat_ct": self.fire_repetition,
                "receiver_timeout_ms": self.led_handler.led_states.get("receiver_timeout_ms", 30000),
                "command_response_timeout_ms": self.led_handler.led_states.get("command_response_timeout_ms", 100),
                "clock_sync_interval_ms": self.led_handler.led_states.get("clock_sync_interval_ms", 2000),
                "dongle_sync_interval_ms": self.led_handler.led_states.get("dongle_sync_interval_ms", 10000),
                "config_query_interval_ms": self.led_handler.led_states.get("config_query_interval_ms", 60000),
                "debug_mode": self.led_handler.led_states.get("debug_mode", 0),
                "debug_commands": self.led_handler.led_states.get("debug_commands", 0),
                "rf": {
                    "addr": self.serial_addr,
                    "baud": self.serial_baud
                }
            }
        }
        try:
            with open(STATE_FILE_PATH, "w") as state_file:
                json.dump(state, state_file, indent=4)
        except Exception as e:
            print(f"Error updating state file: {e}")

    def stop(self):
        """Stop the daemon."""
        self.running = False
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
