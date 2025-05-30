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
    """Forward data from serial to TCP client"""
    global serial_conn
    
    try:
        while True:
            if serial_conn and serial_conn.is_open:
                with serial_lock:
                    data = serial_conn.read(8192)
                if data:
                    client.sendall(data)
            else:
                time.sleep(0.05)  # Don't busy-wait if serial is disconnected
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
                with serial_lock:
                    print(f"Write to conn '{buffer}'")
                    serial_conn.write(buffer)
                buffer = b''
            else:
                # Can't send now, keep in buffer
                pass
                
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