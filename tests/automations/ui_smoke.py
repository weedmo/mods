#!/usr/bin/env python3
"""Render the real GPUI mod in a private Xvfb screen (no user focus)."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
ARTIFACTS=Path.home()/'analysis/herdr-automations-ui'
ARTIFACTS.mkdir(parents=True,exist_ok=True)

def main():
    root=Path(tempfile.mkdtemp(prefix='ha-ui-'))
    app=root/'app';app.mkdir()
    runtime=root/'runtime';runtime.mkdir(mode=0o700)
    env={**os.environ,'HERDR_APP_HOME':str(app),'HC_SESSION':'hui'+uuid.uuid4().hex[:6],
         'XDG_CONFIG_HOME':str(root/'config'),'XDG_STATE_HOME':str(root/'state'),
         'XDG_DATA_HOME':str(root/'data'),'XDG_RUNTIME_DIR':str(runtime),
         'HERDR_AUTOMATIONS_STATE':str(root/'auto-state'),
         'HERDR_AUTOMATIONS_SOCKET':str(root/'control.sock'),
         'LIBGL_ALWAYS_SOFTWARE':'1'}
    env.pop('WAYLAND_DISPLAY',None);env.pop('HC_TERMINAL_ID',None)
    env['XDG_SESSION_TYPE']='x11'
    shutil.copytree(ROOT/'mods/automations',app/'mods/automations')
    # Use the source client in the isolated app with its own controller socket.
    client=app/'mods/automations/client.js'
    client.write_text(client.read_text().replace('home() + "/.local/share/herdr-automations/cli.py"',json.dumps(str(ROOT/'scripts/herdr-automations/cli.py'))))
    (app/'layouts').mkdir()
    (app/'layouts/automation-test.json').write_text(json.dumps({'type':'block','id':'test-root','content':{'mod':'automations'},'background':'canvas'}))
    (app/'shared.json').write_text('{"frame.welcomed":"skipped"}')
    (app/'settings.json').write_text('{"telemetry":false}')
    log=(ARTIFACTS/'ui.log').open('w')
    display=subprocess.Popen(['Xvfb','-displayfd','1','-screen','0','1200x900x24'],stdout=subprocess.PIPE,stderr=log)
    number=display.stdout.readline().decode().strip();env['DISPLAY']=':'+number
    sys.path.insert(0,str(ROOT/'scripts/herdr-automations'))
    from store import Store
    state=Path(env['HERDR_AUTOMATIONS_STATE']);state.mkdir()
    st=Store(state/'automations.db')
    d=st.save({'name':'평일 코드 검토 · 화면 검증 예시','cwd':str(ROOT),'agent':'codex',
        'prompt':'변경사항을 읽고 검토 결과를 정리하세요.','enabled':False,
        'schedule':{'kind':'weekdays','timezone':'Asia/Seoul','hour':9,'minute':0}},request_id='ui-fixture-created')
    with st.db:
        r=st._enqueue(d,'schedule',time.time(),'fixture-only',time.time(),'skipped_precheck')
    st.set_run(r['id'],message='조건 명령이 exit 1로 종료되어 예약 실행을 건너뛰었습니다.',output='화면 검증용 예시입니다.')
    st.close()
    service=subprocess.Popen([sys.executable,str(ROOT/'scripts/herdr-automations/service.py')],env=env,stdout=log,stderr=log)
    window=subprocess.Popen(['herdr-app'],env=env,stdout=log,stderr=log)
    # Keep references for bounded interactive inspection, only our process/session.
    (ARTIFACTS/'session.json').write_text(json.dumps({'root':str(root),'env':{k:env[k] for k in ['HERDR_APP_HOME','HC_SESSION','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','HERDR_AUTOMATIONS_SOCKET','DISPLAY']},'pids':[window.pid,service.pid,display.pid]}))
    def appcall(*args):
        return subprocess.run(['herdr-app',*args],env=env,capture_output=True,text=True,timeout=10)
    try:
        for _ in range(100):
            if window.poll() is not None: raise AssertionError('Herdr exited; see ui.log')
            if (app/'herdr-app.sock').exists():break
            time.sleep(.1)
        result=appcall('do','layout.switch','{"name":"automation-test"}')
        assert result.returncode==0,result.stderr
        time.sleep(2)
        shot=appcall('shot',str(ARTIFACTS/'list.png'));assert shot.returncode==0,shot.stderr
        for command,filename in [('automations.new','form'),('automations.history','history')]:
            result=appcall('do',command);assert result.returncode==0,result.stderr
            time.sleep(.6)
            shot=appcall('shot',str(ARTIFACTS/(filename+'.png')));assert shot.returncode==0,shot.stderr
        service.terminate();service.wait(timeout=8)
        appcall('do','automations.list')
        time.sleep(.6)
        appcall('shot',str(ARTIFACTS/'disconnected.png'))
        status=json.loads(appcall('status').stdout)
        assert not status['errors'],status['errors']
        print('AUTOMATIONS_UI_PASSED',flush=True)
    finally:
        window.terminate();window.wait(timeout=10)
        if service.poll() is None: service.terminate();service.wait(timeout=10)
        subprocess.run(['hc','server','stop','--json'],env=env,capture_output=True,timeout=15)
        display.terminate();display.wait(timeout=10)
        log.close()
        shutil.rmtree(root)

if __name__=='__main__':main()
