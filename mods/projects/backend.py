"""Per-machine Herdr project catalog. Run inert JSON requests via python3 -c.

Only explicit register/start/bind/rename actions write; list and inspect are read-only.
The same program is sent to the selected core machine, never shell-interpolated.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit

REGISTRY = Path(os.environ.get('HERDR_PROJECTS_REGISTRY', str(Path.home() / '.config/herdr-projects/catalog.json')))


def command(argv, cwd=None, timeout=14):
    p = subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode:
        raise ValueError((p.stderr or p.stdout).strip()[-1500:] or f'{argv[0]} failed ({p.returncode})')
    return p.stdout.strip()


def git(path, *args):
    return command(['git', '-C', str(path), *args])


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()[:24]


def machine_id():
    # Connection aliases differ between clients. This identity belongs to the PC.
    for p in ['/etc/machine-id', '/var/lib/dbus/machine-id']:
        try:
            value = Path(p).read_text().strip()
            if value:
                return digest(value)
        except OSError:
            pass
    return digest(socket.gethostname() + ':' + str(Path.home()))


def empty():
    return {'version': 1, 'machineId': machine_id(), 'hostname': socket.gethostname(), 'revision': 0, 'locations': [], 'works': []}


def read():
    if not REGISTRY.exists():
        return empty()
    data = json.loads(REGISTRY.read_text())
    if data.get('version') != 1 or not isinstance(data.get('locations'), list) or not isinstance(data.get('works'), list):
        raise ValueError('Unsupported or invalid project catalog; original file preserved')
    if data.get('machineId') != machine_id():
        raise ValueError('Catalog belongs to a different PC; register this checkout on this PC')
    return data


@contextlib.contextmanager
def locked():
    # Core machines currently supported by this mod are POSIX with Python 3.
    import fcntl
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    with open(str(REGISTRY) + '.lock', 'a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def save(data):
    data['revision'] += 1
    data['updatedAt'] = int(time.time() * 1000)
    fd, temp = tempfile.mkstemp(prefix='.catalog-', dir=REGISTRY.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, REGISTRY)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def remote_identity(url):
    value = url.strip()
    if value.startswith(('http://', 'https://', 'ssh://', 'git://')):
        parsed = urlsplit(value)
        host, path = parsed.hostname, parsed.path
    else:
        match = re.fullmatch(r'(?:[^@/]+@)?([^/:]+):(.+)', value)
        if not match:
            raise ValueError('Repository needs a Git remote URL with a hostname and owner/repository')
        host, path = match.groups()
    parts = path.strip('/').removesuffix('.git').split('/')
    if not host or len(parts) < 2 or not all(parts):
        raise ValueError('Invalid repository remote')
    # GitHub owner/repo identifiers are case insensitive; keep display spelling.
    return {'host': host.lower(), 'slug': '/'.join(parts), 'key': host.lower() + '/' + '/'.join(parts).lower()}


def inspect(path):
    path = str(Path(path).expanduser().resolve())
    top = git(path, 'rev-parse', '--show-toplevel')
    common = str(Path(git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).resolve())
    origin = git(path, 'remote', 'get-url', 'origin')
    ident = remote_identity(origin)
    try:
        symbolic = git(path, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')
        base = symbolic.removeprefix('refs/remotes/')
    except ValueError:
        base = next((b for b in ['main', 'master'] if ref_exists(path, b)), 'HEAD')
    try:
        branch = git(path, 'symbolic-ref', '--quiet', '--short', 'HEAD')
    except ValueError:
        branch = 'Detached ' + git(path, 'rev-parse', '--short', 'HEAD')
    return {'path': top, 'common': common, 'remote': origin, 'identity': ident, 'base': base, 'branch': branch}


def ref_exists(path, ref):
    try:
        git(path, 'rev-parse', '--verify', ref + '^{commit}')
        return True
    except ValueError:
        return False


def checkouts(path):
    # -z preserves whitespace/newlines in worktree paths.
    text = git(path, 'worktree', 'list', '--porcelain', '-z')
    result, row = [], {}
    for token in text.split('\0'):
        if not token:
            if row:
                result.append(row)
                row = {}
        elif token.startswith('worktree '):
            row['path'] = token[9:]
        elif token.startswith('branch '):
            row['branch'] = token[7:].removeprefix('refs/heads/')
        elif token.startswith('HEAD '):
            row['head'] = token[5:]
        elif token == 'detached':
            row['detached'] = True
        elif token.startswith('prunable'):
            row['prunable'] = True
    if row:
        result.append(row)
    return [r for r in result if not r.get('prunable')]


def locate(data, lid):
    row = next((x for x in data['locations'] if x['id'] == lid), None)
    if row is None:
        raise ValueError('Repository location is no longer registered')
    current = inspect(row['path'])
    if current['identity']['key'] != row['identity']['key'] or current['common'] != row['common']:
        raise ValueError('Repository identity changed; register the checkout again')
    return row, current


def register(req):
    found = inspect(req['path'])
    main = checkouts(found['path'])[0]['path']
    if main != found['path']:
        found = inspect(main)
    # A common Git directory is one repository location, even from a linked tree.
    lid = digest(machine_id() + ':' + found['common'])
    with locked():
        data = read()
        previous = next((x for x in data['locations'] if x['id'] == lid), {})
        row = {**previous, **found, 'id': lid, 'projectId': found['identity']['key'],
               'name': req.get('name', '').strip() or previous.get('name') or found['identity']['slug'].split('/')[-1]}
        data['locations'] = [x for x in data['locations'] if x['id'] != lid] + [row]
        save(data)
    return row


def catalog():
    data = read()
    for row in data['locations']:
        try:
            _, live = locate(data, row['id'])
            row['checkouts'] = checkouts(row['path'])
            row['branch'] = live['branch']
            row['error'] = None
        except Exception as e:
            row['checkouts'], row['error'] = [], str(e)
    return data


def issue(req, location):
    i = req.get('issue')
    if not i:
        return None
    ident = location['identity']
    number = i.get('number')
    if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
        raise ValueError('Invalid issue number')
    if i.get('repo', ident['slug']).lower() != ident['slug'].lower() or i.get('host', ident['host']).lower() != ident['host']:
        raise ValueError('Issue belongs to a different repository')
    return {'key': ident['key'] + '#' + str(number), 'host': ident['host'], 'repo': ident['slug'], 'number': number,
            'title': str(i.get('title') or '')[:300], 'url': f'https://{ident["host"]}/{ident["slug"]}/issues/{number}'}


def start(req):
    with locked():
        data = read()
        location, _ = locate(data, req['locationId'])
        linked = issue(req, location)
        # Mutation id survives reconnects; default issue launch reopens its existing work.
        wid = req.get('workId')
        existing = next((w for w in data['works'] if w['id'] == wid), None) if wid else None
        if existing and existing['locationId'] != location['id']:
            raise ValueError('Work belongs to a different repository location')
        if not existing and linked and not req.get('additional'):
            existing = next((w for w in data['works'] if w['locationId'] == location['id'] and w.get('issue', {}).get('key') == linked['key']), None)
        if existing:
            work = existing
            if work['state'] in ['ready', 'open']:
                tree = next((c for c in checkouts(location['path']) if c['path'] == work['path']), None)
                if tree is None:
                    raise ValueError('The linked worktree is missing. Restore it or explicitly start an additional work item.')
                return work
        else:
            wid = str(uuid.uuid4())
            branch = str(req.get('branch') or (f'issue/{linked["number"]}' if linked else 'work/' + wid[:8])).strip()
            if not branch or branch.startswith('-'):
                raise ValueError('Invalid branch name')
            git(location['path'], 'check-ref-format', '--branch', branch)
            base = str(req.get('base') or location['base']).strip()
            if base.startswith('-') or not ref_exists(location['path'], base):
                raise ValueError('Base ref is not available on the selected PC')
            path = str(Path.home() / '.herdr/worktrees' / location['id'] / wid[:12])
            work = {'id': wid, 'projectId': location['projectId'], 'locationId': location['id'], 'machineId': data['machineId'],
                    'branch': branch, 'base': base, 'path': path, 'title': str(req.get('title') or (linked or {}).get('title') or branch),
                    'state': 'creating', 'createdAt': int(time.time() * 1000), 'spaceId': None}
            if linked:
                work['issue'] = linked
            data['works'].append(work)
            save(data)  # Record intent before Git mutation.
        try:
            tree = next((c for c in checkouts(location['path']) if c['path'] == work['path']), None)
            if not tree and work['state'] == 'failed':
                branch = str(req.get('branch') or work['branch']).strip()
                base = str(req.get('base') or work['base']).strip()
                if branch.startswith('-') or base.startswith('-') or not ref_exists(location['path'], base):
                    raise ValueError('Invalid branch or base ref')
                git(location['path'], 'check-ref-format', '--branch', branch)
                work['branch'], work['base'] = branch, base
                save(data)
            if tree:
                if tree.get('branch') != work['branch']:
                    raise ValueError('Worktree path belongs to a different branch')
            else:
                if Path(work['path']).exists():
                    raise ValueError('Worktree destination exists but is not a registered checkout')
                # Never reuse a same-named branch silently: a different work may own it.
                if ref_exists(location['path'], 'refs/heads/' + work['branch']):
                    raise ValueError('Branch already exists. Open its checkout or choose a different branch.')
                Path(work['path']).parent.mkdir(parents=True, exist_ok=True)
                git(location['path'], 'worktree', 'add', '-b', work['branch'], work['path'], work['base'])
            work['state'], work['error'] = 'ready', None
            save(data)
            return work
        except Exception as e:
            work['state'], work['error'] = 'failed', str(e)
            save(data)
            raise


def dispatch(req):
    op = req['op']
    if op == 'list':
        return catalog()
    if op == 'inspect':
        return inspect(req['path'])
    if op == 'register':
        return register(req)
    if op == 'start':
        return start(req)
    if op == 'bind':
        with locked():
            data = read()
            work = next((w for w in data['works'] if w['id'] == req['workId']), None)
            if not work or work['state'] not in ['ready', 'open']:
                raise ValueError('Work is not ready')
            work['spaceId'], work['state'] = str(req['spaceId']), 'open'
            save(data)
            return work
    if op == 'issues':
        data = read()
        location, _ = locate(data, req['locationId'])
        ident = location['identity']
        urlrepo = f'{ident["host"]}/{ident["slug"]}'
        raw = command(['gh', 'issue', 'list', '--repo', urlrepo, '--state', req.get('state', 'open'), '--limit', '100',
                       '--json', 'number,title,body,url,state,labels,assignees,updatedAt'], cwd=location['path'], timeout=18)
        return json.loads(raw)
    raise ValueError('Unknown operation')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': dispatch(json.loads(sys.argv[1]))}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        sys.exit(1)
