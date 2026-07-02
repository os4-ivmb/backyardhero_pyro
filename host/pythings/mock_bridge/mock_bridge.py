"""Mock TCP-to-serial bridge for the dev container (no physical dongle).

The real bridge (host/tcp_serial_bridge/tcp_serial_bridge.py) is host-native:
it owns the dongle's USB-CDC port and relays it over TCP :9000. In the dev
container there is no dongle and nobody starts that host-side process, so the
firework-daemon's connect to `host.docker.internal:9000` fails forever with
`[Errno 111] Connection refused` (retried on a 5s backoff, spamming
data/log/daemon.err and pinning the UI's dongle status at DEVICE_ERROR).

This stand-in speaks just enough of the daemon<->bridge wire protocol to make
the daemon report a healthy, CONNECTED dongle so the app is fully usable for
development without hardware:

  * Listens on the same TCP host/port the daemon dials (127.0.0.1:9000 in the
    container -- the daemon is pointed here via BYH_BRIDGE_HOST=127.0.0.1).
  * Accepts the daemon's `config_serial` handshake and acks it exactly like
    the real bridge: {"tcpstatus": true, "serial_config": {...}}. That ack is
    what makes the daemon build its BYHProtocolHandler and go CONNECTED.
  * Emits a ~1Hz dongle `status` heartbeat ({"type":"status", ...}) so the
    daemon's "haven't heard from TX in 10s" watchdog stays satisfied and
    bad_serial_ct never climbs toward DEVICE_ERROR.
  * Emits a stable switch-state (gpio) frame so the UI shows a defined
    arm/start/manual-fire posture. Defaults to a clean IDLE box (all switches
    disengaged); engage them from the UI's GPIO override panel, or preset them
    here with the MOCK_ARMED / MOCK_START / MOCK_MANFIRE env vars below.
  * Swallows every outbound serial command (msync, sync/register, 433fire,
    ...) like a dongle with no receivers -- so firing "succeeds" on the wire
    but nothing physically fires.

It has NO third-party dependencies (stdlib socket/json/threading/time only),
so it runs under the container's plain python3 with no venv. It is wired into
supervisord.devcontainer.conf ONLY -- production (supervisord.conf) and the
plain dev profile (supervisord.dev.conf) never run it and always talk to the
real host-side bridge.

Env config (all optional):
  BYH_BRIDGE_BIND        bind address           (default 127.0.0.1)
  BYH_BRIDGE_PORT        listen port            (default 9000)
  MOCK_DONGLE_FW         reported dongle fw ver  (default 16)
  MOCK_RF_CHANNEL        reported RF channel     (default 1)
  MOCK_STATUS_INTERVAL_S heartbeat period sec    (default 1.0)
  MOCK_ARMED             arming switch engaged   (default 0 -> disarmed)
  MOCK_START             start switch engaged    (default 0 -> off)
  MOCK_MANFIRE           manual-fire engaged     (default 0 -> off)
  MOCK_DEBUG             log inbound commands     (default 0)
"""

import json
import os
import socket
import threading
import time

BIND_HOST = os.environ.get("BYH_BRIDGE_BIND", "127.0.0.1")
BIND_PORT = int(os.environ.get("BYH_BRIDGE_PORT", "9000"))

DONGLE_FW = int(os.environ.get("MOCK_DONGLE_FW", "16"))
RF_CHANNEL = int(os.environ.get("MOCK_RF_CHANNEL", "1"))
STATUS_INTERVAL_S = float(os.environ.get("MOCK_STATUS_INTERVAL_S", "1.0"))
DEBUG = os.environ.get("MOCK_DEBUG", "0") not in ("0", "", "false", "False")

# The three physical switches are active-low (INPUT_PULLUP): engaged == LOW(0),
# released == HIGH(1). See GPIOHandler in pc_daemon.py. We take human-facing
# "engaged" booleans from the env and translate to the level the daemon's gpio
# branch stores verbatim.
LOW, HIGH = 0, 1


def _engaged(env_name):
    """True if the env var asks for an ENGAGED switch (1/true/on)."""
    return os.environ.get(env_name, "0").strip().lower() in ("1", "true", "on", "yes")


def _level(env_name):
    return LOW if _engaged(env_name) else HIGH


def _now_ms():
    return int(time.time() * 1000)


