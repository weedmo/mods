#!/usr/bin/env python3
"""Install the agent-resume SessionStart hook on remote Herdr machines.

  install_remote.py [machine ...]   default: every connected machine
  install_remote.py --dry-run ...   show what would change, write nothing

For each machine it copies agent_resume.py to
~/.config/herdr-app/mods/agent-resume/ and adds one SessionStart hook to
~/.claude/settings.json and ~/.codex/hooks.json (only when that agent's folder
exists). Existing files are backed up next to themselves before any change, and
a hook that is already present is left alone, so running it again is safe.

With the hook in place, an agent started in a Herdr terminal on that machine
labels its terminal with its session, which the Sessions window (sessions-weed)
picks up as a running remote session.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TIMEOUT = 30

# Runs on the remote machine. argv: dry-run flag. stdin: agent_resume.py source.
REMOTE = r'''
import json, os, sys, time
dry = sys.argv[1] == "1"
source = sys.stdin.read()
home = os.path.expanduser("~")
target = os.path.join(home, ".config", "herdr-app", "mods", "agent-resume", "agent_resume.py")
report = {"script": None, "claude": None, "codex": None}

def backup(path):
    if os.path.exists(path):
        copy = path + ".bak-agent-resume-" + time.strftime("%Y%m%d-%H%M%S")
        with open(path, "rb") as src, open(copy, "wb") as dst:
            dst.write(src.read())

old = open(target).read() if os.path.isfile(target) else None
report["script"] = "unchanged" if old == source else ("updated" if old else "installed")
if not dry and old != source:
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target + ".tmp", "w") as f:
        f.write(source)
    os.replace(target + ".tmp", target)

def add_hook(agent, folder, name):
    if not os.path.isdir(folder):
        return "agent not set up here"
    path = os.path.join(folder, name)
    try:
        data = json.load(open(path)) if os.path.isfile(path) else {}
    except ValueError:
        return "skipped: " + path + " is not valid JSON"
    if not isinstance(data, dict):
        return "skipped: unexpected format"
    command = "python3 '%s' hook %s" % (target, agent)
    hooks = data.setdefault("hooks", {})
    groups = hooks.setdefault("SessionStart", [])
    if not isinstance(groups, list):
        return "skipped: SessionStart is not a list"
    for group in groups:
        for hook in (group.get("hooks") or []) if isinstance(group, dict) else []:
            if isinstance(hook, dict) and "agent_resume.py" in str(hook.get("command")) and str(hook.get("command")).endswith(" hook " + agent):
                return "already installed"
    groups.append({"hooks": [{"type": "command", "command": command, "timeout": 10}]})
    if dry:
        return "would add"
    backup(path)
    with open(path + ".tmp", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(path + ".tmp", path)
    return "added"

report["claude"] = add_hook("claude", os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude"), "settings.json")
report["codex"] = add_hook("codex", os.environ.get("CODEX_HOME") or os.path.join(home, ".codex"), "hooks.json")
print(json.dumps(report))
'''


def hc():
    return shutil.which("hc") or str(Path.home() / ".local/bin/hc")


def machines():
    listed = json.loads(subprocess.run([hc(), "machine", "ls", "--json"], capture_output=True, text=True,
                                       timeout=10, check=True).stdout)
    return [m["name"] for m in listed.get("machines", []) if m.get("state") == "connected"]


def install(machine, dry):
    source = (HERE / "agent_resume.py").read_text()
    result = subprocess.run([hc(), "exec", "--on", machine, "-i", "--timeout", str(TIMEOUT), "--",
                             "python3", "-c", REMOTE, "1" if dry else "0"],
                            input=source, capture_output=True, text=True, timeout=TIMEOUT + 15)
    if result.returncode != 0:
        return {"error": (result.stderr or result.stdout).strip()[-300:]}
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": "unexpected output: " + result.stdout[-300:]}


def main(argv):
    dry = "--dry-run" in argv
    names = [a for a in argv if not a.startswith("--")] or machines()
    results = {name: install(name, dry) for name in names}
    print(json.dumps(results, indent=2, ensure_ascii=False))
    return 1 if any("error" in r for r in results.values()) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
