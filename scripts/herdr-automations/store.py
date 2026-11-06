"""Service-owned SQLite state. Durable intents precede external effects."""
import json
import hashlib
import sqlite3
import time
import uuid
from pathlib import Path
import schedule

ACTIVE = ('queued', 'prechecking', 'dispatching', 'running', 'blocked', 'unknown')
FINAL = ('succeeded', 'failed', 'interrupted', 'cancelled', 'skipped_precheck', 'skipped_missed', 'skipped_overlap', 'skipped_unavailable')

def encode(x):
    return json.dumps(x, ensure_ascii=False, separators=(',', ':'))

def definition(d):
    if not isinstance(d, dict):
        raise ValueError('정의가 객체여야 합니다.')
    result = {}
    for key, maximum in [('name', 160), ('cwd', 4096), ('prompt', 32000)]:
        value = d.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > maximum or '\0' in value:
            raise ValueError(f'{key}: 비어 있지 않은 텍스트가 필요합니다 (최대 {maximum}자).')
        result[key] = value.strip()
    path = Path(result['cwd']).expanduser()
    if not path.is_absolute() or not path.is_dir():
        raise ValueError('이 PC에 있는 절대 폴더 경로를 선택하세요.')
    result['cwd'] = str(path.resolve())
    if d.get('agent') not in ('claude', 'codex'):
        raise ValueError('Claude 또는 Codex를 선택하세요.')
    if d.get('machine') is not None:
        raise ValueError('v1은 로컬 PC만 지원합니다.')
    result['agent'] = d['agent']
    result['schedule'] = schedule.validate(d.get('schedule'))
    enabled = d.get('enabled', False)
    if type(enabled) is not bool:
        raise ValueError('enabled는 boolean이어야 합니다.')
    result['enabled'] = enabled
    grace = d.get('graceMinutes', 15)
    if type(grace) is not int or not 0 <= grace <= 1440:
        raise ValueError('유예 시간은 0~1440분입니다.')
    result['graceMinutes'] = grace
    pre = d.get('precheck') or {}
    if not isinstance(pre, dict):
        raise ValueError('precheck가 객체여야 합니다.')
    command, timeout = pre.get('command', ''), pre.get('timeout', 60)
    if not isinstance(command, str) or len(command) > 8000 or '\0' in command:
        raise ValueError('precheck는 8000자 이하 명령이어야 합니다.')
    if type(timeout) is not int or not 1 <= timeout <= 600:
        raise ValueError('precheck 제한 시간은 1~600초입니다.')
    result['precheck'] = {'command': command.strip(), 'timeout': timeout}
    return result

