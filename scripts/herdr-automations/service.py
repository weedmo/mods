#!/usr/bin/env python3
"""Local automation controller. UI requests never wait on an agent launch."""
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import socketserver
import time

from hc_adapter import HC, CoreError, classify
from runner import precheck
from store import Store, FINAL
import schedule

MAX_REQUEST = 150000

def paths():
    state = Path(os.environ.get('HERDR_AUTOMATIONS_STATE', Path.home() / '.local/state/herdr-automations'))
    runtime = Path(os.environ.get('XDG_RUNTIME_DIR', f'/tmp/herdr-automations-{os.getuid()}'))
    sock = Path(os.environ.get('HERDR_AUTOMATIONS_SOCKET', runtime / 'herdr-automations/control.sock'))
    return state, sock

def summary(run):
    return {k: run.get(k) for k in ('id', 'automationId', 'trigger', 'scheduledFor', 'createdAt', 'phase', 'address', 'coreId', 'message')}

class Controller:
    def __init__(self, store, core=None):
        self.store, self.core = store, core or HC()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        self.pending = {}
        self.started = time.time()
        self.last_reconcile = 0
        self.last_prune = 0
        self.error = ''
        self.stopping = False
        # A precheck may have external side effects. Never replay it after a crash.
        for r in store.active():
            if r['phase'] == 'prechecking':
                store.set_run(r['id'], phase='interrupted', message='조건 검사 중 서비스가 재시작되었습니다.')

    def close(self):
        self.pool.shutdown(wait=False, cancel_futures=True)

    def submit(self, r, kind, fn, *args):
        self.pending[r['id']] = (kind, self.pool.submit(fn, *args))

    def launch(self, r):
        # Capture durable core identity BEFORE starting any process.
        try:
            core_id = self.core.identity()
        except CoreError as e:
            self.store.set_run(r['id'], phase='skipped_unavailable', message=str(e))
            return
        self.store.set_run(r['id'], phase='dispatching', coreId=core_id, message='')
        self.submit(r, 'launch', self.core.launch, r)

    def tick(self, now=None):
        now = time.time() if now is None else now
        self.store.due(now)
        for id, (kind, future) in list(self.pending.items()):
            if not future.done():
                continue
            del self.pending[id]
            r = self.store.run(id)
            try:
                value = future.result()
                if kind == 'precheck':
                    self.store.set_run(id, precheck=value)
                    if value['passed']:
                        self.launch(self.store.run(id))
                    else:
                        self.store.set_run(id, phase='skipped_precheck', message='조건 검사 실패 또는 시간 초과', output=value['output'])
                else:
                    if not value.get('address'):
                        raise CoreError('실행 주소를 받지 못했습니다.')
                    self.store.set_run(id, phase='running', address=value['address'], message='')
            except Exception as e:
                self.store.set_run(id, phase='unknown' if kind == 'launch' else 'skipped_precheck', message=str(e)[:2000])
        for r in self.store.active():
            if r['phase'] != 'queued' or len(self.pending) >= 4:
                continue
            d = r['snapshot']
            if not Path(d['cwd']).is_dir() or not shutil.which(d['agent']):
                self.store.set_run(r['id'], phase='skipped_unavailable', message='폴더 또는 에이전트 실행 파일이 없습니다.')
                continue
            if r['trigger'] == 'schedule' and d['precheck']['command']:
                self.store.set_run(r['id'], phase='prechecking')
                self.submit(r, 'precheck', precheck, d['precheck']['command'], d['cwd'], d['precheck']['timeout'])
            else:
                self.launch(r)
        if now - self.last_reconcile >= 3:
            self.reconcile(now)
            self.last_reconcile = now
        if now - self.last_prune >= 60:
            self.store.prune()
            self.last_prune = now

    def reconcile(self, now):
        runs = [r for r in self.store.active() if r['phase'] in ('dispatching', 'running', 'blocked', 'unknown') and r['id'] not in self.pending]
        if not runs:
            return
        try:
            identity = self.core.identity()
            self.error = ''
        except CoreError as e:
            self.error = str(e)
            return  # Lost connection is not evidence that the task ended.
        for r in runs:
            if r.get('coreId') != identity:
                self.store.set_run(r['id'], phase='unknown', message='Core identity가 바뀌었습니다. 자동 재실행하지 않습니다.')
                continue
            try:
                address = r['address']
                if not address:
                    candidates = self.core.find(r['id'])
                    if len(candidates) != 1:
                        self.store.set_run(r['id'], phase='unknown', message='실행 여부를 확정하지 못했습니다. 중복 실행 방지를 위해 보류합니다.')
                        continue
                    address = candidates[0]['address']
                    self.store.set_run(r['id'], address=address)
                t = self.core.get(address)
                if t.get('labels', {}).get('herdr.automation.run') != r['id']:
                    self.store.set_run(r['id'], phase='unknown', message='터미널 실행 식별자가 일치하지 않습니다.')
                    continue
                phase, message = classify(t, r, now)
                patch = {'phase': phase, 'message': message}
                if phase in FINAL:
                    patch.update(finishedAt=now, completion={'turn': t.get('turn'), 'status': t.get('status'),
                                 'exitCode': t.get('exit_code'), 'reason': t.get('reason')}, output=self.core.read(address))
                if phase != r['phase'] or message != r.get('message'):
                    self.store.set_run(r['id'], **patch)
            except CoreError as e:
                if e.kind == 'not_found':
                    self.store.set_run(r['id'], phase='unknown', message='실행 터미널이 없습니다. 자동 재실행하지 않습니다.')
                else:
                    self.error = str(e)

    def request(self, q):
        op = q.get('op')
        if op == 'status':
            return {'version': 1, 'startedAt': self.started, 'error': self.error,
                    'providers': {p: bool(shutil.which(p)) for p in ('claude', 'codex')},
                    'active': len(self.store.active()), 'timezone': 'Asia/Seoul'}
        if op == 'list':
            rows = self.store.list()
            for d in rows:
                d['recent'] = [summary(r) for r in self.store.runs(d['id'], 1)]
                d.pop('prompt', None)
                d.pop('precheck', None)
            return rows
        if op == 'get':
            return self.store.get(q['id'])
        if op == 'preview':
            return schedule.occurrences(schedule.validate(q['schedule']), time.time(), 3)
        if op in ('create', 'update'):
            return self.store.save(q['definition'], q.get('id') if op == 'update' else None,
                                   q.get('revision'), q.get('requestId'))
        if op == 'setEnabled':
            d = self.store.get(q['id'])
            d['enabled'] = q['enabled']
            return self.store.save(d, d['id'], q.get('revision'), q.get('requestId'))
        if op == 'archive':
            return self.store.archive(q['id'], q.get('revision'))
        if op == 'runNow':
            return self.store.manual(q['id'], q.get('requestId'))
        if op == 'runs':
            return [summary(r) for r in self.store.runs(q.get('id'))]
        if op == 'getRun':
            return self.store.run(q['id'])
        if op == 'openTerminal':
            r = self.store.run(q['id'])
            if not r['address'] or self.core.identity() != r['coreId']:
                raise ValueError('실행 당시 Core/터미널과 일치하지 않습니다.')
            terminal = self.core.get(r['address'])
            if terminal.get('labels', {}).get('herdr.automation.run') != r['id']:
                raise ValueError('터미널 실행 식별자가 일치하지 않습니다.')
            return {'address': r['address']}
        if op == 'closeTerminal':
            r = self.store.run(q['id'])
            if r['phase'] not in FINAL:
                raise ValueError('진행 중인 실행에는 실행 중지를 사용하세요.')
            target = self.request({'op': 'openTerminal', 'id': r['id']})
            self.core.kill(target['address'])
            return r
        if op == 'cancel':
            r = self.store.run(q['id'])
            if r['id'] in self.pending:
                raise ValueError('조건 검사/시작 요청 처리 중입니다. 처리가 끝난 뒤 중지하세요.')
            if r['phase'] in FINAL:
                return r
            if r['address']:
                if self.core.identity() != r['coreId']:
                    raise ValueError('다른 Core에는 중지 명령을 보내지 않습니다.')
                terminal = self.core.get(r['address'])
                if terminal.get('labels', {}).get('herdr.automation.run') != r['id']:
                    raise ValueError('실행 식별자가 일치하지 않습니다.')
                self.core.kill(r['address'])
            elif r['phase'] in ('unknown', 'dispatching'):
                raise ValueError('실행 여부가 불명확합니다. 터미널을 확인한 후 보류 해제를 사용하세요.')
            return self.store.set_run(r['id'], phase='cancelled', message='사용자가 실행을 중지했습니다.')
        if op == 'resolveUnknown':
            r = self.store.run(q['id'])
            if r['phase'] != 'unknown' or q.get('confirmed') is not True:
                raise ValueError('unknown 실행만 명시적으로 확인 후 해제할 수 있습니다.')
            return self.store.set_run(r['id'], phase='interrupted', message='사용자가 실행 상태를 확인하고 보류를 해제했습니다.')
        raise ValueError('지원하지 않는 요청입니다.')

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(2)
        try:
            line = self.rfile.readline(MAX_REQUEST + 1)
            if len(line) > MAX_REQUEST:
                raise ValueError('요청이 너무 큽니다.')
            q = json.loads(line)
            if not isinstance(q, dict):
                raise ValueError('객체 요청이 필요합니다.')
            result = {'ok': True, 'result': self.server.controller.request(q)}
        except Exception as e:
            result = {'ok': False, 'error': str(e)[:2000]}
        try:
            self.wfile.write((json.dumps(result, ensure_ascii=False) + '\n').encode())
        except (BrokenPipeError, socket.timeout):
            pass


def main():
    os.umask(0o077)
    state, sock = paths()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    sock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in (state, sock.parent):
        if directory.is_symlink() or directory.stat().st_uid != os.getuid():
            raise RuntimeError('서비스 디렉터리 소유자를 확인하세요.')
        directory.chmod(0o700)
    lock = (state / 'service.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    store = Store(state / 'automations.db')
    controller = Controller(store)
    sock.unlink(missing_ok=True)
    server = socketserver.UnixStreamServer(str(sock), Handler)
    server.controller = controller
    server.timeout = .5
    stopping = False
    def stop(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    last_tick = 0
    try:
        while not stopping:
            server.handle_request()
            if time.monotonic() - last_tick >= 1:
                try:
                    controller.tick()
                except Exception as e:
                    controller.error = str(e)[:2000]
                    print('tick:', controller.error, flush=True)
                last_tick = time.monotonic()
    finally:
        server.server_close()
        sock.unlink(missing_ok=True)
        controller.close()
        store.close()

if __name__ == '__main__':
    main()
