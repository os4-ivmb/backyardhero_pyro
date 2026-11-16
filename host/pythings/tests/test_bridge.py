import importlib
from pathlib import Path
import socket
import threading
from types import SimpleNamespace


def bridge_module(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'tcp_serial_bridge'))
    return importlib.import_module('tcp_serial_bridge')


def test_serial_reader_backs_off_and_recovers_on_data(monkeypatch):
    bridge = bridge_module(monkeypatch)
    class Serial:
        is_open = True
        polls = 0
        @property
        def in_waiting(self):
            self.polls += 1
            return int(self.polls == 56)
        def read(self, _):
            return b'x'
    class Stop:
        waits = []
        def is_set(self):
            return len(self.waits) >= 60
        def wait(self, interval):
            self.waits.append(interval)
    sent = []
    monkeypatch.setattr(bridge, 'serial_conn', Serial())
    monkeypatch.setattr(bridge, '_tx_drops', SimpleNamespace(flush=lambda _: None))
    monkeypatch.setitem(bridge.SERIAL_CONFIG, 'link', 'usb')
    stop = Stop()
    bridge.serial_to_tcp(SimpleNamespace(sendall=sent.append), stop)
    assert stop.waits[0] == .001
    assert .005 in stop.waits
    assert stop.waits[-1] == .001
    assert sent == [b'x']


def test_disconnected_client_stops_both_workers(monkeypatch):
    bridge = bridge_module(monkeypatch)
    monkeypatch.setattr(bridge, 'serial_conn', SimpleNamespace(is_open=True, in_waiting=0))
    monkeypatch.setitem(bridge.SERIAL_CONFIG, 'link', 'usb')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        client = socket.create_connection(listener.getsockname())
        accepted, _ = listener.accept()
    thread = threading.Thread(target=bridge.handle_client, args=(accepted,))
    thread.start()
    client.close()
    thread.join(timeout=3)
    assert not thread.is_alive()
    assert not [t for t in threading.enumerate() if t.name.endswith('(serial_to_tcp)')]
