#!/usr/bin/env python3
"""Install/remove the local user service and mod; retain user data on removal."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

NAME = 'herdr-automations'

def atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(text)
    tmp.replace(path)

def layout_entry(tree, remove=False):
    changed = False
    sidebar = None
    def visit(node):
        nonlocal changed, sidebar
        if node.get('id') == 'sidebar':
            sidebar = node
        children = node.get('children', [])
        kept = [c for c in children if c.get('id') != 'automation-options']
        if len(kept) != len(children):
            node['children'] = kept
            changed = True
        for child in kept:
            visit(child)
    visit(tree)
    if not remove and sidebar is not None:
        children = sidebar.setdefault('children', [])
        position = next((i for i, child in enumerate(children) if child.get('id') == 'sidebar-footer'), len(children))
        children.insert(position, {'id':'automation-options','type':'block','size':{'px':40},
                                   'content':{'mod':'automations','props':{'mode':'sidebar'}}})
        changed = True
    return changed


def quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--uninstall', action='store_true')
    parser.add_argument('--no-start', action='store_true')
    args = parser.parse_args()
    home = Path.home()
    repo = Path(__file__).resolve().parents[2]
    destination = home / '.local/share/herdr-automations'
    app = Path(os.environ.get('HERDR_APP_HOME', home / '.config/herdr-app'))
    unit = home / '.config/systemd/user/herdr-automations.service'
    backup = app / 'backups' / ('automations-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True)
    layout = app / 'layouts/main-weed.json'
    if layout.exists():
        shutil.copy2(layout, backup / layout.name)
    mod = app / 'mods/automations'
    if mod.exists():
        shutil.copytree(mod, backup / 'automations')
    if unit.exists():
        shutil.copy2(unit, backup / unit.name)
    if args.uninstall:
        subprocess.run(['systemctl','--user','disable','--now',NAME],check=False)
        unit.unlink(missing_ok=True)
        if mod.exists(): shutil.rmtree(mod)
    else:
        if unit.exists(): subprocess.run(['systemctl','--user','stop',NAME],check=True)
        destination.mkdir(parents=True,exist_ok=True)
        for path in Path(__file__).parent.glob('*.py'):
            shutil.copy2(path,destination/path.name)
        shutil.copytree(repo/'mods/automations',mod,dirs_exist_ok=True)
        path_env = os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin')
        text = '\n'.join(['[Unit]','Description=Herdr local automation scheduler','After=default.target','',
            '[Service]','Type=simple',f'ExecStart={quote(sys.executable)} {quote(destination/"service.py")}',
            f'Environment={quote("PATH="+path_env)}','Restart=on-failure','RestartSec=3','TimeoutStopSec=5',
            'KillMode=control-group','UMask=0077','', '[Install]','WantedBy=default.target',''])
        atomic(unit,text)
    if layout.exists():
        tree = json.loads(layout.read_text())
        if layout_entry(tree,args.uninstall): atomic(layout,json.dumps(tree,ensure_ascii=False,indent=2)+'\n')
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    if not args.uninstall and not args.no_start:
        subprocess.run(['systemctl','--user','enable','--now',NAME],check=True)
    print(('Removed; history retained. ' if args.uninstall else 'Installed. ') + 'Backup: ' + str(backup))
    print('State retained at ~/.local/state/herdr-automations; agent terminals are never killed by uninstall.')

if __name__ == '__main__': main()
