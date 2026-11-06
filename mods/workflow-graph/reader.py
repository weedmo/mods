#!/usr/bin/env python3
"""Read Claude Code workflow runs for the workflow-graph mod.

Usage: reader.py [--pick KEY] [FOLDER...]  (main.js also runs it on remote machines via `python3 -c`)
Prints JSON: {"runs": [...recent runs...], "run": {...detail of runId or newest...}}

Sources (all under ~/.claude/projects/<project>/<session>/):
  workflows/wf_<id>.json                      final record, written when a run ends
  workflows/scripts/<name>-wf_<id>.js         the script (meta.phases), written at launch
  subagents/workflows/wf_<id>/agent-*.jsonl   live transcripts, one per agent
  subagents/workflows/wf_<id>/agent-*.meta.json  label (description) and phase
A run without its final record is live: agents' state comes from their transcripts.
"""
import sys
sys.dont_write_bytecode = True  # a __pycache__ under mods/ would reload the mod
import glob
import json
import os
import re
import sys
import time

ROOT = os.path.expanduser("~/.claude/projects")
MAX_RUNS = 30
STALE_S = 180  # a live run with no transcript write for this long is "stopped"
TAIL = 131072
DONE_MARKERS = ('Structured output provided successfully', '"stop_reason":"end_turn"')


def iso_ms(s):
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def discover():
    """Every run, keyed by runId: its session dir and what exists of it."""
    runs = {}
    for d in glob.glob(os.path.join(ROOT, "*", "*", "subagents", "workflows", "wf_*")):
        rid = os.path.basename(d)
        session = os.path.dirname(os.path.dirname(os.path.dirname(d)))
        runs[rid] = {"runId": rid, "session": session, "agentsDir": d}
    for f in glob.glob(os.path.join(ROOT, "*", "*", "workflows", "wf_*.json")):
        rid = os.path.basename(f)[:-5]
        session = os.path.dirname(os.path.dirname(f))
        runs.setdefault(rid, {"runId": rid, "session": session, "agentsDir": None})["final"] = f
    for r in runs.values():
        s = glob.glob(os.path.join(r["session"], "workflows", "scripts", f"*-{r['runId']}.js"))
        r["script"] = s[0] if s else None
        r["project"] = os.path.basename(os.path.dirname(r["session"])).lstrip("-").replace("-", "/")
        paths = [p for p in (r.get("final"), r["script"], r["agentsDir"]) if p]
        if r["agentsDir"]:
            paths += glob.glob(os.path.join(r["agentsDir"], "*.jsonl"))
        r["mtime"] = max((os.path.getmtime(p) for p in paths if os.path.exists(p)), default=0)
    return runs


def script_meta(path):
    """Name and phase titles from `export const meta = {...}` (a pure literal)."""
    if not path:
        return None, []
    try:
        src = open(path).read(20000)
    except Exception:
        return None, []
    m = re.search(r"export\s+const\s+meta\s*=\s*\{(.*?)\n\}", src, re.S)
    block = m.group(1) if m else src[:4000]
    name = re.search(r"name\s*:\s*['\"`]([^'\"`]+)", block)
    phases = []
    p = re.search(r"phases\s*:\s*\[(.*?)\]", block, re.S)
    if p:
        phases = re.findall(r"['\"]?title['\"]?\s*:\s*['\"`]([^'\"`]+)", p.group(1))
    return (name.group(1) if name else None), phases


def summary(r):
    final = load_json(r["final"]) if r.get("final") else None
    name, _ = script_meta(r["script"])
    if final:
        status = final.get("status") or "completed"
        name = final.get("workflowName") or name
        agents = final.get("agentCount")
        start = final.get("startTime")
    else:
        status = "running" if time.time() - r["mtime"] < STALE_S else "stopped"
        agents = len(glob.glob(os.path.join(r["agentsDir"], "*.meta.json"))) if r["agentsDir"] else 0
        start = None
        if r["script"]:
            start = int(os.path.getmtime(r["script"]) * 1000)
    if not name and r["script"]:
        name = os.path.basename(r["script"])[: -len(r["runId"]) - 4]
    return {"source": "workflow", "runId": r["runId"], "name": name or r["runId"], "status": status, "project": r["project"],
            "agents": agents, "start": start, "mtime": int(r["mtime"] * 1000)}


def live_agent(meta_path):
    aid = os.path.basename(meta_path)[len("agent-"):-len(".meta.json")]
    meta = load_json(meta_path) or {}
    tr = meta_path[: -len(".meta.json")] + ".jsonl"
    a = {"id": aid, "label": meta.get("description") or aid, "phase": meta.get("workflowPhase") or "",
         "model": meta.get("pickedEffortModel"), "state": "queued", "start": None, "end": None,
         "tokens": None, "toolCalls": None, "last": None, "prompt": None, "result": None}
    if not os.path.exists(tr):
        return a
    try:
        with open(tr, "rb") as f:
            first = f.readline()
            size = os.fstat(f.fileno()).st_size
            f.seek(max(0, size - TAIL))
            tail = f.read().decode("utf-8", "replace")
        head = json.loads(first)
        a["start"] = iso_ms(head.get("timestamp", ""))
        content = head.get("message", {}).get("content")
        if isinstance(content, str):
            # The first turn relays the user's request; the computed task follows it.
            a["prompt"] = content.split("\n\n", 1)[-1][:600] if content.startswith("[Workflow harness") else content[:600]
    except Exception:
        pass
    mtime = int(os.path.getmtime(tr) * 1000)
    done = any(m in tail for m in DONE_MARKERS)
    a["state"] = "done" if done else "running"
    a["end"] = mtime if done else None
    a["lastAt"] = mtime
    for line in reversed(tail.splitlines()[1:]):
        try:
            o = json.loads(line)
        except Exception:
            continue
        msg = o.get("message") or {}
        if o.get("type") == "assistant" and isinstance(msg.get("content"), list):
            for c in reversed(msg["content"]):
                if c.get("type") == "tool_use":
                    a["last"] = c.get("name")
                    break
                if c.get("type") == "text" and done:
                    a["result"] = c.get("text", "")[:600]
                    break
            if a["last"] or a["result"]:
                break
    return a


