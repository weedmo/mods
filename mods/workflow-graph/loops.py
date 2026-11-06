"""matt-auto and autocode runs, normalized to the graph model reader.py prints.

Both loops write a loop-report data file (weed-harness `loop-report` contract):
  matt-auto  <repo>/docs/agents/matt-auto-log/<slug>.data.json  (stages, tickets, plan.waves, review, pr)
  autocode   <repo>/.autocode/report/autocode.data.json         (run, hypotheses)

Normalized run: {source, name, status, live, start, stats, phases: [{title, mode}], agentList: [item]}
  mode: "time"       lanes from real start/end overlap (workflow agents, autocode experiments)
        "parallel"   every item forks from the phase on its own lane
        "sequential" items chain one after another
  item: {id, label, tag, phase, state, start, end, sub, stateText, facts: [str], blocks: [[title, text]]}
  state: done | running | queued | failed | stopped
"""
import glob
import json
import os
from datetime import datetime

MATT_STATE = {"done": "done", "in-progress": "running", "pending": "queued", "blocked": "failed", "skipped": "stopped",
              "failed": "failed", "ok": "done"}
AUTO_STATE = {"keep": "done", "running": "running", "measured": "running", "discard": "stopped", "crash": "failed",
              "conflict": "failed", "interaction": "failed", "pending": "queued", "cancelled": "stopped"}


def ms(iso):
    if not iso:
        return None
    try:
        return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def repo_root(folder):
    d = os.path.abspath(os.path.expanduser(folder))
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def run_status(d):
    st = (d.get("progress") or {}).get("state")
    return st if st in ("running", "blocked", "done") else ("done" if d.get("outcome") else "running")


def short(path):
    home = os.path.expanduser("~")
    return path[len(home) + 1:] if path.startswith(home + "/") else path


def discover(folders):
    """[(key, mtime, summary(), detail())] for every loop data file under the folders' repos."""
    roots = {r for r in (repo_root(f) for f in folders if f and os.path.isdir(os.path.expanduser(f))) if r}
    out = []
    for root in roots:
        for f in glob.glob(os.path.join(root, "docs", "agents", "matt-auto-log", "*.data.json")):
            out.append(entry("matt", f, root))
        f = os.path.join(root, ".autocode", "report", "autocode.data.json")
        if os.path.exists(f):
            out.append(entry("autocode", f, root))
    return out


def entry(source, path, root):
    mtime = os.path.getmtime(path)

    def summary():
        d = load(path) or {}
        n = len(d.get("tickets") or []) if source == "matt" else len(d.get("hypotheses") or [])
        return {"source": source, "runId": path, "name": d.get("title") or os.path.basename(path), "status": run_status(d),
                "project": short(root), "agents": n, "start": ms((d.get("progress") or {}).get("startedAt")),
                "mtime": int(mtime * 1000)}

    def detail():
        d = load(path) or {}
        s = summary()
        s.update(matt(d) if source == "matt" else autocode(d))
        s["live"] = s["status"] != "done"
        s["file"] = path
        p = d.get("progress") or {}
        s["current"] = p.get("current")
        return s

    return (f"{source}:{path}", mtime, summary, detail)


def gates(t):
    g = t.get("gates") or {}
    return f"{g.get('met', 0)}/{g['total']}" if g.get("total") else ""


