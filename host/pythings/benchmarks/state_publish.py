"""Synthetic 16-receiver benchmark. Run from any directory with host dependencies installed."""
import asyncio
import argparse
import contextlib
import io
import json
import shutil
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import types

parser = argparse.ArgumentParser(description='Compare state publishing with a baseline revision; no hardware required.')
parser.add_argument('--baseline', default='HEAD')
args = parser.parse_args()
root=Path(__file__).resolve().parents[3]
os.chdir(root)
scratch=Path(tempfile.mkdtemp(prefix='byh-bench-'))
for name in ('data','run','config'):(scratch/name).mkdir()
os.environ.update(BYH_DATA_DIR=str(scratch/'data'),BYH_RUN_DIR=str(scratch/'run'),BYH_CONFIG_DIR=str(scratch/'config'))
sys.path.insert(0,str(root/'host/pythings/pc_daemon'))
def module(name,path,before=False):
    source=subprocess.check_output(['git','show',f'{args.baseline}:{path}'],text=True) if before else Path(path).read_text()
    mod=types.ModuleType(name)
    exec(compile(source,str(root/path),'exec'),mod.__dict__)
    return mod
receivers={str(i):{'label':f'Receiver {i}','type':'NRF24','cues':{str(z):list(range(1,65)) for z in range(4)},'status':{'lmt':123,'online':True},'drift':0} for i in range(16)}
results={}
for before in (True,False):
    label='before' if before else 'after'
    daemon_mod=module('daemon_'+label,'host/pythings/pc_daemon/pc_daemon.py',before)
    ws=module('ws_'+label,'host/pythings/websock_server/ws_server.py',before)
    with contextlib.redirect_stdout(io.StringIO()):d=daemon_mod.FireworkDaemon()
    # Real state generation with a representative receiver map, no radio or DB work.
    d.protocol_handler=types.SimpleNamespace(show_loaded=False,errors=[],status=types.SimpleNamespace(name='STANDBY'),protocol='BKYD_TS_HYBRID',show_start_time=0,receivers=receivers)
    d._publish_state_to_socket=lambda _:True
    d._last_state_file_show_state='idle'
    d._last_state_file_write_ts=time.time() if before else time.monotonic()
    d._last_show_state_written='idle'
    start=time.perf_counter()
    for _ in range(1000):d.update_state_file()
    daemon_us=(time.perf_counter()-start)*1000
    ws.LATEST_FW_STATE={'daemon_lup':123,'receivers':receivers,'show_loaded':False}
    ws.AUX_CACHE_TS=1
    async def aux():return {'fw_cursor':0,'fw_system':{'temp':45},'fw_error':[],'fw_d_error':[]}
    ws._get_aux_shared=aux
    async def encode():
        start=time.perf_counter()
        for _ in range(1000):
            ws.STATE_VERSION+=1
            await ws._encoded_state()
        return (time.perf_counter()-start)*1000
    ws_us=asyncio.run(encode())
    publishes=[]
    d.update_state_file=lambda:publishes.append(time.monotonic())
    t=threading.Thread(target=d.state_flusher)
    t.start()
    start=time.monotonic()
    while time.monotonic()-start < 1.0:
        d.mark_state_dirty()
        time.sleep(.001)
    d.running=False;d._state_dirty.set();t.join(2)
    elapsed=time.monotonic()-start
    results[label]={'daemon_snapshot_us':round(daemon_us,1),'ws_encode_us':round(ws_us,1),'publishes_per_second':round(len(publishes)/elapsed,1)}
print(json.dumps(results,indent=2))

shutil.rmtree(scratch)
