"""WebSocket client for an Omni hub dongle.

The hub (devices/byh_omni, hub switch closed at boot) speaks the same
newline line protocol as USB serial, but each line is one WebSocket
message on ws://<host>/ws. GET /api/info identifies the device before
we upgrade, so a laptop on the wrong network fails with a clear error
instead of a hung socket.

Stdlib only: the serial bridge does not depend on the `websockets`
package the rest of the host uses. Frames follow RFC 6455. The hub
requires client frames to be masked and answers pings; an unanswered
connection is closed after 20s.
"""

import base64
import hashlib
import json
import os
import select
import socket
import struct
import threading

DEFAULT_HUB_HOST = "192.17.76.1"
HUB_PORT = 80
HUB_INFO_PATH = "/api/info"
HUB_WS_PATH = "/ws"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Larger than the hub's outgoing line buffer (HOST_LINE_CAPACITY is 8192)
# so a full status JSON still fits. Anything bigger is a broken peer.
_MAX_FRAME = 65536


class HubLinkError(Exception):
    pass


def validate_hub_host(host):
    """Normalize an operator-entered hub address.

    Accepts an IPv4 address or a hostname. Rejects URLs, ports, and
    whitespace so a bad field cannot be turned into a request line.
    """
    if host is None:
        raise HubLinkError("Hub address is empty.")
    text = str(host).strip()
    if not text or len(text) > 253:
        raise HubLinkError("Hub address is empty.")
    if any(c in text for c in " \t\r\n:/\\?#@"):
        raise HubLinkError(
            f"Hub address {text!r} should be an IP or hostname, "
            "usually 192.17.76.1, with no scheme or port."
        )
    if _is_ipv4(text):
        return text
    if _is_hostname(text):
        return text
    raise HubLinkError(
        f"Hub address {text!r} is not an IPv4 address or hostname."
    )


def _is_ipv4(text):
    parts = text.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not part.isdigit():
            return False
        if len(part) > 1 and part.startswith("0"):
            return False
        if int(part) > 255:
            return False
    return True


def _is_hostname(text):
    if text.startswith(".") or text.endswith("."):
        return False
    labels = text.split(".")
    for label in labels:
        if not label or len(label) > 63:
            return False
        if label.startswith("-") or label.endswith("-"):
            return False
        for ch in label:
            if not (ch.isalnum() or ch == "-"):
                return False
    return True


def encode_frame(opcode, payload, mask=True):
    """Build one WebSocket frame. Client frames must be masked."""
    if not isinstance(payload, (bytes, bytearray)):
        raise TypeError("payload must be bytes")
    payload = bytes(payload)
    n = len(payload)
    header = bytearray([0x80 | (opcode & 0x0F)])
    mask_bit = 0x80 if mask else 0
    if n < 126:
        header.append(mask_bit | n)
    elif n < 65536:
        header.append(mask_bit | 126)
        header += struct.pack("!H", n)
    else:
        header.append(mask_bit | 127)
        header += struct.pack("!Q", n)
    if not mask:
        return bytes(header) + payload
    key = os.urandom(4)
    masked = bytes(b ^ key[i & 3] for i, b in enumerate(payload))
    return bytes(header) + key + masked


def pop_frame(buf):
    """Pop one complete frame from a bytearray.

    Returns (fin, opcode, payload) or None if the buffer is short.
    Raises HubLinkError on a frame the hub would never legally send.
    """
    if len(buf) < 2:
        return None
    b0 = buf[0]
    b1 = buf[1]
    if b0 & 0x70:
        raise HubLinkError("Hub sent a WebSocket extension frame.")
    fin = (b0 & 0x80) != 0
    opcode = b0 & 0x0F
    masked = (b1 & 0x80) != 0
    length = b1 & 0x7F
    pos = 2
    if length == 126:
        if len(buf) < 4:
            return None
        length = struct.unpack("!H", buf[2:4])[0]
        pos = 4
    elif length == 127:
        if len(buf) < 10:
            return None
        length = struct.unpack("!Q", buf[2:10])[0]
        pos = 10
    if length > _MAX_FRAME:
        raise HubLinkError("Hub frame is too large.")
    if masked:
        if len(buf) < pos + 4:
            return None
        key = buf[pos:pos + 4]
        pos += 4
    if len(buf) < pos + length:
        return None
    payload = bytearray(buf[pos:pos + length])
    if masked:
        for i in range(length):
            payload[i] ^= key[i & 3]
    del buf[:pos + length]
    return fin, opcode, bytes(payload)


