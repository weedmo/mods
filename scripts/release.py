#!/usr/bin/env python3
"""Release this repository: bump versions, changelog, commit, tag, push, GitHub Release.

  python3 scripts/release.py patch|minor|major|X.Y.Z [--dry-run]

Works in a temporary worktree of origin/main, so local uncommitted work is never
included or touched. Changed mods (files differing from the previous tag) get a patch
bump unless their mod.json version was already raised by hand; mods without a version
get 1.0.0. If VERSION already equals the target and that tag does not exist yet (the
first release), the current origin/main is tagged as-is.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import versions as V  # noqa: E402

REPO = V.REPO


def run(*cmd, cwd=None):
    print('$', ' '.join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def last_tag(wt):
    r = subprocess.run(['git', '-C', str(wt), 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD'],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def versions_at(wt, ref):
    """{mod: version} as of a git ref."""
    out = {}
    files = V.git(wt, 'ls-tree', '-r', '--name-only', ref, '--', 'mods').splitlines()
    for path in files:
        parts = path.split('/')
        if len(parts) == 3 and parts[2] == 'mod.json':
            try:
                out[parts[1]] = json.loads(V.git(wt, 'show', f'{ref}:{path}')).get('version')
            except json.JSONDecodeError:
                out[parts[1]] = None
    return out


def changed_mods(wt, ref):
    names = V.git(wt, 'diff', '--name-only', f'{ref}..HEAD', '--', 'mods').splitlines()
    return {p.split('/')[1] for p in names if p.count('/') >= 2}


def notes_for(wt, ref, new, before, after):
    lines = [f'## v{new}', '']
    rows = [(n, before.get(n), v) for n, v in sorted(after.items()) if before.get(n) != v]
    if rows:
        lines += ['### Mods', '', '| mod | from | to |', '| --- | --- | --- |']
        lines += [f'| `{n}` | {b or "new"} | {a} |' for n, b, a in rows]
        lines.append('')
    log = V.git(wt, 'log', '--no-merges', '--format=- %s', f'{ref}..HEAD' if ref else 'HEAD').strip()
    if log:
        lines += ['### Changes', '', log, '']
    return '\n'.join(lines) + '\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('level', help='patch, minor, major or X.Y.Z')
    ap.add_argument('--dry-run', action='store_true', help='show the plan, change nothing')
    ap.add_argument('--no-github', action='store_true', help='skip creating the GitHub Release')
    args = ap.parse_args()

    run('git', '-C', str(REPO), 'fetch', '--tags', 'origin')
    wt = Path(tempfile.mkdtemp(prefix='herdr-mods-release-'))
    shutil.rmtree(wt)
    run('git', '-C', str(REPO), 'worktree', 'add', '--detach', str(wt), 'origin/main')
    try:
        ref = last_tag(wt)
        current = V.repo_version(wt)
        if ref:
            new = V.bump(ref[1:], args.level)
        elif V.SEMVER.match(args.level):
            new = args.level
        else:
            new = V.bump(current or '0.0.0', args.level)
        if V.git(wt, 'tag', '-l', f'v{new}').strip():
            sys.exit(f'ERROR: tag v{new} already exists')

        before = versions_at(wt, ref) if ref else {}
        after_now = V.mod_versions(wt)
        changed = changed_mods(wt, ref) if ref else set(after_now)
        plan = V.plan_bumps(before, after_now, changed)
        after = {**after_now, **plan}
        tag_only = current == new and not plan
        notes = notes_for(wt, ref, new, before, after)

        print(f'\nprevious: {ref or "none"}  ->  v{new}' + ('  (tag existing commit)' if tag_only else ''))
        for name, v in sorted(plan.items()):
            print(f'  bump {name}: {after_now[name] or "-"} -> {v}')
        print('\n' + notes)
        if args.dry_run:
            print('dry run: nothing changed')
            return

        if not tag_only:
            (wt / 'VERSION').write_text(new + '\n')
            for name, v in plan.items():
                V.set_mod_version(wt, name, v)
            log = wt / 'CHANGELOG.md'
            old = log.read_text() if log.exists() else '# Changelog\n\n'
            head, _, rest = old.partition('\n\n')
            log.write_text(f'{head}\n\n{notes}\n{rest}'.rstrip('\n') + '\n')
        errors = V.check(wt)
        if errors:
            sys.exit('ERROR: ' + '; '.join(errors))
        if not tag_only:
            run('git', 'add', 'VERSION', 'CHANGELOG.md', 'mods', cwd=wt)
            run('git', 'commit', '-q', '-m', f'chore: release v{new}', cwd=wt)
        run('git', 'tag', '-a', f'v{new}', '-m', f'v{new}', cwd=wt)
        run('git', 'push', 'origin', 'HEAD:main', cwd=wt)
        run('git', 'push', 'origin', f'v{new}', cwd=wt)
        notes_file = wt / '.release-notes.md'
        notes_file.write_text(notes)
        if not args.no_github:
            run('gh', 'release', 'create', f'v{new}', '--title', f'v{new}', '--notes-file', str(notes_file), cwd=wt)
        print(f'\nreleased v{new}. Update your checkout with: git -C {REPO} pull --ff-only')
    finally:
        subprocess.run(['git', '-C', str(REPO), 'worktree', 'remove', '--force', str(wt)], capture_output=True)


if __name__ == '__main__':
    main()
