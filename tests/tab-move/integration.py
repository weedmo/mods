#!/usr/bin/env python3
"""Real app/core movement on an isolated Xvfb display; no user's terminals touched."""
import json, os, pathlib, shutil, subprocess, tempfile, time, uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
ART=pathlib.Path.home()/'analysis/herdr-tab-move';ART.mkdir(parents=True,exist_ok=True)

def main():
 user=json.loads(subprocess.check_output(['hc','server','status','--json']))['core']['id']
 with tempfile.TemporaryDirectory(prefix='htm-') as folder:
  base=pathlib.Path(folder);app=base/'app';app.mkdir();(base/'run').mkdir(mode=0o700)
  env={**os.environ,'HERDR_APP_HOME':str(app),'HC_SESSION':'tm'+uuid.uuid4().hex[:6],
       'XDG_CONFIG_HOME':str(base/'config'),'XDG_STATE_HOME':str(base/'state'),'XDG_DATA_HOME':str(base/'data'),
       'XDG_RUNTIME_DIR':str(base/'run'),'LIBGL_ALWAYS_SOFTWARE':'1','XDG_SESSION_TYPE':'x11'}
  env.pop('WAYLAND_DISPLAY',None);env.pop('HC_TERMINAL_ID',None)
  for mod in ['tabs-weed','tab-drop','pane-weed']:
   shutil.copytree(ROOT/'mods'/mod,app/'mods'/mod)
  (app/'shared.json').write_text('{"frame.welcomed":"skipped"}')
  (app/'settings.json').write_text('{"telemetry":false}')
  (app/'layouts').mkdir()
  (app/'layouts/move-test.json').write_text(json.dumps({'type':'column','children':[
   {'type':'block','id':'tabs','size':{'px':42},'content':{'mod':'tabs-weed'}},
   {'type':'block','id':'main','content':{'tab':'active','pane':{'header':{'content':{'mod':'pane-weed'},'height':30}}}}]}))
  log=(ART/'runtime.log').open('w')
  xvfb=subprocess.Popen(['Xvfb','-displayfd','1','-screen','0','1200x900x24'],stdout=subprocess.PIPE,stderr=log)
  env['DISPLAY']=':'+xvfb.stdout.readline().decode().strip()
  proc=subprocess.Popen(['herdr-app'],env=env,stdout=log,stderr=log)
  def call(*args):
   p=subprocess.run(['herdr-app',*args],env=env,capture_output=True,text=True,timeout=10)
   assert p.returncode==0,p.stderr
   return json.loads(p.stdout) if p.stdout.strip().startswith(('{','[')) else p.stdout
  def do(command,**args):return call('do',command,json.dumps(args))
  def wait(fn):
   until=time.monotonic()+15
   while time.monotonic()<until:
    if fn():return
    time.sleep(.15)
   raise AssertionError('timed out; state='+str(call('ls')))
  try:
   wait(lambda:(app/'herdr-app.sock').exists())
   private=json.loads(subprocess.check_output(['hc','server','status','--json'],env=env))['core']['id'];assert private!=user
   do('layout.switch',name='move-test')
   do('space.new',name='move-test',folder=folder,argv=['/bin/bash'])
   time.sleep(.5)
   print('INITIAL',json.dumps(call('ls')),flush=True)
   do('tab.new',name='source',argv=['/bin/bash'])
   time.sleep(.5)
   initial=call('ls');(ART/'before.json').write_text(json.dumps(initial,indent=2));print('BEFORE',json.dumps(initial),flush=True)
   terminals=lambda state: sorted(t['terminal'] for s in state['spaces'] for tab in s['tabs'] for t in tab['terminals'])
   expected=terminals(initial);assert len(expected)==2
   do('tab.select',index=1)
   do('tabs-weed.pull-right')
   time.sleep(3)
   after=call('ls');(ART/'after.json').write_text(json.dumps(after,indent=2));print('AFTER',json.dumps(after),flush=True)
   assert terminals(after)==expected,after
   assert len(after['spaces'][0]['tabs'])==1,after
   call('shot',str(ART/'moved.png'))
   do('tabs-weed.detach')
   wait(lambda:len(call('ls')['spaces'][0]['tabs'])==2)
   assert terminals(call('ls'))==expected
   do('tabs-weed.pull-left')
   wait(lambda:len(call('ls')['spaces'][0]['tabs'])==1 and terminals(call('ls'))==expected)
   time.sleep(.5)
   (app/'layouts/picker-test.json').write_text(json.dumps({'type':'block','id':'picker','content':{'mod':'tab-drop'}}))
   do('layout.switch',name='picker-test')
   time.sleep(.5)
   call('shot',str(ART/'picker.png'))
   status=call('status');assert not status['errors'],status
   print('TAB_MOVE_INTEGRATION_PASSED',flush=True)
  finally:
   proc.terminate();proc.wait(timeout=10)
   # Check the private core identity before stopping it.
   check=subprocess.run(['hc','server','status','--json'],env=env,capture_output=True,text=True)
   if check.returncode==0:
    assert json.loads(check.stdout)['core']['id']!=user
    subprocess.run(['hc','server','stop','--json'],env=env,capture_output=True,timeout=10)
   xvfb.terminate();xvfb.wait(timeout=10);log.close()
if __name__=='__main__':main()
