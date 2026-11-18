#!/usr/bin/env python3
"""Version bookkeeping: the repository VERSION file and each mod's mod.json "version".

  python3 scripts/versions.py check   # every tracked mod and VERSION carry a semver version
  python3 scripts/versions.py list    # repo version and each mod's version
"""
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r'^(\d+)\.(\d+)\.(\d+)$')
FIRST = '1.0.0'


def parse(version):
    m = SEMVER.match(version or '')
    if not m:
        raise ValueError(f'not a semver version: {version!r}')
    return tuple(int(x) for x in m.groups())


def bump(version, level):
    """Next version for patch/minor/major, or an explicit X.Y.Z (must be newer)."""
    if SEMVER.match(level):
        if version and parse(level) <= parse(version):
            raise ValueError(f'{level} is not newer than {version}')
        return level
    major, minor, patch = parse(version)
    if level == 'patch':
        return f'{major}.{minor}.{patch + 1}'
    if level == 'minor':
        return f'{major}.{minor + 1}.0'
    if level == 'major':
        return f'{major + 1}.0.0'
    raise ValueError(f'unknown level: {level!r} (patch, minor, major or X.Y.Z)')


def git(repo, *args, check=True):
    r = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f'git {" ".join(args)}: {r.stderr.strip()}')
    return r.stdout


def repo_version(repo=REPO):
    path = Path(repo) / 'VERSION'
    return path.read_text().strip() if path.exists() else None


def tracked_mods(repo=REPO):
    """Mods whose mod.json is tracked by git (untracked work in progress is ignored)."""
    out = git(repo, 'ls-files', '--', 'mods/*/mod.json')
    return sorted({line.split('/')[1] for line in out.splitlines() if line.count('/') == 2})


def mod_version(repo, name):
    path = Path(repo) / 'mods' / name / 'mod.json'
    return json.loads(path.read_text()).get('version')


def set_mod_version(repo, name, version):
    """Set the top-level "version" (nested ones such as cloned_from.version are untouched)."""
    path = Path(repo) / 'mods' / name / 'mod.json'
    data = json.loads(path.read_text())
    data['version'] = version
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def mod_versions(repo=REPO):
    return {name: mod_version(repo, name) for name in tracked_mods(repo)}


def plan_bumps(before, after, changed):
    """Mod versions to write for a release.

    before:  {mod: version} at the previous release (empty for the first release)
    after:   {mod: version or None} now
    changed: mods with file changes since the previous release
    A mod with no version gets 1.0.0. A changed mod whose version was not raised by
    hand since the previous release gets a patch bump. Others keep their version.
    """
    plan = {}
    for name, version in after.items():
        if not version:
            plan[name] = FIRST
        elif name in changed and name in before and before[name] == version:
            plan[name] = bump(version, 'patch')
    return plan


def check(repo=REPO):
    errors = []
    version = repo_version(repo)
    if not version or not SEMVER.match(version):
        errors.append(f'VERSION: missing or not semver ({version!r})')
    for name, v in mod_versions(repo).items():
        if not v or not SEMVER.match(str(v)):
            errors.append(f'mods/{name}/mod.json: missing or not semver version ({v!r})')
    return errors


def main(argv):
    cmd = argv[1] if len(argv) > 1 else 'check'
    if cmd == 'list':
        print('repo', repo_version())
        for name, v in mod_versions().items():
            print(f'  {name:28} {v}')
        return 0
    if cmd == 'check':
        errors = check()
        for e in errors:
            print('ERROR', e)
        print('VERSIONS_OK' if not errors else f'{len(errors)} version error(s)')
        return 1 if errors else 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
