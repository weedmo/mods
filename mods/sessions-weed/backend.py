#!/usr/bin/env python3
"""Persistent Herdr session catalog. No provider transcripts are moved or deleted."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid
import re
from functools import lru_cache

APP = Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app'))
HERE = Path(__file__).parent


@lru_cache(maxsize=1)
def resume_module():
    spec = importlib.util.spec_from_file_location('session_resume_helper', APP / 'mods/agent-resume/agent_resume.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def database(timeout=10):
    folder = APP / 'data/sessions-weed'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = folder / 'sessions.sqlite3'
    conn = sqlite3.connect(path, timeout=timeout)
    os.chmod(path, 0o600)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('''CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, host TEXT NOT NULL, agent TEXT NOT NULL,
          session TEXT NOT NULL, cwd TEXT NOT NULL, transcript TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '', custom_title TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          archived_at INTEGER, label TEXT NOT NULL, terminal TEXT,
          source_mtime INTEGER NOT NULL DEFAULT 0)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS session_spaces (
          session_id TEXT NOT NULL, space_id TEXT NOT NULL,
          PRIMARY KEY(session_id,space_id))''')
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def identity(host, agent, session, transcript):
    return hashlib.sha256(json.dumps([host, agent, session, transcript], ensure_ascii=False).encode()).hexdigest()


def save(conn, label, host='', terminal=None, title='', created=None, updated=None, mtime=0, space=None):
    # Use the existing hook's validator and launch-option allowlist at every boundary.
    helper = resume_module()
    label, problem = helper.parse_label({helper.LABEL: json.dumps(label)})
    if not label:
        raise ValueError(problem or 'Unsupported session')
    if not isinstance(host, str) or '/' in host or '\x00' in host or host.startswith('-'):
        raise ValueError('Invalid machine name')
    key = identity(host, label['agent'], label['session'], label['transcript'])
    now = int(time.time() * 1000)
    conn.execute('''INSERT INTO sessions
      (id,host,agent,session,cwd,transcript,title,created_at,updated_at,label,terminal,source_mtime)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        cwd=excluded.cwd,
        title=CASE WHEN excluded.title!='' THEN excluded.title ELSE sessions.title END,
        updated_at=MAX(sessions.updated_at,excluded.updated_at),
        label=CASE WHEN excluded.terminal IS NOT NULL OR sessions.terminal IS NULL
              THEN excluded.label ELSE sessions.label END,
        terminal=COALESCE(excluded.terminal,sessions.terminal),
        source_mtime=MAX(sessions.source_mtime,excluded.source_mtime)''',
        (key, host, label['agent'], label['session'], label['cwd'], label['transcript'],
         title[:240], created or label.get('at') or now, updated or label.get('at') or now,
         json.dumps(label), terminal, mtime))
    if space:
        link_space(conn, key, space)
    return key


def link_space(conn, key, space):
    if not isinstance(space, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', space):
        raise ValueError('Invalid space identifier')
    conn.execute('INSERT OR IGNORE INTO session_spaces(session_id,space_id) VALUES (?,?)', (key, space))


def capture(label, terminal, space=None):
    with database(timeout=1) as conn:
        return save(conn, label, terminal=terminal, space=space)


def first_text(value):
    if isinstance(value, str):
        return ' '.join(value.split())[:180]
    if isinstance(value, list):
        return ' '.join(first_text(v.get('text', '')) for v in value if isinstance(v, dict) and v.get('type') in ('text', 'input_text'))[:180]
    return ''


def read_transcript(path, agent):
    """Bounded prefix scan: never load an entire conversation into the UI process."""
    meta, title = {}, ''
    with path.open('rb') as stream:
        prefix = stream.read(131072)
    for line in prefix.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(event, dict):
            continue
        payload = event.get('payload')
        payload = payload if isinstance(payload, dict) else {}
        if agent == 'codex' and event.get('type') == 'session_meta':
            meta.update(session=payload.get('id'), cwd=payload.get('cwd'))
        if agent == 'claude':
            if event.get('sessionId'):
                meta['session'] = event['sessionId']
            if event.get('cwd'):
                meta['cwd'] = event['cwd']
        message = event.get('message') if agent == 'claude' else payload
        if isinstance(message, dict) and message.get('role') == 'user' and not title:
            text = first_text(message.get('content'))
            # Skip automatic setup blocks; a real prompt later in the prefix is better.
            if text and not text.startswith(('<', '#', '{')):
                title = text
    return meta, title


def scan_history(conn):
    helper = resume_module()
    roots = [('claude', Path(os.environ.get('CLAUDE_CONFIG_DIR', Path.home() / '.claude')) / 'projects'),
             ('codex', Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'sessions'),
             ('codex', Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'archived_sessions')]
    issues, imported = [], 0
    for agent, root in roots:
        if not root.is_dir():
            continue
        paths = root.glob('*/*.jsonl') if agent == 'claude' else root.rglob('*.jsonl')
        for path in paths:
            if path.name.startswith('agent-'):
                continue
            try:
                stat = path.stat()
                previous = conn.execute('SELECT source_mtime FROM sessions WHERE host=? AND agent=? AND transcript=?',
                                        ('', agent, str(path))).fetchone()
                if previous and previous['source_mtime'] == stat.st_mtime_ns:
                    continue
                meta, title = read_transcript(path, agent)
                if not helper.valid_session(meta.get('session')) or not meta.get('cwd'):
                    continue
                stamp = int(stat.st_mtime * 1000)
                label = dict(agent=agent, session=meta['session'], cwd=meta['cwd'], transcript=str(path),
                             pid=1, shell=1, at=stamp, args=[])
                save(conn, label, title=title, created=stamp, updated=stamp, mtime=stat.st_mtime_ns)
                imported += 1
            except (OSError, ValueError) as error:
                if len(issues) < 8:
                    issues.append(f'{path.name}: {error}')
    return imported, issues


def live_terminals(host=None):
    helper = resume_module()
    listed = helper.hc_json(['ls'])
    rows = listed.get('terminals', []) if isinstance(listed, dict) else listed
    from concurrent.futures import ThreadPoolExecutor
    issues = []
    def get(row):
        if row.get('state') != 'live':
            return None
        if host is not None and terminal_host(row) != host:
            return None
        try:
            return helper.hc_json(['get', row['address']], timeout=4)
        except helper.HcError as error:
            issues.append(str(error))
            return None
    with ThreadPoolExecutor(max_workers=8) as pool:
        return [t for t in pool.map(get, rows) if t], issues


def terminal_host(terminal):
    address = terminal.get('address', '')
    return address.rsplit('/', 1)[0] if '/' in address else ''


def terminal_agent(terminal):
    name = (terminal.get('foreground') or {}).get('name', '')
    return {'claude-code': 'claude', 'kiro-cli': 'kiro', 'kiro-cli-chat': 'kiro'}.get(name, name)


def sync_terminals(conn, terminals):
    helper = resume_module()
    for terminal in terminals:
        tags = terminal.get('labels') or {}
        space = tags.get('herdr.space')
        managed = tags.get('session-manager.id')
        if managed and space and conn.execute('SELECT 1 FROM sessions WHERE id=? AND host=?', (managed, terminal_host(terminal))).fetchone():
            link_space(conn, managed, space)
        label = helper.read_label(terminal.get('labels'))
        if label:
            save(conn, label, host=terminal_host(terminal), terminal=terminal['address'],
                 title=tags.get('where', ''), space=space)
        # Adopt exact local Claude process registry identity without guessing by cwd.
        if not label and not terminal_host(terminal) and terminal_agent(terminal) == 'claude':
            fg = terminal.get('foreground') or {}
            try:
                found = helper.claude_session_of(fg.get('pid'))
                if found:
                    session, cwd, transcript = found
                    label = dict(agent='claude', session=session, cwd=cwd, transcript=transcript,
                                 pid=fg['pid'], shell=terminal['pid'], args=helper.flat(helper.launch_flags('claude', fg.get('argv', [])[1:])))
                    save(conn, label, terminal=terminal['address'], space=space)
            except (OSError, TypeError, ValueError):
                pass


def matching_terminal(row, terminals):
    helper = resume_module()
    for terminal in terminals:
        if terminal_host(terminal) != row['host'] or terminal_agent(terminal) != row['agent']:
            continue
        label = helper.read_label(terminal.get('labels'))
        if (label and label['session'] == row['session'] and label['transcript'] == row['transcript']
                and label['pid'] == (terminal.get('foreground') or {}).get('pid')):
            return terminal['address']
        if terminal['address'] == row['terminal']:
            # Captured labels belong to a PID, so a newer agent in this terminal is not the old chat.
            saved = json.loads(row['label'])
            if saved.get('pid') == (terminal.get('foreground') or {}).get('pid'):
                return terminal['address']
        argv = (terminal.get('foreground') or {}).get('argv', [])
        if row['session'] in argv and any(v in argv for v in ('resume', '--resume', '--resume-id', '--conversation')):
            return terminal['address']
        if row['agent'] == 'pi' and '--session' in argv and row['transcript'] in argv:
            return terminal['address']
    return None


def catalog(conn, scan=True):
    _, issues = scan_history(conn) if scan else (0, [])
    try:
        terminals, live_issues = live_terminals()
        issues.extend(live_issues[:5])
        sync_terminals(conn, terminals)
    except Exception as error:
        terminals = []
        issues.append(f'Live status unavailable: {error}')
    rows = []
    memberships = {}
    for membership in conn.execute('SELECT session_id,space_id FROM session_spaces'):
        memberships.setdefault(membership['session_id'], []).append(membership['space_id'])
    for row in conn.execute('SELECT * FROM sessions ORDER BY updated_at DESC,id'):
        item = dict(row)
        item['space_ids'] = memberships.get(row['id'], [])
        item['title'] = item.pop('custom_title') or item['title'] or f"{item['agent']} · {Path(item['cwd']).name}"
        item['live_terminal'] = matching_terminal(row, terminals)
        item['available'] = bool(row['host']) or (Path(row['cwd']).is_dir() and Path(row['transcript']).is_file())
        item.pop('label')
        rows.append(item)
    return dict(sessions=rows, issues=issues)


def rename(conn, key, title):
    if not isinstance(title, str) or len(title) > 240 or '\x00' in title:
        raise ValueError('Name must be at most 240 characters')
    if conn.execute('UPDATE sessions SET custom_title=? WHERE id=?', (title.strip() or None, key)).rowcount != 1:
        raise ValueError('Session no longer exists')


def archive(conn, key, enabled):
    if type(enabled) is not bool:
        raise ValueError('Invalid archive state')
    if conn.execute('UPDATE sessions SET archived_at=? WHERE id=?',
                    (int(time.time() * 1000) if enabled else None, key)).rowcount != 1:
        raise ValueError('Session no longer exists')


def launch(conn, key, space=None):
    helper = resume_module()
    row = conn.execute('SELECT * FROM sessions WHERE id=?', (key,)).fetchone()
    if row is None:
        raise ValueError('Session no longer exists')
    space = space or 'sp' + uuid.uuid4().hex
    if not isinstance(space, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', space):
        raise ValueError('Invalid space identifier')
    terminals, issues = live_terminals(row['host'])
    # Missing host state must not authorize a second writer.
    if issues:
        raise ValueError('Cannot verify running sessions: ' + issues[0])
    address = matching_terminal(row, terminals)
    if address:
        return dict(terminal=address, existing=True)
    for term in terminals:
        if (terminal_host(term) == row['host'] and terminal_agent(term) == row['agent']
                and (term.get('foreground') or {}).get('cwd', term.get('cwd')) == row['cwd']
                and not helper.read_label(term.get('labels'))):
            raise ValueError('An untracked agent is running in this folder. Close it or wait for its session hook before resuming here.')
    if row['host']:
        helper.hc(['exec', '--on', row['host'], '--timeout', '8', '--', 'python3', '-c',
                   'import os,sys; assert os.path.isdir(sys.argv[1]), "Working folder missing"; assert os.path.isfile(sys.argv[2]), "Saved conversation missing"',
                   row['cwd'], row['transcript']], timeout=10)
    else:
        if not Path(row['cwd']).is_dir():
            raise ValueError('The working folder no longer exists')
        if not Path(row['transcript']).is_file():
            raise ValueError('The saved conversation no longer exists')
    label = json.loads(row['label'])
    label, problem = helper.parse_label({helper.LABEL: json.dumps(label)})
    if not label:
        raise ValueError(problem or 'Invalid saved session')
    if not row['host'] and helper.claim_holder(row['agent'], row['session']):
        raise ValueError('This session is already being resumed')
    # Serialize launches across window copies until the new terminal has a durable exact ID label.
    lock = helper.runtime_lock('session-manager-launch-' + key)
    if lock is None:
        raise ValueError('This session is already being resumed')
    try:
        terminals, issues = live_terminals(row['host'])
        if issues:
            raise ValueError('Cannot verify running sessions')
        address = matching_terminal(row, terminals)
        if address:
            return dict(terminal=address, existing=True)
        # A newly created terminal can still be starting its shell before its first hook.
        for terminal in terminals:
            tags = terminal.get('labels') or {}
            if tags.get('session-manager.id') == key:
                try:
                    recent = time.time() - float(tags.get('session-manager.started', 0)) < 15
                except ValueError:
                    recent = False
                if recent:
                    return dict(terminal=terminal['address'], existing=True)
        argv = helper.resume_argv(label)
        if row['agent'] == 'pi':
            argv = ['pi', '--session', row['transcript'], *helper.flat(helper.launch_flags('pi', label.get('args', [])))]
        # Bash stays alive after the agent exits. Literal argv avoids shell interpolation of paths/options.
        command = ['/bin/bash', '-ic', '"$@"; exec "$0" -i', '/bin/bash', *argv]
        raw = helper.hc(['run', '--bg', '--keep', '--no-parent', '--no-notify', '--cwd', row['cwd'],
                         *(['--on', row['host']] if row['host'] else []),
                         '--label', 'herdr.space=' + space,
                         '--label', 'herdr.tab=tb' + uuid.uuid4().hex,
                         '--label', 'session-manager.id=' + key,
                         '--label', 'session-manager.started=' + str(time.time()), '--json', '--', *command])
        launched = json.loads(raw)
        address = launched.get('address')
        if not address:
            raise ValueError('Core did not return a terminal address')
        conn.execute('UPDATE sessions SET terminal=? WHERE id=?', (address, key))
        link_space(conn, key, space)
        return dict(terminal=address, existing=False)
    finally:
        os.close(lock)


def main(request):
    with database() as conn:
        action = request.get('action', 'list')
        if action == 'list':
            return catalog(conn)
        if action == 'capture':
            return dict(id=save(conn, request['label'], host=request.get('host', ''), terminal=request.get('terminal')))
        if action == 'collect':
            terminals, issues = live_terminals()
            sync_terminals(conn, terminals)
            return dict(issues=issues)
        if action == 'rename':
            rename(conn, request['id'], request['title'])
        elif action in ('archive', 'restore'):
            archive(conn, request['id'], action == 'archive')
        elif action == 'resume':
            return launch(conn, request['id'], request.get('space'))
        else:
            raise ValueError('Unknown session action')
        return dict(ok=True)


if __name__ == '__main__':
    try:
        print(json.dumps(dict(ok=True, result=main(json.loads(sys.argv[1]))), ensure_ascii=False))
    except Exception as error:
        print(json.dumps(dict(ok=False, error=str(error)), ensure_ascii=False))
        sys.exit(1)
