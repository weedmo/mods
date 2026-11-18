#!/usr/bin/env python3
"""Versioning tests: pure helpers, then release.py -> update.py against a throwaway origin."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts'))
import versions as V  # noqa: E402


def sh(*cmd, cwd=None, env=None):
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if r.returncode:
        raise AssertionError(f'{cmd} failed:\n{r.stdout}\n{r.stderr}')
    return r.stdout


class Pure(unittest.TestCase):
    def test_bump(self):
        self.assertEqual(V.bump('1.2.3', 'patch'), '1.2.4')
        self.assertEqual(V.bump('1.2.3', 'minor'), '1.3.0')
        self.assertEqual(V.bump('1.2.3', 'major'), '2.0.0')
        self.assertEqual(V.bump('1.2.3', '1.10.0'), '1.10.0')
        with self.assertRaises(ValueError):
            V.bump('1.2.3', '1.2.3')
        with self.assertRaises(ValueError):
            V.bump('1.2.3', 'huge')

    def test_plan_bumps(self):
        before = {'a': '1.0.0', 'b': '1.0.0', 'c': '1.0.0'}
        after = {'a': '1.0.0', 'b': '1.1.0', 'c': '1.0.0', 'd': None}
        # a changed -> patch; b changed but raised by hand -> kept; c unchanged; d new -> 1.0.0
        self.assertEqual(V.plan_bumps(before, after, {'a', 'b', 'd'}), {'a': '1.0.1', 'd': '1.0.0'})

    def test_set_mod_version_keeps_nested(self):
        d = Path(tempfile.mkdtemp())
        (d / 'mods/x').mkdir(parents=True)
        (d / 'mods/x/mod.json').write_text('{"place":"none","cloned_from":{"name":"spaces","version":"0.1.10"}}')
        V.set_mod_version(d, 'x', '2.0.0')
        data = json.loads((d / 'mods/x/mod.json').read_text())
        self.assertEqual(data['version'], '2.0.0')
        self.assertEqual(data['cloned_from']['version'], '0.1.10')
        shutil.rmtree(d)


class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='herdr-mods-test-'))
        self.origin = self.tmp / 'origin.git'
        self.work = self.tmp / 'work'
        self.home = self.tmp / 'home'
        self.home.mkdir()
        sh('git', 'init', '-q', '--bare', '-b', 'main', str(self.origin))
        sh('git', 'clone', '-q', str(self.origin), str(self.work))
        for p in ['scripts/versions.py', 'scripts/release.py', 'scripts/update.py', 'scripts/install.py']:
            (self.work / p).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / p, self.work / p)
        for name in ['alpha', 'beta']:
            (self.work / f'mods/{name}').mkdir(parents=True)
            (self.work / f'mods/{name}/mod.json').write_text(json.dumps({'place': 'none', 'version': '1.0.0'}))
            (self.work / f'mods/{name}/main.js').write_text('// v1\n')
        (self.work / 'VERSION').write_text('1.0.0\n')
        (self.work / 'CHANGELOG.md').write_text('# Changelog\n\n## v1.0.0\n\nFirst.\n')
        (self.work / 'layouts').mkdir()
        (self.work / 'examples/themes').mkdir(parents=True)
        for f in ['keys.json', 'settings.json', 'programs.json']:
            (self.work / 'examples' / f).write_text('{}')
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'init')
        self.git('push', '-q', 'origin', 'main')
        self.env = {**os.environ, 'HOME': str(self.home), 'HERDR_MODS_REPO': str(self.origin),
                    'HERDR_APP_HOME': str(self.home / 'app'), 'PATH': '/usr/bin:/bin'}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def git(self, *args):
        env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}
        return sh('git', '-C', str(self.work), *args, env=env)

    def release(self, level):
        env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}
        return sh(sys.executable, str(self.work / 'scripts/release.py'), level, '--no-github', env=env)

    def update(self, *args):
        return sh(sys.executable, str(self.work / 'scripts/update.py'), '--no-switch', *args, env=self.env)

    def test_release_and_update(self):
        # First release tags the existing commit.
        out = self.release('1.0.0')
        self.assertIn('tag existing commit', out)
        self.assertIn('v1.0.0', sh('git', '--git-dir', str(self.origin), 'tag'))

        # Untracked local work must not leak into a release.
        (self.work / 'mods/scratch').mkdir()
        (self.work / 'mods/scratch/mod.json').write_text('{}')

        # Change alpha only -> alpha patch bump, beta unchanged.
        (self.work / 'mods/alpha/main.js').write_text('// v2\n')
        self.git('commit', '-q', '-am', 'feat: alpha change')
        self.git('push', '-q', 'origin', 'main')
        self.release('patch')
        show = lambda p: sh('git', '--git-dir', str(self.origin), 'show', f'v1.0.1:{p}')
        self.assertEqual(show('VERSION').strip(), '1.0.1')
        self.assertEqual(json.loads(show('mods/alpha/mod.json'))['version'], '1.0.1')
        self.assertEqual(json.loads(show('mods/beta/mod.json'))['version'], '1.0.0')
        self.assertIn('feat: alpha change', show('CHANGELOG.md'))
        self.assertNotIn('scratch', sh('git', '--git-dir', str(self.origin), 'ls-tree', '-r', '--name-only', 'v1.0.1'))

        # Update installs latest, records it, then reports up to date.
        self.update()
        record = json.loads((self.home / '.local/state/herdr-mods/installed.json').read_text())
        self.assertEqual(record['version'], '1.0.1')
        self.assertEqual(record['mods']['alpha'], '1.0.1')
        self.assertEqual((self.home / 'app/mods/alpha/main.js').read_text(), '// v2\n')
        self.assertIn('up to date', self.update())

        # Pinning an older release downgrades.
        self.update('--version', '1.0.0')
        self.assertEqual((self.home / 'app/mods/alpha/main.js').read_text(), '// v1\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
