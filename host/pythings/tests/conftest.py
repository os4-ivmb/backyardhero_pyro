import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def modules(tmp_path, monkeypatch):
    for key, child in [('BYH_DATA_DIR', 'data'), ('BYH_CONFIG_DIR', 'config'), ('BYH_RUN_DIR', 'run')]:
        directory = tmp_path / child
        directory.mkdir()
        monkeypatch.setenv(key, str(directory))
    (tmp_path / 'data' / 'log').mkdir()
    (tmp_path / 'run' / 'd_cmd').mkdir()
    monkeypatch.syspath_prepend(str(ROOT / 'pc_daemon'))
    monkeypatch.syspath_prepend(str(ROOT / 'websock_server'))
    for name in ('config_loader', 'protocol_handler.BYHProtocolHandler', 'pc_daemon', 'ws_server'):
        if name in sys.modules:
            importlib.reload(sys.modules[name])
        else:
            importlib.import_module(name)
    return sys.modules['pc_daemon'], sys.modules['ws_server']


@pytest.fixture
def daemon(modules):
    instance = modules[0].FireworkDaemon()
    yield instance
    instance.running = False
    if instance._state_pub_sock:
        instance._state_pub_sock.close()