def detail(r):
    s = summary(r)
    name, phases = script_meta(r["script"])
    final = load_json(r["final"]) if r.get("final") else None
    agents = []
    if final:
        prog = final.get("workflowProgress") or []
        phases = [p.get("title") for p in (final.get("phases") or [])] or phases
        for e in prog:
            if e.get("type") != "workflow_agent":
                continue
            st = e.get("startedAt")
            agents.append({"id": e.get("agentId") or f"i{e.get('index')}", "label": e.get("label") or "",
                           "phase": e.get("phaseTitle") or "", "model": e.get("model"), "state": e.get("state"),
                           "start": st, "end": (st + e["durationMs"]) if st and e.get("durationMs") else None,
                           "tokens": e.get("tokens"), "toolCalls": e.get("toolCalls"),
                           "last": e.get("lastToolName"), "prompt": (e.get("promptPreview") or "")[:600],
                           "result": (e.get("resultPreview") or "")[:600], "attempt": e.get("attempt")})
        s.update({"durationMs": final.get("durationMs"), "totalTokens": final.get("totalTokens"),
                  "totalToolCalls": final.get("totalToolCalls"), "summary": final.get("summary"),
                  "logs": (final.get("logs") or [])[-20:]})
    elif r["agentsDir"]:
        agents = [live_agent(p) for p in glob.glob(os.path.join(r["agentsDir"], "*.meta.json"))]
        if s["status"] != "running":  # stopped: nothing is still running
            for a in agents:
                if a["state"] == "running":
                    a["state"] = "stopped"
                    a["end"] = a.get("lastAt")
    agents.sort(key=lambda a: (a["start"] or 1 << 62))
    for a in agents:
        kind, sep, rest = a["label"].partition(":")
        a["tag"], a["label"] = (kind, rest) if sep and rest else (None, a["label"])
        end = a["end"] or (int(time.time() * 1000) if a["state"] == "running" else None)
        a["facts"] = [x for x in (a.get("model"), f"{a['tokens']:,} tokens" if a.get("tokens") is not None else None,
                                  f"{a['toolCalls']} tool calls" if a.get("toolCalls") is not None else None,
                                  f"last: {a['last']}" if a.get("last") else None) if x]
        a["blocks"] = [b for b in (("prompt", a.get("prompt")), ("result", a.get("result")),
                                   ("transcript", f"{r['agentsDir']}/agent-{a['id']}.jsonl" if r["agentsDir"] else None)) if b[1]]
        a["sub"] = kilo(a.get("tokens"))
        if a["state"] == "done" and (a.get("attempt") or 1) > 1:
            a["stateText"] = f"↻{a['attempt']}"
    s.update({"phases": [{"title": p, "mode": "time"} for p in phases], "agentList": agents,
              "live": s["status"] == "running"})
    return s


def kilo(n):
    if n is None:
        return ""
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{round(n / 1e3)}k" if n >= 1e3 else str(n)


def in_folders(r, folders, repo_root):
    """Claude names a project dir after its cwd with every non-alphanumeric as "-". A run
    matches a folder, its repository, or (unless that is the home dir) anything below them."""
    enc = lambda p: re.sub(r"[^A-Za-z0-9]", "-", p)
    home = enc(os.path.expanduser("~"))
    keys = set()
    for f in folders:
        f = os.path.abspath(os.path.expanduser(f))
        keys.add(enc(f))
        root = repo_root(f)
        if root:
            keys.add(enc(root))
    proj = os.path.basename(os.path.dirname(r["session"]))
    return proj in keys or any(proj.startswith(k + "-") for k in keys if k != home)


def main():
    import argparse
    import loops
    ap = argparse.ArgumentParser()
    ap.add_argument("--pick", default="")
    ap.add_argument("--filter", action="store_true", help="only workflow runs started in the folders (or their repos)")
    ap.add_argument("folders", nargs="*")
    args = ap.parse_args()
    runs = discover()
    if args.filter:
        runs = {k: r for k, r in runs.items() if in_folders(r, args.folders, loops.repo_root)}
    entries = [("wf:" + r["runId"], r["mtime"], (lambda r=r: summary(r)), (lambda r=r: detail(r))) for r in runs.values()]
    entries += loops.discover(args.folders)
    entries.sort(key=lambda e: -e[1])
    entries = entries[:MAX_RUNS]
    listed = []
    for key, _m, summ, _d in entries:
        x = summ()
        x["key"] = key
        listed.append(x)
    pick = next((e for e in entries if e[0] == args.pick), None)
    if not pick and entries:
        live = [e for e, x in zip(entries, listed) if x["status"] in ("running", "blocked")]
        pick = (live or entries)[0]
    run = None
    if pick:
        run = pick[3]()
        run["key"] = pick[0]
    print(json.dumps({"runs": listed, "run": run}, ensure_ascii=False))


if __name__ == "__main__":
    main()
