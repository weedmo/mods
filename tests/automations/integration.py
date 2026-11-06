#!/usr/bin/env python3
"""Real hc in a private session, deterministic fake provider (no API spend)."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'scripts/herdr-automations'
sys.path.insert(0,str(SOURCE))
from store import Store
from schedule import latest

def wait_for(fn, seconds=20):
    until=time.monotonic()+seconds
    last=None
    while time.monotonic()<until:
        try:
            last=fn()
            if last: return last
        except (OSError,ValueError): pass
        time.sleep(.2)
    raise AssertionError('Timed out: '+str(last))

def main():
    hc=shutil.which('hc'); assert hc
    user_id=json.loads(subprocess.check_output([hc,'server','status','--json']))['core']['id']
    with tempfile.TemporaryDirectory(prefix='ha-integration-') as folder:
        root=Path(folder); bin=root/'bin';bin.mkdir()
        fake=bin/'codex'
        fake.write_text('''#!/usr/bin/python3
import json,sys,time
print('\\x1b]7501;state=working:app=codex\\x07',flush=True)
time.sleep(.4)
print('AUTOMATION_TEST_DONE',flush=True)
print('\\x1b]7501;state=done:app=codex\\x07',flush=True)
time.sleep(60)
''')
        fake.chmod(0o755)
        env={**os.environ,'HC_SESSION':'ha-'+uuid.uuid4().hex[:8],
             'XDG_CONFIG_HOME':str(root/'config'),'XDG_STATE_HOME':str(root/'state'),
             'XDG_DATA_HOME':str(root/'data'),'XDG_RUNTIME_DIR':str(root/'runtime'),
             'HERDR_AUTOMATIONS_STATE':str(root/'automation-state'),
             'HERDR_AUTOMATIONS_SOCKET':str(root/'control.sock'),
             'HERDR_AUTOMATIONS_HC':hc,'PATH':str(bin)+':'+os.environ['PATH']}
        Path(env['XDG_RUNTIME_DIR']).mkdir(mode=0o700)
        env.pop('HC_TERMINAL_ID',None)
        # Ensure isolation before any operation that can stop a core.
        started=subprocess.run([hc,'server','start','--json'],env=env,capture_output=True,text=True)
        assert started.returncode == 0, started.stderr
        test_id=json.loads(subprocess.check_output([hc,'server','status','--json'],env=env))['core']['id']
        assert test_id != user_id,'HC_SESSION did not isolate the core'
        service=None
        log=(root/'service.log').open('w+')
        def req(q):
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
                s.settimeout(8);s.connect(env['HERDR_AUTOMATIONS_SOCKET'])
                s.sendall((json.dumps(q)+'\n').encode())
                with s.makefile('rb') as stream: r=json.loads(stream.readline())
                assert r['ok'],r
                return r['result']
        def start():
            p=subprocess.Popen([sys.executable,str(SOURCE/'service.py')],env=env,stdout=log,stderr=log)
            wait_for(lambda:req({'op':'status'}));return p
        def stop(p):
            p.terminate();p.wait(timeout=8)
        addresses=[]
        try:
            state=Path(env['HERDR_AUTOMATIONS_STATE']);state.mkdir()
            store=Store(state/'automations.db')
            now=time.time()
            definition={'name':'Integration','cwd':str(root),'agent':'codex','prompt':'noop','enabled':True,
                'schedule':{'kind':'hourly','hour':0,'minute':time.localtime().tm_min,'timezone':time.tzname[0] if time.tzname[0]=='UTC' else 'Asia/Seoul'},
                'precheck':{'command':'printf PRECHECK_OK','timeout':2}}
            # Match the current minute in explicit Seoul timezone independent of test host TZ.
            from datetime import datetime
            from zoneinfo import ZoneInfo
            definition['schedule']['minute']=datetime.now(ZoneInfo(definition['schedule']['timezone'])).minute
            d=store.save(definition,request_id='integration-create',now=now-120)
            store.close()
            service=start()
            def completed():
                runs=req({'op':'runs','id':d['id']})
                return runs[0] if runs and runs[0]['phase']=='succeeded' else None
            r=wait_for(completed,25);addresses.append(r['address'])
            full=req({'op':'getRun','id':r['id']})
            assert full['precheck']['passed'] and 'PRECHECK_OK' in full['precheck']['output']
            assert 'AUTOMATION_TEST_DONE' in full['output']
            stop(service);service=start()
            assert len(req({'op':'runs','id':d['id']}))==1
            d=req({'op':'get','id':d['id']})
            req({'op':'setEnabled','id':d['id'],'revision':d['revision'],'enabled':False,'requestId':'pause-integration'})
            d=req({'op':'get','id':d['id']})
            changed={**d,'precheck':{'command':'exit 9','timeout':1}}
            req({'op':'update','id':d['id'],'revision':d['revision'],'definition':changed,'requestId':'change-integration'})
            r2=req({'op':'runNow','id':d['id'],'requestId':'manual-integration'})
            duplicate=req({'op':'runNow','id':d['id'],'requestId':'manual-integration'})
            assert duplicate['id']==r2['id']
            manual=wait_for(lambda: (lambda r:r if r['phase']=='succeeded' else None)(req({'op':'getRun','id':r2['id']})),25)
            addresses.append(manual['address']);assert 'precheck' not in manual
            stop(service);service=start()
            assert req({'op':'get','id':d['id']})['enabled'] is False
            assert len(req({'op':'runs','id':d['id']}))==2
            # Live core event history must contain only one terminal for each run ID.
            for run_id in (r['id'],r2['id']):
                terms=json.loads(subprocess.check_output([hc,'ls','--all','--json','--label','herdr.automation.run='+run_id],env=env))['terminals']
                assert len(terms)==1,terms
            print('AUTOMATIONS_INTEGRATION_PASSED')
        except Exception:
            print('RUNS',req({'op':'runs','id':d['id']}))
            print('CORE',subprocess.check_output([hc,'ls','--all','--json'],env=env).decode())
            for rr in req({'op':'runs','id':d['id']}):
                if rr.get('address'): print('TERMINAL',subprocess.check_output([hc,'get',rr['address'],'--json'],env=env).decode())
            raise
        finally:
            if service and service.poll() is None: stop(service)
            # Only the verified private core can be stopped here.
            current=json.loads(subprocess.check_output([hc,'server','status','--json'],env=env))['core']['id']
            assert current==test_id and current!=user_id
            subprocess.run([hc,'server','stop','--json'],env=env,check=True,capture_output=True)
            log.seek(0);logs=log.read();log.close()
            if logs: print(logs[-3000:])

if __name__=='__main__':main()
