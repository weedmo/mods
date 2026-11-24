"""Unit tests for the Sessions catalog (mods/sessions-weed/backend.py).

Run: python3 -m unittest discover -s tests/sessions -v
Everything runs against a temporary HERDR_APP_HOME; no hc, network or real catalog is touched.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
MODS = REPO / 'mods'


def load_backend(app_home):
    os.environ['HERDR_APP_HOME'] = str(app_home)
    spec = importlib.util.spec_from_file_location('sessions_backend_under_test', MODS / 'sessions-weed/backend.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_jsonl(path, events):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(e) + '\n' for e in events))
    return path


def claude_events(session, cwd, prompt='fix the build'):
    return [{'type': 'user', 'sessionId': session, 'cwd': cwd, 'message': {'role': 'user', 'content': prompt}}]


def codex_events(session, cwd, source='cli', prompt='add a test'):
    return [{'type': 'session_meta', 'payload': {'id': session, 'cwd': cwd, 'source': source}},
            {'type': 'response_item', 'payload': {'role': 'user', 'content': [{'type': 'input_text', 'text': prompt}]}}]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.app = root / 'app'
        (self.app / 'mods').mkdir(parents=True)
        # The backend validates labels with the real agent-resume helper.
        (self.app / 'mods/agent-resume').symlink_to(MODS / 'agent-resume')
        self.env = mock.patch.dict(os.environ, {'XDG_RUNTIME_DIR': str(root / 'run')})
        self.env.start()
        (root / 'run').mkdir()
        self.b = load_backend(self.app)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def rows(self, **where):
        with self.b.database() as conn:
            rows = [dict(r) for r in conn.execute('SELECT * FROM sessions')]
        return [r for r in rows if all(r[k] == v for k, v in where.items())]


class ReadTranscript(Base):
    def test_claude_and_codex_are_parsed(self):
        d = Path(self.tmp.name)
        meta, title = self.b.read_transcript(write_jsonl(d / 'c.jsonl', claude_events('a1b2c3d4-0000', '/w')), 'claude')
        self.assertEqual((meta['session'], meta['cwd'], title), ('a1b2c3d4-0000', '/w', 'fix the build'))
        meta, title = self.b.read_transcript(write_jsonl(d / 'x.jsonl', codex_events('01a1-codex-id', '/w')), 'codex')
        self.assertEqual((meta['session'], title, meta.get('skip')), ('01a1-codex-id', 'add a test', None))

    def test_codex_subagent_and_exec_are_skipped(self):
        d = Path(self.tmp.name)
        for source in ({'subagent': {'thread_spawn': {}}}, 'exec'):
            meta, _ = self.b.read_transcript(write_jsonl(d / 's.jsonl', codex_events('01a1-sub-id', '/w', source)), 'codex')
            self.assertTrue(meta.get('skip'), source)


class RemoteScanner(Base):
    """The scanner source is shipped over `hc exec`; run it here as a separate process."""

    def run_scanner(self, home, known):
        result = subprocess.run([sys.executable, '-I', '-c', self.b.remote_source()], input=json.dumps(known),
                                capture_output=True, text=True, timeout=30,
                                env={'HOME': str(home), 'PATH': os.environ.get('PATH', '')})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_reports_new_skipped_and_missing(self):
        home = Path(self.tmp.name) / 'remote-home'
        claude = write_jsonl(home / '.claude/projects/-w/aaaa1111-2222.jsonl', claude_events('aaaa1111-2222', '/w'))
        write_jsonl(home / '.claude/projects/-w/agent-ignored.jsonl', claude_events('bbbb1111-2222', '/w'))
        codex = write_jsonl(home / '.codex/sessions/2026/11/20/rollout-1.jsonl', codex_events('01a1-codex-id', '/w'))
        sub = write_jsonl(home / '.codex/sessions/2026/11/20/rollout-2.jsonl',
                          codex_events('01a1-sub-id', '/w', {'subagent': {}}))
        unchanged = write_jsonl(home / '.codex/archived_sessions/rollout-3.jsonl', codex_events('01a1-old-id', '/w'))
        gone = str(home / '.claude/projects/-w/never-written.jsonl')
        report = self.run_scanner(home, {str(unchanged): unchanged.stat().st_mtime_ns, gone: 0})
        found = {Path(f['transcript']).name: f for f in report['found']}
        self.assertEqual(set(found), {claude.name, codex.name, sub.name})
        self.assertTrue(found[sub.name]['skip'])
        self.assertEqual(found[codex.name]['session'], '01a1-codex-id')
        self.assertEqual(report['missing'], [gone])


class ScanRemote(Base):
    def fake_fetch(self, reports):
        calls = []

        def fetch(host, known):
            calls.append((host, dict(known)))
            return reports[host], None
        return fetch, calls

    def test_imports_skips_and_marks_missing(self):
        t = '/home/u/.codex/sessions/r1.jsonl'
        reports = {'vn': dict(found=[
            dict(agent='codex', transcript=t, mtime_ns=5_000_000, session='01a1-codex-id', cwd='/home/u/p', title='hi', skip=False),
            dict(agent='codex', transcript='/home/u/.codex/sessions/sub.jsonl', mtime_ns=7, session='01a1-sub', cwd='/p', title='', skip=True),
        ], missing=[])}
        fetch, calls = self.fake_fetch(reports)
        with mock.patch.object(self.b, 'remote_machines', return_value=['vn']), mock.patch.object(self.b, 'fetch_remote', fetch):
            self.assertEqual(self.b.scan_remote(force=True), {'scanned': {'vn': 1}})
            row, = self.rows(host='vn')
            self.assertEqual((row['agent'], row['session'], row['title'], row['transcript_missing']),
                             ('codex', '01a1-codex-id', 'hi', 0))
            # The next scan tells the machine what it already has, skipped transcripts included.
            reports['vn'] = dict(found=[], missing=[t])
            self.b.scan_remote(force=True)
            self.assertEqual(calls[-1][1], {t: 5_000_000, '/home/u/.codex/sessions/sub.jsonl': 7})
            self.assertEqual(self.rows(host='vn')[0]['transcript_missing'], 1)
            # A transcript that shows up again (first message written) is resumable again.
            reports['vn'] = dict(found=[dict(agent='codex', transcript=t, mtime_ns=9_000_000,
                                             session='01a1-codex-id', cwd='/home/u/p', title='hi')], missing=[])
            self.b.scan_remote(force=True)
            self.assertEqual(self.rows(host='vn')[0]['transcript_missing'], 0)

    def test_respects_ttl_unless_forced(self):
        fetch, calls = self.fake_fetch({'vn': dict(found=[], missing=[])})
        with mock.patch.object(self.b, 'remote_machines', return_value=['vn']), mock.patch.object(self.b, 'fetch_remote', fetch):
            self.b.scan_remote()
            self.b.scan_remote()
            self.assertEqual(len(calls), 1)
            self.b.scan_remote(force=True)
            self.assertEqual(len(calls), 2)

    def test_unreachable_machine_is_reported_not_raised(self):
        with mock.patch.object(self.b, 'remote_machines', return_value=['vn']), \
                mock.patch.object(self.b, 'fetch_remote', return_value=(None, 'vn: timed out')):
            self.assertEqual(self.b.scan_remote(force=True), {'scanned': {'vn': 'vn: timed out'}})
        with self.b.database() as conn:
            self.assertEqual(self.b.remote_issues(conn), ['Remote history: vn: timed out'])


class Catalog(Base):
    def save_remote(self, agent, session, transcript, missing=0):
        with self.b.database() as conn:
            key = self.b.save(conn, dict(agent=agent, session=session, cwd='/home/u/p', transcript=transcript,
                                         pid=1, shell=1, at=1, args=['--dangerously-skip-permissions'] if agent == 'claude' else []),
                              host='vn')
            conn.execute('UPDATE sessions SET transcript_missing=? WHERE id=?', (missing, key))
        return key

    def listing(self, terminals=()):
        with mock.patch.object(self.b, 'live_terminals', return_value=(list(terminals), [])), \
                mock.patch.object(self.b, 'start_remote_scan'):
            with self.b.database() as conn:
                return {r['session']: r for r in self.b.catalog(conn)['sessions']}

    def test_missing_remote_transcript_is_unavailable_until_live(self):
        self.save_remote('claude', 'aaaa1111-2222', '/home/u/.claude/projects/-p/aaaa1111-2222.jsonl', missing=1)
        self.assertFalse(self.listing()['aaaa1111-2222']['available'])

    def test_resume_command(self):
        self.save_remote('claude', 'aaaa1111-2222', '/home/u/.claude/projects/-p/aaaa1111-2222.jsonl')
        self.save_remote('codex', '01a1-codex-id', '/home/u/.codex/sessions/r.jsonl')
        rows = self.listing()
        self.assertEqual(rows['aaaa1111-2222']['resume_command'],
                         "cd '/home/u/p' && claude --resume aaaa1111-2222 --dangerously-skip-permissions")
        self.assertEqual(rows['01a1-codex-id']['resume_command'], "cd '/home/u/p' && codex resume 01a1-codex-id")

    def test_npm_codex_terminal_counts_as_running(self):
        transcript = '/home/u/.codex/sessions/r.jsonl'
        self.save_remote('codex', '01a1-codex-id', transcript, missing=1)
        label = dict(agent='codex', session='01a1-codex-id', cwd='/home/u/p', transcript=transcript, pid=4242, shell=10)
        terminal = {'address': 'vn/t3d', 'state': 'live', 'pid': 10,
                    'foreground': {'name': 'node', 'pid': 4200, 'argv': ['node', '/usr/local/bin/codex']},
                    'labels': {'agent-resume': json.dumps(label)}}
        row = self.listing([terminal])['01a1-codex-id']
        self.assertEqual(row['live_terminal'], 'vn/t3d')
        self.assertTrue(row['available'])

    def test_resumed_npm_codex_matches_by_argv(self):
        self.save_remote('codex', '01a1-codex-id', '/home/u/.codex/sessions/r.jsonl')
        terminal = {'address': 'vn/t3f', 'state': 'live', 'pid': 11, 'labels': {},
                    'foreground': {'name': 'node', 'pid': 12, 'argv': ['node', '/usr/local/bin/codex', 'resume', '01a1-codex-id']}}
        self.assertEqual(self.listing([terminal])['01a1-codex-id']['live_terminal'], 'vn/t3f')


class CloseAndArchive(Base):
    def save(self, session, terminal, shell=11, at=1, pid=12):
        with self.b.database() as conn:
            return self.b.save(conn, dict(agent='codex', session=session, cwd='/home/u/p',
                                          transcript=f'/home/u/.codex/sessions/{session}.jsonl',
                                          pid=pid, shell=shell, at=at, args=[]), host='vn', terminal=terminal)

    def archive(self, terminals, addresses):
        def get(args, timeout=10):
            if args[1] not in terminals:
                raise self.b.resume_module().HcError('no such terminal')
            return terminals[args[1]]
        with mock.patch.object(self.b.resume_module(), 'hc_json', side_effect=get):
            with self.b.database() as conn:
                return self.b.archive_terminals(conn, addresses)['archived']

    def archived(self):
        return {r['session'] for r in self.rows() if r['archived_at']}

    def test_archives_only_the_conversation_running_in_the_terminal(self):
        running = self.save('01a1-running', 'vn/t3f')
        self.save('01a1-earlier', 'vn/t3f', pid=7)  # an agent that ran here before and exited
        self.save('01a1-elsewhere', 'vn/t40')
        terminal = {'address': 'vn/t3f', 'state': 'live', 'pid': 11, 'labels': {},
                    'foreground': {'name': 'codex', 'pid': 12, 'argv': ['codex', 'resume', '01a1-running']}}
        self.assertEqual(self.archive({'vn/t3f': terminal}, ['vn/t3f', 'vn/t3f']), [running])
        self.assertEqual(self.archived(), {'01a1-running'})

    def test_exited_agent_archives_the_last_conversation_of_the_same_shell(self):
        self.save('01a1-old', 'vn/t3f', at=1)
        last = self.save('01a1-last', 'vn/t3f', at=2)
        shell = {'address': 'vn/t3f', 'state': 'live', 'pid': 11, 'labels': {}, 'foreground': {'name': 'bash', 'pid': 11, 'argv': ['bash']}}
        self.assertEqual(self.archive({'vn/t3f': shell}, ['vn/t3f']), [last])

    def test_reused_address_or_closed_terminal_archives_nothing(self):
        self.save('01a1-old', 'vn/t3f')
        reused = {'address': 'vn/t3f', 'state': 'live', 'pid': 99, 'labels': {}, 'foreground': {'name': 'bash', 'pid': 99, 'argv': ['bash']}}
        self.assertEqual(self.archive({'vn/t3f': reused}, ['vn/t3f']), [])
        self.assertEqual(self.archive({}, ['vn/t3f']), [])
        self.assertEqual(self.archived(), set())
        with self.assertRaises(ValueError):
            self.archive({}, ['--on'])


class Ui(unittest.TestCase):
    def test_copy_command_button_writes_clipboard(self):
        source = (MODS / 'sessions-weed/main.js').read_text()
        self.assertIn('"Copy command"', source)
        self.assertIn('cx.write_to_clipboard(row.resume_command)', source)
        result = subprocess.run(['node', '--check', str(MODS / 'sessions-weed/main.js')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class RemoteInstaller(unittest.TestCase):
    """Runs the installer's remote half locally against a fake HOME."""

    def run_remote(self, home, dry):
        spec = importlib.util.spec_from_file_location('install_remote_under_test', MODS / 'agent-resume/install_remote.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = subprocess.run([sys.executable, '-I', '-c', module.REMOTE, '1' if dry else '0'], input='print("hook")\n',
                                capture_output=True, text=True, timeout=30, env={'HOME': str(home)})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_install_is_idempotent_and_keeps_existing_hooks(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / '.claude').mkdir()
            (home / '.codex').mkdir()
            existing = {'hooks': {'SessionStart': [{'hooks': [{'type': 'command', 'command': 'bash other.sh'}]}]}, 'model': 'x'}
            (home / '.claude/settings.json').write_text(json.dumps(existing))
            self.assertEqual(self.run_remote(home, dry=True)['claude'], 'would add')
            self.assertEqual(json.loads((home / '.claude/settings.json').read_text()), existing)
            first = self.run_remote(home, dry=False)
            self.assertEqual((first['script'], first['claude'], first['codex']), ('installed', 'added', 'added'))
            second = self.run_remote(home, dry=False)
            self.assertEqual((second['script'], second['claude'], second['codex']), ('unchanged', 'already installed', 'already installed'))
            settings = json.loads((home / '.claude/settings.json').read_text())
            commands = [h['command'] for g in settings['hooks']['SessionStart'] for h in g['hooks']]
            self.assertEqual(commands[0], 'bash other.sh')
            self.assertTrue(commands[1].endswith("agent_resume.py' hook claude"))
            self.assertEqual(settings['model'], 'x')
            self.assertTrue(list((home / '.claude').glob('settings.json.bak-agent-resume-*')))


if __name__ == '__main__':
    unittest.main()
