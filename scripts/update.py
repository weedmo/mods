#!/usr/bin/env python3
"""Install a released version of these mods (latest tag by default).

  python3 scripts/update.py                  # this PC: latest release, if newer than installed
  python3 scripts/update.py --check          # show installed vs latest and changed mods, install nothing
  python3 scripts/update.py --version 1.2.0  # a specific release (also downgrades)
  python3 scripts/update.py --on vn_server   # another PC through hc (repeatable)
  python3 scripts/update.py --all-machines   # every connected hc machine

Other arguments go to install.py (e.g. --no-switch, --with-automations).
The release is fetched into ~/.cache/herdr-mods (independent of any checkout) and
its install.py runs from there; that records the installed version in
~/.local/state/herdr-mods/installed.json.
"""
import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

URL = os.environ.get('HERDR_MODS_REPO', 'https://github.com/weedmo/mods.git')
CACHE = Path.home() / '.cache/herdr-mods'
BARE = CACHE / 'repo.git'
RECORD = Path.home() / '.local/state/herdr-mods/installed.json'
SEMVER = re.compile(r'^v(\d+)\.(\d+)\.(\d+)$')


def git(*args):
    return subprocess.run(['git', '--git-dir', str(BARE), *args], check=True, capture_output=True, text=True).stdout


def fetch():
    CACHE.mkdir(parents=True, exist_ok=True)
    if not BARE.exists():
        subprocess.run(['git', 'clone', '-q', '--bare', URL, str(BARE)], check=True)
    git('fetch', '-q', '--prune', '--tags', '--force', 'origin', '+refs/heads/*:refs/heads/*')


def releases():
    tags = [t for t in git('tag', '-l', 'v*').split() if SEMVER.match(t)]
    return sorted(tags, key=lambda t: tuple(int(x) for x in SEMVER.match(t).groups()))


def mod_versions(tag):
    out = {}
    for path in git('ls-tree', '-r', '--name-only', tag, '--', 'mods').splitlines():
        parts = path.split('/')
        if len(parts) == 3 and parts[2] == 'mod.json':
            try:
                out[parts[1]] = json.loads(git('show', f'{tag}:{path}')).get('version')
            except json.JSONDecodeError:
                out[parts[1]] = None
    return out


def export(tag):
    dest = CACHE / 'src' / tag
    if not dest.exists():
        data = subprocess.run(['git', '--git-dir', str(BARE), 'archive', '--format=tar', tag],
                              check=True, capture_output=True).stdout
        tmp = dest.with_name(dest.name + '.tmp')
        shutil.rmtree(tmp, ignore_errors=True)
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            tar.extractall(tmp, filter='data') if hasattr(tarfile, 'data_filter') else tar.extractall(tmp)
        tmp.rename(dest)
    return dest


def update_here(args, rest):
    fetch()
    tags = releases()
    if not tags:
        sys.exit('no releases (v* tags) yet')
    target = f'v{args.version.lstrip("v")}' if args.version else tags[-1]
    if target not in tags:
        sys.exit(f'no release {target}; available: {", ".join(tags)}')
    record = json.loads(RECORD.read_text()) if RECORD.exists() else {}
    installed = record.get('version')
    print(f'installed: {installed or "unknown"}   target: {target[1:]}   latest: {tags[-1][1:]}')
    new = mod_versions(target)
    old = record.get('mods', {})
    for name in sorted(set(new) | set(old)):
        if new.get(name) != old.get(name):
            print(f'  {name:28} {old.get(name) or "-":>8} -> {new.get(name) or "removed"}')
    if args.check:
        return
    if installed == target[1:] and not args.force:
        print('up to date')
        return
    src = export(target)
    subprocess.run([sys.executable, str(src / 'scripts/install.py'), *rest], check=True)


def update_remote(machines, args, rest):
    me = Path(__file__).resolve()
    forward = [*(['--version', args.version] if args.version else []), *(['--check'] if args.check else []),
               *(['--force'] if args.force else []), *rest]
    failed = []
    for m in machines:
        print(f'\n== {m}')
        with open(me, 'rb') as f:
            w = subprocess.run(['hc', 'file', 'write', '--on', m, '.cache/herdr-mods/update.py'], stdin=f)
        r = w.returncode or subprocess.run(['hc', 'exec', '--on', m, '--timeout', '600', '--',
                                            'python3', '.cache/herdr-mods/update.py', *forward]).returncode
        if r:
            failed.append(m)
    if failed:
        sys.exit(f'failed on: {", ".join(failed)}')


def connected_machines():
    out = subprocess.run(['hc', 'machine', 'ls', '--json'], check=True, capture_output=True, text=True).stdout
    return [m['name'] for m in json.loads(out).get('machines', []) if m.get('state') == 'connected' and not m.get('temporary')]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--version', help='release to install (default: latest)')
    ap.add_argument('--check', action='store_true', help='show what would change, install nothing')
    ap.add_argument('--force', action='store_true', help='reinstall even if already at that version')
    ap.add_argument('--on', action='append', default=[], metavar='MACHINE', help='run on an hc machine instead')
    ap.add_argument('--all-machines', action='store_true', help='run on every connected hc machine')
    args, rest = ap.parse_known_args()
    machines = connected_machines() if args.all_machines else args.on
    if machines:
        update_remote(machines, args, rest)
    else:
        update_here(args, rest)


if __name__ == '__main__':
    main()
