#!/usr/bin/env python3
"""Compare reusable installed setup with this repository; never read runtime data."""
import json
from pathlib import Path
import sys
repo = Path(__file__).resolve().parents[1]
home = Path.home() / '.config/herdr-app'
installed = json.loads((home / 'installed.json').read_text())
pairs = []
custom = []
ignored = {'jsconfig.json', 'AGENTS.md', '.agent-resume-install.json'}
def sources(folder):
    return [p for p in folder.rglob('*') if p.is_file() and p.name not in ignored
            and not p.name.endswith(('.d.ts', '.error', '.bak', '.pyc'))
            and '__pycache__' not in p.parts and not p.name.startswith('.')]
for folder in sorted((home / 'mods').iterdir()):
    if not folder.is_dir(): continue
    # App-owned mods are installed by Herdr. Include any already vendored copy.
    if folder.name in installed and not (repo / 'mods' / folder.name).exists(): continue
    files = sources(folder)
    if not files: continue
    custom.append(folder.name)
    pairs += [(p, repo/'mods'/folder.name/p.relative_to(folder)) for p in files]
for folder, target in [('themes', 'examples/themes')]:
    pairs += [(p,repo/target/p.relative_to(home/folder)) for p in sources(home/folder)]
for name in ['keys.json','settings.json','programs.json']:
    pairs.append((home/name,repo/'examples'/name))
for p in (home/'layouts').glob('*.json'):
    if 'layout:'+p.stem not in installed: pairs.append((p,repo/'layouts'/p.name))
for p in (Path.home()/'.local/share/herdr-automations').glob('*.py'):
    pairs.append((p,repo/'scripts/herdr-automations'/p.name))
pairs.append((Path.home()/'.local/bin/herdr-statusline-tee.sh',repo/'scripts/herdr-statusline-tee.sh'))
failures = []
for live, saved in pairs:
    if not saved.exists() or saved.read_bytes()!=live.read_bytes(): failures.append(str(saved.relative_to(repo)))
if '--sync' in sys.argv:
    import shutil
    for live, saved in pairs:
        saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(live,saved)
    print('SYNCED', len(pairs), 'files');sys.exit(0)
if failures:
    print('MISSING_OR_DIFFERENT', '\n'.join(failures));sys.exit(1)
print('SETUP_INVENTORY_MATCH',len(custom),'mods',len(pairs),'files')
print('MODS', ', '.join(custom))