def matt(d):
    phases, items = [], []
    stages = [st for st in d.get("stages") or [] if st.get("id") not in ("implement", "ship")]
    if stages:
        phases.append({"title": "설계", "mode": "sequential"})
        for st in stages:
            decs = st.get("decisions") or []
            items.append({"id": f"stage:{st.get('id')}", "label": st.get("name") or st.get("id"), "tag": None, "phase": "설계",
                          "state": MATT_STATE.get(st.get("status"), "queued"), "sub": f"결정 {len(decs)}" if decs else "",
                          "facts": [], "blocks": [[dc.get("question", ""), dc.get("decision", "")] for dc in decs[:12]]})
    tickets = {t.get("id"): t for t in d.get("tickets") or []}
    waves = ((d.get("plan") or {}).get("waves")) or []
    if not waves and tickets:  # no plan: columns from blockedBy levels, as the page does
        level = {}

        def lv(i, seen=()):
            if i in level:
                return level[i]
            deps = [x for x in tickets[i].get("blockedBy") or [] if x in tickets and x not in seen]
            level[i] = 1 + max((lv(x, seen + (i,)) for x in deps), default=-1)
            return level[i]
        for i in tickets:
            lv(i)
        waves = [{"id": f"L{n + 1}", "mode": "parallel", "tickets": [i for i in tickets if level[i] == n]}
                 for n in range(max(level.values()) + 1)]
    for w in waves:
        title = f"{w.get('id')} · {'병렬' if w.get('mode') == 'parallel' else '순차'}"
        phases.append({"title": title, "mode": "sequential" if w.get("mode") == "sequential" else "parallel"})
        for tid in w.get("tickets") or []:
            t = tickets.get(tid)
            if not t:
                continue
            start = ms(t.get("startedAt"))
            end = start + t["actualMin"] * 60000 if start and t.get("actualMin") is not None else None
            worker = t.get("worker") or {}
            b = t.get("blocker") or {}
            items.append({"id": f"ticket:{tid}", "label": t.get("title") or tid, "tag": tid, "phase": title,
                          "state": MATT_STATE.get(t.get("status"), "queued"), "start": start, "end": end,
                          "sub": gates(t) or (f"~{t['estimateMin']}m" if t.get("estimateMin") and not end else ""),
                          "stateText": "blocked" if t.get("status") == "blocked" else None,
                          "facts": [x for x in (t.get("route"), "/".join(v for v in (worker.get("model"), worker.get("effort")) if v),
                                                f"gates {gates(t)}" if gates(t) else None,
                                                f"blocked by {', '.join(t['blockedBy'])}" if t.get("blockedBy") else None,
                                                f"예상 {t['estimateMin']}m" if t.get("estimateMin") else None) if x],
                          "blocks": [x for x in (["blocker", f"{b.get('reason', '')} — {b.get('detail', '')}"] if b else None,
                                                 ["note", t.get("note")] if t.get("note") else None,
                                                 ["worktree", worker.get("worktree")] if worker.get("worktree") else None) if x]})
    rv = d.get("review")
    if rv:
        phases.append({"title": "리뷰", "mode": "sequential"})
        for p in rv.get("passes") or []:
            items.append({"id": f"review:{p.get('id')}", "label": p.get("name") or p.get("id"), "tag": None, "phase": "리뷰",
                          "state": MATT_STATE.get(p.get("status"), "queued"),
                          "sub": f"지적 {p['findings']}" if p.get("findings") is not None else "",
                          "facts": [rv.get("skill")] if rv.get("skill") else [], "blocks": [["note", p.get("note")]] if p.get("note") else []})
    pr = d.get("pr")
    if pr:
        title = f"PR #{pr['number']}" if pr.get("number") else "PR"
        phases.append({"title": title, "mode": "parallel"})
        for i, c in enumerate(pr.get("checks") or []):
            items.append({"id": f"pr:{i}", "label": c.get("name") or "check", "tag": None, "phase": title,
                          "state": MATT_STATE.get(c.get("status"), "queued"), "sub": "",
                          "facts": [x for x in (c.get("detail"),) if x], "blocks": [["PR", pr.get("url")]] if pr.get("url") else []})
    done = sum(1 for t in tickets.values() if t.get("status") == "done")
    stats = f"티켓 {done}/{len(tickets)}" if tickets else ""
    return {"phases": phases, "agentList": items, "stats": stats}


def autocode(d):
    run = d.get("run") or {}
    metric = run.get("metric") or {}
    unit = metric.get("name") or "metric"
    hyps = d.get("hypotheses") or []
    started = [h for h in hyps if h.get("status") not in ("pending", "cancelled")]
    rest = [h for h in hyps if h.get("status") in ("pending", "cancelled")]
    started.sort(key=lambda h: (ms(h.get("startedAt")) or 1 << 62, h.get("seq") or 0))
    rest.sort(key=lambda h: (h.get("priority") or 99))
    phases = [{"title": "실험", "mode": "time"}] if started else []
    if rest:
        phases.append({"title": "Frontier", "mode": "sequential"})
    items = []
    for h in started + rest:
        st = h.get("status")
        delta = h.get("delta")
        worker = h.get("worker") or {}
        items.append({"id": f"hyp:{h.get('id')}", "label": h.get("claim") or "", "tag": h.get("id"),
                      "phase": "실험" if h in started else "Frontier", "state": AUTO_STATE.get(st, "queued"),
                      "start": ms(h.get("startedAt")), "end": ms(h.get("measuredAt")),
                      "stateText": st if st not in ("running",) else None,
                      "sub": f"{delta:+.1f}%" if isinstance(delta, (int, float)) else (h.get("expectedDelta") or ""),
                      "facts": [x for x in (h.get("route"), "/".join(v for v in (worker.get("model"), worker.get("effort")) if v),
                                            f"{unit} {h['metric']}" if h.get("metric") is not None else None,
                                            f"commit {h['commit']}" if h.get("commit") else None,
                                            f"depends on {', '.join(h['dependsOn'])}" if h.get("dependsOn") else None) if x],
                      "blocks": [x for x in (["experiment", h.get("experiment")], ["touches", ", ".join(h.get("touches") or [])],
                                             ["note", h.get("note")], ["obstacle", h.get("obstacle")]) if x[1]]})
    budget = run.get("budget") or {}
    best, base = metric.get("best"), metric.get("baseline")
    stats = " · ".join(x for x in (f"{budget.get('done', 0)}/{budget['max']} 실험" if budget.get("max") else None,
                                   f"{unit} {base} → {best}" if best is not None and base is not None else None,
                                   run.get("terminatedReason")) if x)
    return {"phases": phases, "agentList": items, "stats": stats}
