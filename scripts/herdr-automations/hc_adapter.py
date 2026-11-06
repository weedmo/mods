"""The only hc boundary; no shell interpolation, no permission bypass flags."""
import json
import os
import shutil
import subprocess
import time

class CoreError(RuntimeError):
    def __init__(self, message, kind='unavailable'):
        super().__init__(message)
        self.kind = kind

class HC:
    def call(self, *args, timeout=15):
        try:
            p = subprocess.run([os.environ.get('HERDR_AUTOMATIONS_HC', 'hc'), *args],
                               capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise CoreError(str(e))
        if p.returncode:
            try:
                error = json.loads(p.stderr).get('error', {})
            except ValueError:
                error = {}
            raise CoreError(error.get('message') or p.stderr[:2000], error.get('kind', 'unavailable'))
        try:
            return json.loads(p.stdout)
        except ValueError:
            raise CoreError('hc returned invalid JSON')

    def identity(self):
        return self.call('server', 'status', '--json')['core']['id']

    def find(self, run_id):
        return self.call('ls', '--all', '--json', '--label', 'herdr.automation.run=' + run_id)['terminals']

    def get(self, address):
        return self.call('get', address, '--json')

    def launch(self, run):
        d = run['snapshot']
        args = ['run', '--bg', '--json', '--no-parent', '--no-notify', '--cwd', d['cwd'],
                '--label', 'herdr.automation=' + run['automationId'],
                '--label', 'herdr.automation.run=' + run['id']]
        # Keep tasks independent of an active UI tab; Open terminal uses terminal.peek.
        executable = shutil.which(d['agent'])
        if not executable:
            raise CoreError('Agent executable is unavailable')
        argv = [executable]
        if d['agent'] == 'codex':
            argv.append('--no-daemon')
        argv.extend(['--', d['prompt']])
        return self.call(*args, '--', *argv, timeout=25)

    def read(self, address):
        try:
            p = subprocess.run([os.environ.get('HERDR_AUTOMATIONS_HC', 'hc'), 'read', address,
                                '--lines', '80'], capture_output=True, timeout=10)
            return p.stdout.decode('utf-8', 'replace')[-12000:]
        except (OSError, subprocess.TimeoutExpired):
            return ''

    def kill(self, address):
        return self.call('kill', address, '--json')


def classify(terminal, run, now=None):
    """Raw root done plus a completed turn; startup idle can never finish a job."""
    now = time.time() if now is None else now
    if terminal.get('state') == 'finished':
        # Agent exit 0 alone doesn't prove the requested task finished.
        return ('interrupted' if terminal.get('exit_code') in (0, None) else 'failed',
                '프로세스 종료: ' + str(terminal.get('reason') or terminal.get('exit_code')))
    first = terminal.get('first_message') or {}
    if first.get('sent') is False:
        return 'blocked', first.get('reason', '최초 작업 전달을 확인할 수 없습니다.')
    status = terminal.get('status') or {}
    state = status.get('state')
    if state == 'done' and terminal.get('turn', 0) > 0 and terminal.get('status_ms', 0) >= terminal['created_ms']:
        return 'succeeded', '에이전트가 작업 turn 완료를 보고했습니다.'
    if state == 'error':
        return 'failed', status.get('msg') or '에이전트 오류'
    if state == 'blocked':
        return 'blocked', status.get('msg') or status.get('kind') or '사용자 조치가 필요합니다.'
    if state == 'working':
        return 'running', ''
    if now - run['createdAt'] > 90:
        return 'blocked', '시작/완료 신호 대기 중입니다. 터미널에서 신뢰·인증·입력 화면을 확인하세요.'
    return 'running', '에이전트 시작 대기'
