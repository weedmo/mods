"""Bounded precheck subprocess and asynchronous hc launch workers."""
import os
import selectors
import signal
import subprocess
import time


def precheck(command, cwd, timeout):
    started = time.monotonic()
    p = subprocess.Popen(['/bin/sh', '-c', command], cwd=cwd, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, start_new_session=True)
    output = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(p.stdout, selectors.EVENT_READ)
    timed_out = False
    try:
        while selector.get_map():
            if time.monotonic() - started >= timeout:
                timed_out = True
                break
            for key, _ in selector.select(.1):
                data = os.read(key.fileobj.fileno(), 8192)
                if not data:
                    selector.unregister(key.fileobj)
                elif len(output) < 4000:
                    output.extend(data[:4000 - len(output)])
        remaining = max(.01, timeout - (time.monotonic() - started))
        try:
            p.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            timed_out = True
    finally:
        # Also remove any descendants keeping pipes open after the shell exits.
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait()
        p.stdout.close()
        selector.close()
    return {'passed': not timed_out and p.returncode == 0, 'exitCode': p.returncode,
            'timedOut': timed_out, 'output': output.decode('utf-8', 'replace'),
            'duration': round(time.monotonic() - started, 3)}
