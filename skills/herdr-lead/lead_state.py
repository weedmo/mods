#!/usr/bin/env python3
"""Lead state and registry helper for the herdr-lead skill.

Reads ~/.config/herdr-projects/projects.json (the project-spaces registry, read-only
here) and reads/writes ~/.config/herdr-projects/lead-state.json, which the
project-lead panel shows. Writes are atomic (temp file + rename) under a lock file.

Paths can be overridden for tests: HERDR_PROJECTS, HERDR_LEAD_STATE.

Usage:
  lead_state.py projects                       # registry projects, PCs, roles, paths
  lead_state.py pcs <projectKey>               # {role: [{machine, paths}]} for one project
  lead_state.py add --project K --task ID --role R --machine M [--terminal A] [--path P]
                    [--branch B] [--scope S] [--status S] [--name N]
  lead_state.py set --project K --task ID [--status S] [--terminal A] [--branch B]
                    [--report TEXT | --report-file F] [--note TEXT]
  lead_state.py show [--project K]
Machine "" or "local" means this computer.
"""
import argparse
import fcntl
import json
import os
import sys
import tempfile
import time

ROLES = ("impl", "qa", "plan")
STATUSES = ("queued", "dispatched", "working", "reported", "awaiting-user",
            "done", "failed", "blocked", "cancelled")
BASE = os.path.expanduser("~/.config/herdr-projects")
REGISTRY = os.environ.get("HERDR_PROJECTS") or os.path.join(BASE, "projects.json")
STATE = os.environ.get("HERDR_LEAD_STATE") or os.path.join(BASE, "lead-state.json")
MAX_REPORT = 4000


def now_ms():
    return int(time.time() * 1000)


def machine_key(m):
    return "" if m in (None, "", "local", "null") else m


def load_registry():
    try:
        with open(REGISTRY, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return {"version": 1, "projects": {}}
    return raw if isinstance(raw, dict) else {"version": 1, "projects": {}}


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            st = json.load(f)
    except FileNotFoundError:
        st = {}
    if not isinstance(st, dict):
        raise SystemExit(f"{STATE} is not a JSON object; refusing to overwrite it")
    st.setdefault("version", 1)
    st.setdefault("projects", {})
    return st


def write_state(st):
    st["updated_ms"] = now_ms()
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".lead-state-", dir=os.path.dirname(STATE))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, STATE)


class Locked:
    def __enter__(self):
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        self.f = open(STATE + ".lock", "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def find_task(proj, task_id):
    for t in proj.get("tasks", []):
        if t.get("id") == task_id:
            return t
    return None


def cmd_projects(_a):
    reg = load_registry()
    out = {}
    for key, p in (reg.get("projects") or {}).items():
        out[key] = {"name": p.get("name") or key.split("/")[-1], "remote": p.get("remote"),
                    "pcs": {(m or "local"): {"roles": pc.get("roles", []), "paths": pc.get("paths", [])}
                            for m, pc in (p.get("pcs") or {}).items()}}
    print(json.dumps(out, indent=2, ensure_ascii=False))


def cmd_pcs(a):
    reg = load_registry()
    p = (reg.get("projects") or {}).get(a.project)
    if not p:
        raise SystemExit(f"project {a.project!r} is not in {REGISTRY}")
    out = {r: [] for r in ROLES}
    for m, pc in (p.get("pcs") or {}).items():
        for r in pc.get("roles", []):
            if r in out:
                out[r].append({"machine": m or None, "paths": pc.get("paths", [])})
    print(json.dumps(out, indent=2, ensure_ascii=False))


def cmd_add(a):
    if a.role not in ROLES:
        raise SystemExit(f"role must be one of {ROLES}")
    if a.status not in STATUSES:
        raise SystemExit(f"status must be one of {STATUSES}")
    with Locked():
        st = load_state()
        name = a.name or ((load_registry().get("projects") or {}).get(a.project) or {}).get("name") \
            or a.project.split("/")[-1]
        proj = st["projects"].setdefault(a.project, {"name": name, "tasks": []})
        proj.setdefault("tasks", [])
        if find_task(proj, a.task):
            raise SystemExit(f"task {a.task!r} already exists in {a.project}; use set")
        t = now_ms()
        proj["tasks"].append({
            "id": a.task, "role": a.role, "machine": machine_key(a.machine) or None,
            "path": a.path, "terminal": a.terminal, "branch": a.branch, "scope": a.scope,
            "status": a.status, "created_ms": t, "updated_ms": t, "report": None, "notes": []})
        write_state(st)
    print(json.dumps({"ok": True, "project": a.project, "task": a.task}))


def cmd_set(a):
    if a.status and a.status not in STATUSES:
        raise SystemExit(f"status must be one of {STATUSES}")
    with Locked():
        st = load_state()
        proj = st["projects"].get(a.project)
        task = find_task(proj or {}, a.task)
        if not task:
            raise SystemExit(f"no task {a.task!r} in {a.project}")
        for k in ("status", "terminal", "branch"):
            v = getattr(a, k)
            if v is not None:
                task[k] = v
        text = a.report
        if a.report_file:
            with open(a.report_file, encoding="utf-8", errors="replace") as f:
                text = f.read()
        if text is not None:
            task["report"] = {"text": text[:MAX_REPORT], "file": a.report_path, "at_ms": now_ms()}
        if a.note:
            task.setdefault("notes", []).append({"text": a.note[:500], "at_ms": now_ms()})
        task["updated_ms"] = now_ms()
        write_state(st)
    print(json.dumps({"ok": True, "project": a.project, "task": a.task, "status": task["status"]}))


def cmd_show(a):
    st = load_state()
    if a.project:
        st = {"projects": {a.project: st["projects"].get(a.project)}}
    print(json.dumps(st, indent=2, ensure_ascii=False))


def main(argv):
    ap = argparse.ArgumentParser(prog="lead_state.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("projects")
    p = sub.add_parser("pcs"); p.add_argument("project")
    p = sub.add_parser("add")
    for k in ("--project", "--task", "--role"):
        p.add_argument(k, required=True)
    p.add_argument("--machine", default="")
    for k in ("--terminal", "--path", "--branch", "--scope", "--name"):
        p.add_argument(k)
    p.add_argument("--status", default="dispatched")
    p = sub.add_parser("set")
    p.add_argument("--project", required=True); p.add_argument("--task", required=True)
    for k in ("--status", "--terminal", "--branch", "--report", "--report-file", "--report-path", "--note"):
        p.add_argument(k)
    p = sub.add_parser("show"); p.add_argument("--project")
    a = ap.parse_args(argv)
    {"projects": cmd_projects, "pcs": cmd_pcs, "add": cmd_add, "set": cmd_set, "show": cmd_show}[a.cmd](a)


if __name__ == "__main__":
    main(sys.argv[1:])
