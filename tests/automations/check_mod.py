import subprocess
from pathlib import Path
path=Path(__file__).resolve().parents[2]/'mods/automations'
p=subprocess.run(['herdr-app','check',str(path)],capture_output=True,text=True)
print(p.stdout,p.stderr)
assert p.returncode==0 and 'check passed:' in p.stdout
print('AUTOMATIONS_MOD_PASSED')
