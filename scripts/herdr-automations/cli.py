#!/usr/bin/env python3
"""One JSON request argument, one JSON response. Safe for Herdr exec's limit."""
import json
import os
from pathlib import Path
import socket
import sys

def request(value):
    runtime = Path(os.environ.get('XDG_RUNTIME_DIR', f'/tmp/herdr-automations-{os.getuid()}'))
    path = os.environ.get('HERDR_AUTOMATIONS_SOCKET', str(runtime / 'herdr-automations/control.sock'))
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(8)
        s.connect(path)
        s.sendall((json.dumps(value, ensure_ascii=False) + '\n').encode())
        data = bytearray()
        while not data.endswith(b'\n'):
            piece = s.recv(65536)
            if not piece:
                break
            data.extend(piece)
            if len(data) > 7 * 1024 * 1024:
                raise ValueError('서비스 응답이 너무 큽니다.')
    return json.loads(data)

def main():
    try:
        value = json.loads(sys.argv[1]) if len(sys.argv) == 2 else {'op': 'status'}
        response = request(value)
    except (OSError, ValueError) as e:
        response = {'ok': False, 'error': '자동화 서비스에 연결하지 못했습니다. systemctl --user status herdr-automations 확인: ' + str(e)}
    print(json.dumps(response, ensure_ascii=False))
    return 0 if response.get('ok') else 1

if __name__ == '__main__':
    sys.exit(main())
