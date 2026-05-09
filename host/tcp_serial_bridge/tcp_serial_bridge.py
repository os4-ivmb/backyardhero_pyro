import serial
import socket
import threading
import time
import json

# Default configuration
SERIAL_CONFIG = {
    'port': '/dev/tty.usbmodem01',
    'baud': 115200
}
TCP_HOST = '0.0.0.0'
TCP_PORT = 9000

# Global serial connection
serial_conn = None
serial_lock = threading.Lock()

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

def _try_auto_reopen():
    """Attempt to re-open the serial port using the last-known config.

    Throttled so we don't spin in a tight loop while the dongle is
    physically gone. Safe to call from either the read or write thread;
    the serial_lock + idempotent close serialize concurrent calls.
    """
    global serial_conn, _last_reconnect_attempt, _consecutive_failures

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
    """Reconnect to the serial port with current settings"""
    global serial_conn
    
    with serial_lock:
        # Close existing connection if open
        if serial_conn:
            try:
                serial_conn.close()
            except:
                pass
                
        # Try to open new connection
        try:
            serial_conn = serial.Serial(
                SERIAL_CONFIG['port'], 
                SERIAL_CONFIG['baud'], 
                timeout=1
            )
            print(f"Serial connected: {SERIAL_CONFIG['port']} at {SERIAL_CONFIG['baud']} baud")
            return True
        except Exception as e:
            print(f"Serial connection error: {e}")
            if(client_socket):
                response = {
                    'type': 'config_response',
                    'error': str(e)
                }
                client_socket.sendall((json.dumps(response) + '\n').encode('utf-8'))
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
    try:
        while True:
            if not (serial_conn and serial_conn.is_open):
                # Try to auto-reopen instead of just waiting passively
                # for a config_serial command to revive us. The dongle
                # may have rebooted (WDT, panic, operator replug) and
                # we want to be back online as soon as it re-enumerates.
                _try_auto_reopen()
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
                time.sleep(0.05)
                continue

            if data:
                try:
                    client.sendall(data)
                except OSError as e:
                    print(f"serial_to_tcp: client gone: {e}")
                    return
            else:
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
            
            # Check if this might be a command (JSON objects start with '{')
            if buffer.startswith(b'{'):
                # Try to process as command
                if process_command(buffer, client):
                    buffer = b''  # Command processed, clear buffer
                    continue
            
            # Not a command or command processing failed, send to serial
            if serial_conn and serial_conn.is_open:
                try:
                    with serial_lock:
                        if serial_conn and serial_conn.is_open:
                            serial_conn.write(buffer)
                        else:
                            # Race: closed by serial_to_tcp between
                            # the outer check and lock acquisition.
                            raise serial.SerialException("closed mid-write")
                    buffer = b''
                except (OSError, serial.SerialException) as e:
                    # Dongle disappeared between checks. Drop this
                    # outbound buffer (host will retry the OTA chunk
                    # via timeout) and let serial_to_tcp's auto-
                    # reconnect bring the link back.
                    print(f"tcp_to_serial: write error ({e}); "
                          f"dropping {len(buffer)}B and continuing")
                    with serial_lock:
                        if serial_conn:
                            try:
                                serial_conn.close()
                            except Exception:
                                pass
                            serial_conn = None
                    buffer = b''
            else:
                # Can't send now -- drop the buffer rather than letting
                # it grow unbounded while the dongle is offline. Host-
                # side OTA retry will resend whatever we lose.
                if buffer:
                    print(f"tcp_to_serial: serial offline, "
                          f"dropping {len(buffer)}B")
                    buffer = b''
                
    except Exception as e:
        print(f"Error in tcp_to_serial: {e}")

def handle_client(client_socket):
    """Handle a client connection"""
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

if __name__ == '__main__':
    # Establish initial serial connection
    reconnect_serial(False)
    
    # Start TCP server
    start_tcp_server()