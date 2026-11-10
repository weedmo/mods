#!/usr/bin/env python3
"""Apply the whole saved Herdr setup: mods, layout, shortcuts, settings, programs, themes.

Existing files are backed up first. keys.json, settings.json and programs.json are
deep-merged: entries saved in this repository win, other local entries are kept.
Use --replace to overwrite those three files instead of merging.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
home = Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app'))
SKIP = {'jsconfig.json'}


def merge(base, update):
    if not isinstance(base, dict) or not isinstance(update, dict):
        return update
    out = dict(base)
    for key, value in update.items():
        out[key] = merge(out.get(key), value)
    return out


def write_json(path, data):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    tmp.replace(path)


def copy_tree(src, dst):
    for path in src.rglob('*'):
        if path.is_file() and path.name not in SKIP and not path.name.endswith('.d.ts') \
                and '__pycache__' not in path.parts:
            target = dst / path.relative_to(src)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--replace', action='store_true', help='overwrite keys/settings/programs instead of merging')
    parser.add_argument('--with-automations', action='store_true', help='also install the automation service')
    parser.add_argument('--with-statusline', action='store_true', help='copy the usage statusline script to ~/.local/bin')
    parser.add_argument('--no-switch', action='store_true', help='do not switch the open window to main-weed')
    args = parser.parse_args()

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = home / 'backups' / f'setup-{stamp}'
    backup.mkdir(parents=True, exist_ok=True)
    for name in ['mods', 'layouts', 'themes']:
        if (home / name).exists():
            shutil.copytree(home / name, backup / name, dirs_exist_ok=True)
    for name in ['keys.json', 'settings.json', 'programs.json']:
        if (home / name).exists():
            shutil.copy2(home / name, backup / name)
    print('backup', backup)

    mods = sorted(p.name for p in (repo / 'mods').iterdir() if p.is_dir())
    for name in mods:
        copy_tree(repo / 'mods' / name, home / 'mods' / name)
    print('mods', len(mods))

    (home / 'layouts').mkdir(parents=True, exist_ok=True)
    for path in (repo / 'layouts').glob('*.json'):
        shutil.copy2(path, home / 'layouts' / path.name)
    copy_tree(repo / 'examples/themes', home / 'themes')
    print('layouts, themes copied')

    for name in ['keys.json', 'settings.json', 'programs.json']:
        saved = json.loads((repo / 'examples' / name).read_text())
        live = home / name
        current = json.loads(live.read_text()) if live.exists() and not args.replace else {}
        write_json(live, merge(current, saved))
        print(name, 'replaced' if args.replace else 'merged')

    if args.with_statusline:
        target = Path.home() / '.local/bin/herdr-statusline-tee.sh'
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo / 'scripts/herdr-statusline-tee.sh', target)
        target.chmod(0o755)
        print('statusline', target)

    if args.with_automations:
        subprocess.run([sys.executable, str(repo / 'scripts/herdr-automations/install.py')], check=True)

    running = shutil.which('herdr-app') and subprocess.run(
        ['herdr-app', 'status'], capture_output=True).returncode == 0
    if not args.no_switch and running:
        subprocess.run(['herdr-app', 'do', 'layout.switch', '{"name":"main-weed"}'], check=False)
    elif not args.no_switch:
        # App closed: preselect the layout and skip the first-run welcome so the
        # next launch opens straight into main-weed.
        shared = home / 'shared.json'
        state = json.loads(shared.read_text()) if shared.exists() else {}
        if shared.exists():
            shutil.copy2(shared, backup / 'shared.json')
        state.update({'layout': 'main-weed', 'frame.welcomed': 'finished'})
        write_json(shared, state)
        print('shared.json: layout=main-weed, welcome skipped')


if __name__ == '__main__':
    main()