def _read_http_head(sock, timeout):
    """Read through the header terminator. Returns (head, leftover)."""
    sock.settimeout(timeout)
    raw = bytearray()
    while b"\r\n\r\n" not in raw:
        chunk = sock.recv(4096)
        if not chunk:
            raise HubLinkError("Hub closed the connection during the handshake.")
        raw += chunk
        if len(raw) > 16384:
            raise HubLinkError("Hub handshake was too large.")
    head, _, rest = bytes(raw).partition(b"\r\n\r\n")
    return head.decode("iso-8859-1", "replace"), rest


def _header(head, name):
    prefix = name.lower() + ":"
    for line in head.split("\r\n")[1:]:
        if line.lower().startswith(prefix):
            return line.split(":", 1)[1].strip()
    return ""


def _probe(host, port, timeout):
    """GET /api/info and require a hub dongle. Returns the JSON object."""
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError as e:
        raise HubLinkError(
            f"Cannot reach a hub at {host}. Join the hub Wi-Fi "
            f"(BYH-Hub-…) and check the address. ({e})"
        ) from e
    try:
        req = (
            f"GET {HUB_INFO_PATH} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            "Accept: application/json\r\n"
            "Connection: close\r\n\r\n"
        )
        sock.sendall(req.encode("ascii"))
        head, rest = _read_http_head(sock, timeout)
        body = bytearray(rest)
        sock.settimeout(timeout)
        while True:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            body += chunk
            if len(body) > 16384:
                break
    finally:
        try:
            sock.close()
        except OSError:
            pass

    status = head.split("\r\n", 1)[0]
    if " 200 " not in status and not status.endswith(" 200"):
        raise HubLinkError(
            f"{host} answered, but it is not a Backyard Hero hub ({status})."
        )
    try:
        info = json.loads(bytes(body).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise HubLinkError(
            f"{host} did not return hub info ({e})."
        ) from e
    if not isinstance(info, dict) or info.get("role") != "hub_dongle":
        raise HubLinkError(
            f"{host} answered, but it is not a Backyard Hero hub."
        )
    return info


class HubLink:
    """One WebSocket session to a hub. Send and receive may run on
    different threads; all sends share a lock. Only one thread may
    call read_lines."""

    def __init__(self):
        self._sock = None
        self._buf = bytearray()
        self._frag_op = None
        self._frag = bytearray()
        self._send_lock = threading.Lock()
        self.host = None

    @property
    def connected(self):
        return self._sock is not None

    def connect(self, host, timeout=3.0, port=HUB_PORT):
        """Probe /api/info, then upgrade to /ws. Returns the info JSON."""
        self.close()
        host = validate_hub_host(host)
        info = _probe(host, port, timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        try:
            sock = socket.create_connection((host, port), timeout=timeout)
        except OSError as e:
            raise HubLinkError(
                f"Hub at {host} refused the WebSocket connection ({e})."
            ) from e
        try:
            req = (
                f"GET {HUB_WS_PATH} HTTP/1.1\r\n"
                f"Host: {host}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            )
            sock.sendall(req.encode("ascii"))
            head, rest = _read_http_head(sock, timeout)
        except Exception:
            sock.close()
            raise
        status = head.split("\r\n", 1)[0]
        if " 101 " not in status and not status.endswith(" 101"):
            sock.close()
            raise HubLinkError(
                f"Hub at {host} did not accept the WebSocket ({status})."
            )
        accept = _header(head, "Sec-WebSocket-Accept")
        expect = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        if accept != expect:
            sock.close()
            raise HubLinkError(f"Hub at {host} failed the WebSocket handshake.")
        sock.settimeout(0)
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        self._sock = sock
        self._buf = bytearray(rest)
        self._frag_op = None
        self._frag = bytearray()
        self.host = host
        return info

    def close(self):
        sock = self._sock
        self._sock = None
        self.host = None
        if sock is None:
            return
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass

    def send_line(self, line):
        """Send one protocol line, without a trailing newline."""
        if isinstance(line, str):
            line = line.encode("utf-8")
        line = bytes(line).rstrip(b"\r\n")
        if not line:
            return
        try:
            line.decode("utf-8")
            opcode = 0x1
        except UnicodeDecodeError:
            opcode = 0x2
        self._send(opcode, line)

    def read_lines(self, timeout=0.05):
        """Return protocol lines received within `timeout` seconds.

        Answers pings so the hub's idle timer stays clear. Raises
        HubLinkError when the socket dies.
        """
        sock = self._sock
        if sock is None:
            raise HubLinkError("Hub connection is closed.")
        lines = []
        # Parse anything already buffered (the hello often arrives in
        # the same TCP segment as the 101 response).
        self._drain_frames(lines)
        if lines:
            return lines
        try:
            readable, _, _ = select.select([sock], [], [], timeout)
        except (OSError, ValueError) as e:
            self.close()
            raise HubLinkError(f"Hub connection dropped ({e}).") from e
        if not readable:
            return lines
        try:
            chunk = sock.recv(8192)
        except (BlockingIOError, InterruptedError):
            return lines
        except OSError as e:
            self.close()
            raise HubLinkError(f"Hub connection dropped ({e}).") from e
        if chunk:
            self._buf += chunk
        # Keep reading while the socket still has bytes, so a burst of
        # status lines does not wait a poll each.
        while chunk:
            try:
                more = sock.recv(8192)
            except (BlockingIOError, InterruptedError):
                break
            except OSError as e:
                self._drain_frames(lines)
                self.close()
                if lines:
                    return lines
                raise HubLinkError(f"Hub connection dropped ({e}).") from e
            if not more:
                self._drain_frames(lines)
                self.close()
                if lines:
                    return lines
                raise HubLinkError("Hub closed the connection.")
            self._buf += more
            chunk = more
            if len(more) < 8192:
                break
        if not chunk:
            # Peer closed. Deliver any frames we already have, then fail
            # the session so the bridge reconnects instead of spinning
            # on a dead socket.
            self._drain_frames(lines)
            self.close()
            if lines:
                return lines
            raise HubLinkError("Hub closed the connection.")
        self._drain_frames(lines)
        return lines

    def _drain_frames(self, lines):
        while True:
            try:
                frame = pop_frame(self._buf)
            except HubLinkError:
                self.close()
                raise
            if frame is None:
                return
            fin, opcode, payload = frame
            if opcode == 0x9:  # ping
                self._send(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:  # close
                self.close()
                raise HubLinkError("Hub closed the WebSocket.")
            if opcode == 0x0:
                if self._frag_op is None:
                    self.close()
                    raise HubLinkError("Hub sent a continuation out of order.")
                self._frag += payload
                if fin:
                    self._take_message(self._frag_op, bytes(self._frag), lines)
                    self._frag_op = None
                    self._frag = bytearray()
                continue
            if opcode in (0x1, 0x2):
                if not fin:
                    self._frag_op = opcode
                    self._frag = bytearray(payload)
                    continue
                self._take_message(opcode, payload, lines)
                continue
            self.close()
            raise HubLinkError(f"Hub sent an unsupported frame ({opcode}).")

    def _take_message(self, opcode, payload, lines):
        # The hub sends one line per message and no trailing newline.
        # Be liberal in case a peer batches lines.
        for piece in payload.replace(b"\r\n", b"\n").replace(b"\r", b"\n").split(b"\n"):
            if piece:
                lines.append(piece)

    def _send(self, opcode, payload):
        sock = self._sock
        if sock is None:
            raise HubLinkError("Hub connection is closed.")
        frame = encode_frame(opcode, payload, mask=True)
        with self._send_lock:
            if self._sock is None:
                raise HubLinkError("Hub connection is closed.")
            try:
                self._sock.sendall(frame)
            except OSError as e:
                self.close()
                raise HubLinkError(f"Hub write failed ({e}).") from e


def _self_test():
    """Round-trip frames against a local stand-in for the hub."""
    import threading

    assert validate_hub_host("192.17.76.1") == "192.17.76.1"
    assert validate_hub_host("  hub.local ") == "hub.local"
    try:
        validate_hub_host("http://192.17.76.1")
        raise SystemExit("URL host should have been rejected")
    except HubLinkError:
        pass

    blob = os.urandom(200)  # forces the 16-bit payload-length header
    for payload in (b"msync", blob):
        buf = bytearray(encode_frame(0x1, payload, mask=True))
        fin, op, out = pop_frame(buf)
        assert fin and op == 0x1 and out == payload and not buf
    try:
        pop_frame(bytearray(encode_frame(0x1, b"x" * 70000, mask=False)))
        raise SystemExit("oversize frame should have been rejected")
    except HubLinkError:
        pass

    ready = threading.Event()
    result = {}

    def serve():
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(2)
        srv.settimeout(5)
        result["port"] = srv.getsockname()[1]
        ready.set()
        try:
            info, _ = srv.accept()
            head, _ = _read_http_head(info, 2)
            assert "/api/info" in head
            body = json.dumps({"role": "hub_dongle", "ssid": "BYH-Hub-TEST", "fw": 1})
            raw = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: application/json\r\n"
                f"Content-Length: {len(body)}\r\n"
                "Connection: close\r\n\r\n" + body
            ).encode()
            info.sendall(raw)
            info.close()

            ws, _ = srv.accept()
            head, _ = _read_http_head(ws, 2)
            key = _header(head, "Sec-WebSocket-Key")
            accept = base64.b64encode(
                hashlib.sha1((key + WS_GUID).encode()).digest()
            ).decode()
            ws.sendall(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                ).encode()
                + encode_frame(0x1, b'{"type":"hello"}', mask=False)
            )
            buf = bytearray()
            ws.settimeout(2)
            while True:
                frame = pop_frame(buf)
                if frame is not None:
                    break
                buf += ws.recv(4096)
            fin, op, payload = frame
            assert fin and op == 0x1 and payload == b"msync"
            ws.sendall(encode_frame(0x9, b"ping", mask=False))
            buf = bytearray()
            while True:
                frame = pop_frame(buf)
                if frame is not None:
                    break
                buf += ws.recv(4096)
            _, op, payload = frame
            assert op == 0xA and payload == b"ping"
            ws.sendall(encode_frame(0x1, b'{"type":"status","q":0}', mask=False))
            ws.close()
        finally:
            srv.close()

    threading.Thread(target=serve, daemon=True).start()
    assert ready.wait(2)
    link = HubLink()
    info = link.connect("127.0.0.1", timeout=2, port=result["port"])
    assert info["ssid"] == "BYH-Hub-TEST"
    hello = link.read_lines(1.0)
    assert hello == [b'{"type":"hello"}']
    link.send_line(b"msync\n")
    # The ping is answered inside read_lines; the status follows it.
    got = []
    for _ in range(20):
        got.extend(link.read_lines(0.1))
        if got:
            break
    assert got == [b'{"type":"status","q":0}'], got
    link.close()
    print("hub_link self-test ok")


if __name__ == "__main__":
    _self_test()
