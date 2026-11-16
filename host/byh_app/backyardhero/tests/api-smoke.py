"""Run after npm run build; exercises the local HTTP API using throwaway data."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

root=Path(__file__).resolve().parents[4];app=root/'host/byh_app/backyardhero'
with tempfile.TemporaryDirectory(prefix='byh-api-') as directory:
    base=Path(directory);data=base/'data';data.mkdir()
    audio=data/'uploads/audio';audio.mkdir(parents=True);(audio/'test.mp3').write_bytes(b'0123456789')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    env={**os.environ,'BYH_DATA_DIR':str(data),'BYH_CONFIG_DIR':str(root/'host/config'),'BYH_RUN_DIR':str(base/'run'),'NEXT_TELEMETRY_DISABLED':'1'}
    log=open(base/'server.log','w')
    process=subprocess.Popen(['node','node_modules/next/dist/bin/next','start','--port',str(port)],cwd=app,env=env,stdout=log,stderr=subprocess.STDOUT)
    def request(path,headers=None,payload=None,method=None):
        req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,headers=headers or {},data=json.dumps(payload).encode() if payload is not None else None,method=method)
        try:
            with urllib.request.urlopen(req,timeout=5) as response:return response.status,response.headers,response.read()
        except urllib.error.HTTPError as response:return response.code,response.headers,response.read()
    try:
        for _ in range(100):
            try:
                if request('/')[0]==200:break
            except OSError:pass
            time.sleep(.1)
        assert request('/api/shows')[0]==200
        show={'name':'Cache smoke','duration':0,'version':'1','runtime_version':'1','display_payload':'[]','runtime_payload':'[]','authorization_code':'smoke','protocol':'BKYD_TS_HYBRID'}
        status,_,body=request('/api/shows',{'Content-Type':'application/json'},show)
        assert status==201,(status,body)
        status,headers,body=request('/api/shows')
        assert len(json.loads(body))==1
        assert request('/api/shows',{'If-None-Match':headers['ETag']})[0]==304
        status,headers,body=request('/api/shows/audio/test.mp3')
        assert status==200 and body==b'0123456789'
        assert request('/api/shows/audio/test.mp3',{'If-None-Match':headers['ETag']})[0]==304
        assert request('/api/shows/audio/test.mp3',{'If-Modified-Since':headers['Last-Modified']})[0]==304
        assert request('/api/shows/audio/test.mp3',{'Range':'bytes=2-5'})[0::2]==(206,b'2345')
        with sqlite3.connect(data/'backyardhero.db') as db:
            assert db.execute('PRAGMA journal_mode').fetchone()[0]=='wal'
        status,_,body=request('/api/system/data')
        assert status==200,(status,body)
        export=base/'export.db';export.write_bytes(body)
        with sqlite3.connect(export) as db:
            assert db.execute('SELECT name FROM Show').fetchone()[0]=='Cache smoke'
        # Import the exported WAL-backed snapshot, then verify retention and contents.
        for index in range(7):
            (data / f'backyardhero.db.backup-2000-01-0{index+1}').write_bytes(body)
        boundary = 'byh-smoke-boundary'
        upload = (f'--{boundary}\r\nContent-Disposition: form-data; name="database"; filename="export.db"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + body + f'\r\n--{boundary}--\r\n'.encode())
        req = urllib.request.Request(f'http://127.0.0.1:{port}/api/system/data', data=upload, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        with urllib.request.urlopen(req, timeout=5) as response:
            assert response.status == 200
        process.wait(timeout=4)
        assert len(list(data.glob('backyardhero.db.backup-*'))) == 5
        with sqlite3.connect(data / 'backyardhero.db') as db:
            assert db.execute('SELECT name FROM Show').fetchone()[0] == 'Cache smoke'
        print('PASS: show save/list, ETag 304, audio validators and byte ranges, SQLite WAL, database export/import, five-backup retention')
    finally:
        process.terminate()
        try:process.wait(timeout=4)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()