class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        version = self.db.execute('PRAGMA user_version').fetchone()[0]
        if version not in (0, 1):
            raise RuntimeError('지원하지 않는 DB 버전입니다. 새 서비스를 사용하세요.')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS automations(id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
            data TEXT NOT NULL, next REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, automation_id TEXT NOT NULL,
            dedupe TEXT UNIQUE NOT NULL, phase TEXT NOT NULL, created REAL NOT NULL, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS runs_auto ON runs(automation_id, created DESC);
          CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, op TEXT NOT NULL, result TEXT NOT NULL);
          PRAGMA user_version=1;
        ''')

    def close(self):
        self.db.close()

    def get(self, id):
        row = self.db.execute('SELECT * FROM automations WHERE id=?', (id,)).fetchone()
        if not row:
            raise ValueError('자동화를 찾을 수 없습니다.')
        return {**json.loads(row['data']), 'id': id, 'revision': row['revision'],
                'nextRunAt': row['next'], 'archived': bool(row['archived'])}

    def list(self):
        return [self.get(row[0]) for row in self.db.execute('SELECT id FROM automations WHERE archived=0 ORDER BY rowid DESC')]

    def cached(self, key, op):
        if not isinstance(key, str) or not 8 <= len(key) <= 160:
            raise ValueError('고유 requestId가 필요합니다 (8~160자).')
        row = self.db.execute('SELECT * FROM requests WHERE id=?', (key,)).fetchone()
        if row:
            if row['op'] != op:
                raise ValueError('requestId가 다른 요청에 사용되었습니다.')
            result = json.loads(row['result'])
            if result.get('_ref') == 'automation':
                return self.get(result['id'])
            if result.get('_ref') == 'run':
                try:
                    return self.run(result['id'])
                except ValueError:
                    return {'id': result['id'], 'phase': 'retained_request', 'message': '이미 접수된 실행입니다. 상세 이력은 정리되었습니다.'}
            return result

    def remember(self, key, op, value):
        self.db.execute('INSERT INTO requests VALUES(?,?,?)', (key, op, encode(value)))

    def save(self, d, id=None, revision=None, request_id=None, now=None):
        now = time.time() if now is None else now
        data = definition(d)
        digest = hashlib.sha256(encode({'data': data, 'revision': revision}).encode()).hexdigest()
        op = ('create:' if id is None else 'update:' + id + ':') + digest
        old_result = self.cached(request_id, op)
        if old_result is not None:
            return old_result
        old = self.get(id) if id else None
        if old and (old['revision'] != revision or old['archived']):
            raise ValueError('다른 화면에서 변경되었습니다. 새로고침 후 다시 편집하세요.')
        if not old and len(self.list()) >= 200:
            raise ValueError('활성 정의는 최대 200개입니다.')
        data['createdAt'] = old['createdAt'] if old else now
        data['updatedAt'] = now
        next_run = old['nextRunAt'] if old and old['schedule'] == data['schedule'] and old['enabled'] == data['enabled'] else schedule.occurrences(data['schedule'], now)[0]
        id = id or str(uuid.uuid4())
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO automations VALUES(?,?,?,?,0)',
                            (id, (old['revision'] + 1) if old else 1, encode(data), next_run))
            result = self.get(id)
            self.remember(request_id, op, {'_ref': 'automation', 'id': id})
        return result

    def archive(self, id, revision):
        d = self.get(id)
        if d['revision'] != revision:
            raise ValueError('정의가 변경되었습니다. 새로고침하세요.')
        with self.db:
            self.db.execute('UPDATE automations SET archived=1,revision=revision+1 WHERE id=?', (id,))
        return self.get(id)

    def runs(self, id=None, limit=100):
        if id:
            rows = self.db.execute('SELECT data FROM runs WHERE automation_id=? ORDER BY created DESC,rowid DESC LIMIT ?', (id, limit))
        else:
            rows = self.db.execute('SELECT data FROM runs ORDER BY created DESC,rowid DESC LIMIT ?', (limit,))
        return [json.loads(row[0]) for row in rows]

    def run(self, id):
        row = self.db.execute('SELECT data FROM runs WHERE id=?', (id,)).fetchone()
        if not row:
            raise ValueError('실행을 찾을 수 없습니다.')
        return json.loads(row[0])

    def active(self):
        rows = self.db.execute('SELECT data FROM runs WHERE phase IN (%s)' % ','.join('?' * len(ACTIVE)), ACTIVE)
        return [json.loads(row[0]) for row in rows]

    def set_run(self, id, **patch):
        r = {**self.run(id), **patch, 'updatedAt': time.time()}
        with self.db:
            self.db.execute('UPDATE runs SET phase=?,data=? WHERE id=?', (r['phase'], encode(r), id))
        return r

    def _enqueue(self, d, trigger, due, dedupe, now, forced=None):
        row = self.db.execute('SELECT data FROM runs WHERE dedupe=?', (dedupe,)).fetchone()
        if row:
            return json.loads(row[0])
        busy = any(r['automationId'] == d['id'] for r in self.active())
        phase = forced or ('skipped_overlap' if busy else 'queued')
        r = {'id': str(uuid.uuid4()), 'automationId': d['id'], 'snapshot': d,
             'trigger': trigger, 'scheduledFor': due, 'createdAt': now, 'updatedAt': now,
             'phase': phase, 'address': None, 'coreId': None, 'message': '', 'output': ''}
        self.db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?)', (r['id'], d['id'], dedupe, phase, now, encode(r)))
        return r

    def manual(self, id, request_id, now=None):
        now = time.time() if now is None else now
        op = 'run:' + id
        cached = self.cached(request_id, op)
        if cached is not None:
            # Tombstone remains even after history pruning; never launch twice.
            return cached
        d = self.get(id)
        if d['archived']:
            raise ValueError('보관된 자동화입니다.')
        with self.db:
            r = self._enqueue(d, 'manual', now, 'manual:' + request_id, now)
            self.remember(request_id, op, {'_ref': 'run', 'id': r['id']})
        return r

    def due(self, now):
        result = []
        with self.db:
            for d in self.list():
                if not d['enabled'] or d['nextRunAt'] > now:
                    continue
                latest = schedule.latest(d['schedule'], now)
                if latest is None or latest < d['nextRunAt']:
                    continue
                # One summary row represents all older missed occurrences; no replay storm.
                if latest > d['nextRunAt']:
                    missed = self._enqueue(d, 'schedule', d['nextRunAt'], f"schedule:{d['id']}:{d['nextRunAt']}", now, 'skipped_missed')
                    missed['message'] = '이후 누락 예약도 최신 1회를 제외하고 건너뛰었습니다.'
                    self.db.execute('UPDATE runs SET data=? WHERE id=?', (encode(missed), missed['id']))
                phase = 'skipped_missed' if now - latest > d['graceMinutes'] * 60 else None
                result.append(self._enqueue(d, 'schedule', latest, f"schedule:{d['id']}:{latest}", now, phase))
                self.db.execute('UPDATE automations SET next=? WHERE id=?', (schedule.occurrences(d['schedule'], now)[0], d['id']))
        return result

    def prune(self):
        with self.db:
            for row in self.db.execute('SELECT DISTINCT automation_id FROM runs').fetchall():
                ids = self.db.execute('SELECT id FROM runs WHERE automation_id=? AND phase IN (%s) ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 100' % ','.join('?' * len(FINAL)), (row[0], *FINAL)).fetchall()
                self.db.executemany('DELETE FROM runs WHERE id=?', ids)
