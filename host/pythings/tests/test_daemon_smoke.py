import json
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


def test_command_binding_and_snapshot(daemon, modules):
    module, _ = modules
    daemon.handle_command({'type': 'set_brightness', 'brightness': 40})
    assert daemon.led_brightness == 40
    daemon.handle_command({'type': 'load_show', 'id': 1})
    assert list(daemon._slow_queue) == [{'type': 'load_show', 'id': 1}]
    # This checkout has no _update_sequence_run_led; protect the actual binding.
    assert module.FireworkDaemon._is_slow_command({'type': 'load_show'})
    daemon.update_state_file(force_file=True)
    assert isinstance(json.loads(Path(module.STATE_FILE_PATH).read_text())['daemon_lup'], int)


@pytest.mark.parametrize('bad', ['{', '[]', '{"type":"manual_fire"}'])
def test_failed_command_does_not_block_next(daemon, modules, bad):
    module, _ = modules
    first = Path(module.COMMAND_DIR) / '1.json'
    second = Path(module.COMMAND_DIR) / '2.json'
    first.write_text(bad)
    second.write_text('{"type":"set_brightness","brightness":40,"cmd_id":"next"}')
    daemon._consume_command_file(str(first))
    assert not first.exists()
    assert daemon.last_command_ack['ok'] is False
    daemon._consume_command_file(str(second))
    assert not second.exists()
    assert daemon.last_command_ack['ok'] is True
    assert daemon.led_brightness == 40
    assert daemon.last_command_ack['cmd_id'] == 'next'


def test_stale_commands_and_stop_exception(daemon, modules, monkeypatch):
    module, _ = modules
    called = []
    monkeypatch.setattr(daemon, 'handle_command', called.append)
    for command_type in ['set_brightness', *module.AGE_EXEMPT_COMMANDS]:
        file = Path(module.COMMAND_DIR) / 'stale.json'
        file.write_text(json.dumps({'type': command_type}))
        os.utime(file, (time.time() - 30, time.time() - 30))
        daemon._consume_command_file(str(file))
        assert daemon.last_command_ack['ok'] == (command_type in module.AGE_EXEMPT_COMMANDS)
    assert {c['type'] for c in called} == module.AGE_EXEMPT_COMMANDS


def test_error_log_rotation(daemon, modules):
    file = Path(modules[0].ERR_LOG_PATH)
    file.write_text('x' * 1024 * 1024)
    daemon.write_error('new error')
    assert file.stat().st_size < 1024
    assert file.with_name('daemon.err.1').stat().st_size == 1024 * 1024


def test_atomic_write_cleanup(modules, tmp_path, monkeypatch):
    module, _ = modules
    file = tmp_path / 'cursor'
    module.atomic_write(str(file), '1')
    assert file.read_text() == '1'
    def fail(*_):
        raise OSError('replace failed')
    monkeypatch.setattr(module.os, 'replace', fail)
    with pytest.raises(OSError):
        module.atomic_write(str(file), '2')
    assert file.read_text() == '1'
    assert not list(tmp_path.glob('.byh.*.tmp'))


def test_unchanged_led_value_is_not_sent(daemon, monkeypatch):
    sends = []
    monkeypatch.setattr(daemon, 'send_serial_command', sends.append)
    daemon.led_handler.update('receiver_timeout_ms', int('31000'))
    daemon.led_handler.update('receiver_timeout_ms', int('31000'))
    assert len(sends) == 1


def test_oversize_file_fallback_is_limited(daemon, modules, monkeypatch):
    file = Path(modules[0].STATE_FILE_PATH)
    monkeypatch.setattr(daemon, '_publish_state_to_socket', lambda _: False)
    daemon.update_state_file(force_file=True)
    first = file.stat().st_mtime_ns
    for _ in range(10):
        daemon.update_state_file()
    assert file.stat().st_mtime_ns == first


def test_watchdog_defers_restart_during_show(daemon, monkeypatch):
    module = __import__('pc_daemon')
    exits = []
    monkeypatch.setattr(module.os, '_exit', exits.append)
    daemon._beats['monitor_switch'] = time.monotonic() - 60
    daemon.command_timer_threads = [SimpleNamespace(is_alive=lambda: True)]
    daemon._check_worker_health()
    assert not exits
    daemon.command_timer_threads.clear()
    daemon._check_worker_health()
    assert exits == [70]


def test_publish_rate_is_bounded(daemon, monkeypatch):
    publishes = []
    monkeypatch.setattr(daemon, 'update_state_file', lambda: publishes.append(time.monotonic()))
    thread = threading.Thread(target=daemon.state_flusher)
    thread.start()
    until = time.monotonic() + .3
    while time.monotonic() < until:
        daemon.mark_state_dirty()
        time.sleep(.001)
    daemon.running = False
    daemon._state_dirty.set()
    thread.join(2)
    assert not thread.is_alive()
    assert len(publishes) >= 4
    assert all(b - a >= .049 for a, b in zip(publishes, publishes[1:]))


def test_switch_errors_sleep_and_are_rate_limited(daemon, modules, monkeypatch):
    errors, sleeps = [], []
    daemon.protocol_handler = object()
    def broken():
        raise RuntimeError('switch read failed')
    def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 3:
            daemon.running = False
    monkeypatch.setattr(daemon, 'load_webact_state_and_settings', broken)
    monkeypatch.setattr(daemon, 'write_error', errors.append)
    monkeypatch.setattr(modules[0].time, 'sleep', sleep)
    daemon.monitor_switch()
    assert sleeps == [.1, .1, .1]
    assert len(errors) == 1


def test_send_timeout_drops_connection(daemon, monkeypatch):
    errors = []
    class StalledSocket:
        def sendall(self, _):
            raise BlockingIOError('send timed out')
        def shutdown(self, _):
            pass
        def close(self):
            pass
    daemon.tcp_socket = StalledSocket()
    monkeypatch.setattr(daemon, 'write_error', errors.append)
    daemon.send_serial_command('test')
    assert daemon.tcp_socket is None
    assert errors == ['Timed out sending to the dongle bridge; reconnecting.']
