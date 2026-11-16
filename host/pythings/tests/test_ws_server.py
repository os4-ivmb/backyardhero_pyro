import asyncio
import json
import time


def test_tail(modules, tmp_path):
    ws = modules[1]
    file = tmp_path / 'log'
    file.write_text('one\ntwö\nthree\n')
    assert ws.get_last_n_lines(str(file), 2, chunk_size=2) == ['twö', 'three']
    assert ws.get_last_n_lines(str(file), 0) == []


def test_receiver_split_and_revision(modules):
    ws = modules[1]
    fw = {'receivers': {'a': {'label': 'A', 'cues': {'1': [1]}, 'status': {'lmt': 1}, 'drift': 3}}}
    config, live, rev = ws._split_receivers(fw)
    assert config == {'a': {'label': 'A', 'cues': {'1': [1]}}}
    assert live == {'a': {'status': {'lmt': 1}, 'drift': 3}}
    fw['receivers']['a']['status']['lmt'] = 2
    assert ws._split_receivers(fw)[2] == rev
    fw['receivers']['a']['label'] = 'B'
    assert ws._split_receivers(fw)[2] != rev


def test_signature_ignores_liveness(modules):
    ws = modules[1]
    assert ws._stable_signature({'daemon_lup': 1, 'threads': {'a': 2}}, {}) == ws._stable_signature({'daemon_lup': 2, 'threads': {'a': 3}}, {})
    assert ws._stable_signature({'show_loaded': True}, {}) != ws._stable_signature({'show_loaded': False}, {})


def test_stale_file_cannot_replace_socket_state(modules):
    ws = modules[1]
    async def run():
        ws.STATE_COND = asyncio.Condition()
        ws._ingest_state_datagram(json.dumps({'daemon_lup': 200, 'value': 'fresh'}).encode())
        version = ws.STATE_VERSION
        await ws._publish_new_state({'daemon_lup': 100, 'value': 'stale'})
        assert ws.LATEST_FW_STATE['value'] == 'fresh'
        assert ws.STATE_VERSION == version
        ws.LATEST_FW_STATE_TS = time.time() - 4
        await ws._publish_new_state({'daemon_lup': 100, 'value': 'restarted'})
        assert ws.LATEST_FW_STATE['value'] == 'restarted'
    asyncio.run(run())


def test_pump_restarts_and_cancels(modules, monkeypatch):
    ws = modules[1]
    async def run():
        calls = []
        original_sleep = asyncio.sleep
        async def fast_sleep(_):
            await original_sleep(0)
        monkeypatch.setattr(ws.asyncio, 'sleep', fast_sleep)
        async def pump():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError('once')
            raise asyncio.CancelledError()
        try:
            await ws._supervise('test', pump)
        except asyncio.CancelledError:
            pass
        assert len(calls) == 2
    asyncio.run(run())


def test_udp_fallback_round_trip(modules, monkeypatch):
    import socket
    from types import SimpleNamespace
    daemon_module, ws = modules
    proxy = SimpleNamespace(**{name: getattr(socket, name) for name in dir(socket) if name != 'AF_UNIX'})
    monkeypatch.setattr(ws, 'socket', proxy)
    monkeypatch.setattr(daemon_module, 'socket', proxy)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    monkeypatch.setattr(ws, 'STATE_UDP_PORT', port)
    monkeypatch.setattr(daemon_module, 'STATE_UDP_PORT', port)
    async def run():
        ws.STATE_COND = asyncio.Condition()
        consumer = asyncio.create_task(ws.state_socket_consumer())
        daemon = daemon_module.FireworkDaemon()
        try:
            await asyncio.sleep(.05)
            assert daemon._publish_state_to_socket(b'{"daemon_lup":123,"udp":true}')
            await asyncio.sleep(.05)
            assert ws.LATEST_FW_STATE['udp'] is True
            assert daemon._publish_state_to_socket(b'x' * 60001) is False
        finally:
            consumer.cancel()
            await asyncio.gather(consumer, return_exceptions=True)
            if daemon._state_pub_sock:
                daemon._state_pub_sock.close()
    asyncio.run(run())


def test_heartbeat_expires_daemon_liveness(modules):
    ws = modules[1]
    ws.LATEST_FW_STATE = {'daemon_lup': int((time.time() - 20) * 1000), 'daemon_active': True}
    assert json.loads(ws._heartbeat_bytes({}))['daemon_active'] is False
