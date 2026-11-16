"""Exercise the real processes with the mock bridge and isolated runtime files."""
import asyncio
import json
import os
from pathlib import Path
import sqlite3
import socket
import subprocess
import sys
import time

import websockets

ROOT = Path(__file__).resolve().parents[2]


def test_mock_bridge_end_to_end(tmp_path):
    data, run = tmp_path / 'data', tmp_path / 'custom-run'
    data.mkdir()
    run.mkdir()
    (data / 'log').mkdir()
    (run / 'd_cmd').mkdir()
    with sqlite3.connect(data / 'backyardhero.db') as conn:
        conn.execute('CREATE TABLE Receivers (id TEXT PRIMARY KEY, label TEXT, type TEXT, cues_data TEXT, enabled INTEGER, metadata TEXT, configuration_version INTEGER)')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        bridge_port = probe.getsockname()[1]
    # WS currently has a fixed application port. Avoid interference with a live stack.
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', 8090))
        except OSError:
            import pytest
            pytest.skip('WebSocket application port already in use')
    env = {**os.environ, 'BYH_DATA_DIR': str(data), 'BYH_CONFIG_DIR': str(ROOT / 'config'),
           'BYH_RUN_DIR': str(run), 'BYH_BRIDGE_HOST': '127.0.0.1', 'BYH_BRIDGE_BIND': '127.0.0.1',
           'BYH_BRIDGE_PORT': str(bridge_port), 'PYTHONUNBUFFERED': '1'}
    processes, streams = [], []
    def start(script):
        stream = open(tmp_path / (Path(script).stem + '.log'), 'w')
        streams.append(stream)
        process = subprocess.Popen([sys.executable, str(ROOT / script)], env=env, stdout=stream, stderr=subprocess.STDOUT)
        processes.append(process)
        return process
    def wait_until(predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.025)
        logs = '\n'.join(p.read_text() for p in tmp_path.glob('*.log'))
        raise AssertionError(logs)
    def state():
        try:
            return json.loads((data / 'state').read_text())
        except (FileNotFoundError, ValueError):
            return {}
    try:
        start('pythings/mock_bridge/mock_bridge.py')
        start('pythings/websock_server/ws_server.py')
        # Startup must purge inbox commands written while the daemon was down.
        (run / 'd_cmd/stale.json').write_text('{"type":"set_brightness","brightness":99}')
        daemon = start('pythings/pc_daemon/pc_daemon.py')
        wait_until(lambda: state().get('active_protocol'))
        assert not (run / 'd_cmd/stale.json').exists()
        assert state()['settings']['led_brightness'] != 99
        for name, command in [('1-bad', {'type': 'manual_fire', 'cmd_id': 'bad'}),
                              ('2-good', {'type': 'set_brightness', 'brightness': 40, 'cmd_id': 'good'})]:
            temporary = run / 'd_cmd/.command.tmp'
            temporary.write_text(json.dumps(command))
            temporary.rename(run / f'd_cmd/{name}.json')
        wait_until(lambda: (state().get('last_command_ack') or {}).get('cmd_id') == 'good')
        assert state()['last_command_ack']['ok'] is True
        assert state()['settings']['led_brightness'] == 40
        assert not list((run / 'd_cmd').glob('*.json'))
        async def check_clients():
            async with websockets.connect('ws://127.0.0.1:8090') as first:
                async with websockets.connect('ws://127.0.0.1:8090') as second:
                    await asyncio.wait_for(second.recv(), 3)
                await asyncio.sleep(.1)
                assert (data / 'webactstate').read_text() == '1'
                # Atomic cursor update in a non-default runtime dir must reach a client.
                temporary = run / '.cursor.tmp'
                temporary.write_text('12.5')
                temporary.replace(run / 'fw_cursor')
                until = time.monotonic() + 3
                while time.monotonic() < until:
                    message = json.loads(await asyncio.wait_for(first.recv(), 3))
                    if message.get('fw_cursor') == 12.5:
                        return
                raise AssertionError('Cursor update was not delivered')
        asyncio.run(check_clients())
        old_lup = state()['daemon_lup']
        started = time.monotonic()
        daemon.terminate()
        daemon.wait(timeout=4)
        assert daemon.returncode == 0
        assert time.monotonic() - started < 3
        assert state()['daemon_lup'] >= old_lup
        assert not list(data.glob('.state.*.tmp'))
        errors = (data / 'log/daemon.err').read_text()
        assert errors.count('Command manual_fire failed:') == 1
        assert 'monitoring switches' not in errors
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for stream in streams:
            stream.close()