class MockBridge:
    def __init__(self, conn, addr):
        self.conn = conn
        self.addr = addr
        self.running = True
        # Serialize sends: the reader (config acks) and the heartbeat writer
        # both sendall() on this socket. A lock keeps whole newline-delimited
        # messages from interleaving on the wire.
        self._send_lock = threading.Lock()

    def _send(self, obj):
        line = (json.dumps(obj) + "\n").encode("utf-8")
        with self._send_lock:
            self.conn.sendall(line)

    def _handle_line(self, line):
        """Process one newline-stripped line from the daemon."""
        stripped = line.lstrip()
        if stripped.startswith(b"{"):
            try:
                cmd = json.loads(stripped.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return  # not JSON we understand; ignore like the real bridge
            ctype = cmd.get("type")
            if ctype == "config_serial":
                # Ack the (re)configure exactly like the real bridge's
                # process_command success path. This is what flips the daemon
                # to CONNECTED and (re)builds its protocol handler.
                self._send({
                    "tcpstatus": True,
                    "serial_config": {
                        "port": cmd.get("port", "/dev/ttyMOCK0"),
                        "baud": int(cmd.get("baud", 115200)),
                    },
                })
                if DEBUG:
                    print(f"[mock-bridge] config_serial -> acked ({cmd.get('port')})")
            elif ctype == "get_status":
                self._send({
                    "type": "status_response",
                    "connected": True,
                    "config": {"port": "/dev/ttyMOCK0", "baud": 115200},
                })
            # Any other JSON control message: silently ignore.
            return

        # Otherwise it's a serial command destined for the dongle (msync,
        # sync/register, 433fire, forget, ...). A real dongle with no
        # receivers would accept it and (mostly) stay quiet, so we drop it.
        if DEBUG:
            try:
                print(f"[mock-bridge] serial<- {line.decode('utf-8', 'replace').strip()}")
            except Exception:
                pass

    def reader_loop(self):
        buffer = b""
        try:
            while self.running:
                data = self.conn.recv(2048)
                if not data:
                    break  # daemon disconnected
                buffer += data
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    if raw:
                        self._handle_line(raw)
        except OSError as e:
            if DEBUG:
                print(f"[mock-bridge] reader socket closed: {e}")
        finally:
            self.running = False

    def heartbeat_loop(self):
        """Emit a dongle status frame (+ a stable switch-state frame) every
        STATUS_INTERVAL_S, mimicking the dongle's ~1Hz heartbeat."""
        # Send the switch state once up front so the daemon's monitor_switch
        # starts from a defined posture, then repeat it each tick so a late
        # daemon connect still learns it.
        gpio_frame = {
            "gpio": 1,
            "armed": _level("MOCK_ARMED"),
            "start_stop": _level("MOCK_START"),
            "man_fire": _level("MOCK_MANFIRE"),
        }
        try:
            while self.running:
                # Switch state (drives arm/start/manfire in the UI + daemon).
                self._send(gpio_frame)
                # Dongle heartbeat. `receivers` is empty -- no RF hardware.
                self._send({
                    "type": "status",
                    "timestamp": _now_ms(),
                    "fw": DONGLE_FW,
                    "ch": RF_CHANNEL,
                    "q": 0,
                    "qmax": 32,
                    "csim": 1000,
                    "receivers": [],
                })
                time.sleep(STATUS_INTERVAL_S)
        except OSError as e:
            if DEBUG:
                print(f"[mock-bridge] heartbeat socket closed: {e}")
        finally:
            self.running = False

    def serve(self):
        self.conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        print(f"[mock-bridge] daemon connected from {self.addr}")
        writer = threading.Thread(target=self.heartbeat_loop, daemon=True)
        writer.start()
        self.reader_loop()  # blocks until the daemon disconnects
        try:
            self.conn.close()
        except OSError:
            pass
        print("[mock-bridge] daemon disconnected")


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((BIND_HOST, BIND_PORT))
    server.listen(1)
    print(f"[mock-bridge] listening on {BIND_HOST}:{BIND_PORT} "
          f"(fw={DONGLE_FW}, ch={RF_CHANNEL}, "
          f"armed={_engaged('MOCK_ARMED')}, start={_engaged('MOCK_START')}, "
          f"manfire={_engaged('MOCK_MANFIRE')})")
    try:
        while True:
            conn, addr = server.accept()
            # The daemon holds a single long-lived connection and reconnects
            # on drop, so serving one client at a time (like the real bridge's
            # listen(1)) is sufficient.
            MockBridge(conn, addr).serve()
    except KeyboardInterrupt:
        print("[mock-bridge] shutting down")
    finally:
        server.close()


if __name__ == "__main__":
    main()
