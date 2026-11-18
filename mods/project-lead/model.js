// Pure data for the project-lead panel: lead-state.json (written by the herdr-lead
// skill) joined with the project-spaces registry (roles per PC) and live terminals.
//
// lead-state.json:
//   { version: 1, updated_ms, projects: { [projectKey]: { name, tasks: [
//     { id, role, machine, path, terminal, branch, scope, status, created_ms, updated_ms,
//       report: { text, file, at_ms } | null, notes: [{ text, at_ms }] } ] } } }
// Dispatched terminals also carry labels herdr-lead.project / .role / .task.

export const ROLES = ["impl", "qa", "plan"];
export const ACTIVE = ["queued", "dispatched", "working", "reported", "awaiting-user", "blocked"];
export const LABEL = { project: "herdr-lead.project", role: "herdr-lead.role", task: "herdr-lead.task" };

export const machineKey = (m) => (m == null || m === "" || m === "local" ? "" : m);

export function parseState(text) {
  if (text == null || !String(text).trim()) return { version: 1, projects: {} };
  const raw = JSON.parse(text);
  const out = { version: 1, updated_ms: raw?.updated_ms ?? null, projects: {} };
  for (const [key, p] of Object.entries(raw?.projects ?? {})) {
    if (!key || !p || typeof p !== "object") continue;
    const tasks = (Array.isArray(p.tasks) ? p.tasks : []).filter((t) => t && typeof t.id === "string")
      .map((t) => ({ ...t, machine: machineKey(t.machine), role: ROLES.includes(t.role) ? t.role : "impl" }));
    out.projects[key] = { name: String(p.name ?? "") || key.split("/").pop(), tasks };
  }
  return out;
}

// What the panel shows for one terminal: "working" | "idle" | "blocked" | "done" |
// "error" | "exited" | "gone" | null (unknown yet).
export function liveOf(term) {
  if (!term) return null;
  if (term.state === "finished") return "exited";
  const s = term.status ?? null;
  return typeof s === "string" ? s : s?.word ?? s?.status ?? "live";
}

// Shown status: the task's own (set by the lead), refined by its terminal while it runs.
export function shownStatus(task, live) {
  const own = task.status ?? "dispatched";
  if (!["dispatched", "working"].includes(own)) return own;
  if (live === "blocked" || live === "error") return live;
  if (live === "exited" || live === "gone") return own === "working" ? "exited" : own;
  if (live === "working") return "working";
  if (live === "idle" || live === "done") return own === "working" ? "idle" : own;
  return own;
}

// Rows: one per (PC, role) the person assigned in the registry, plus any (PC, role) that
// only appears in tasks. Each row has its current task and its last report.
//   [{ projectKey, name, rows: [{ machine, role, task, report, live, status }] }]
export function buildView({ state, registry, liveByAddress = {} }) {
  const keys = new Set([...Object.keys(state?.projects ?? {})]);
  for (const [k, p] of Object.entries(registry?.projects ?? {}))
    if (Object.values(p.pcs ?? {}).some((pc) => (pc.roles ?? []).length)) keys.add(k);
  const out = [];
  for (const key of keys) {
    const reg = registry?.projects?.[key];
    const st = state?.projects?.[key];
    const slots = new Map();
    const slot = (machine, role) => {
      const id = `${machineKey(machine)}|${role}`;
      if (!slots.has(id)) slots.set(id, { machine: machineKey(machine), role, tasks: [], assigned: false });
      return slots.get(id);
    };
    for (const [m, pc] of Object.entries(reg?.pcs ?? {})) for (const r of pc.roles ?? []) slot(m, r).assigned = true;
    for (const t of st?.tasks ?? []) slot(t.machine, t.role).tasks.push(t);
    const rows = [...slots.values()].map((s) => {
      const tasks = [...s.tasks].sort((a, b) => (b.updated_ms ?? 0) - (a.updated_ms ?? 0));
      const task = tasks.find((t) => ACTIVE.includes(t.status)) ?? tasks[0] ?? null;
      const withReport = tasks.filter((t) => t.report?.text).sort((a, b) => (b.report.at_ms ?? 0) - (a.report.at_ms ?? 0));
      const live = task?.terminal ? liveByAddress[task.terminal] ?? null : null;
      return { machine: s.machine, role: s.role, assigned: s.assigned, task, live,
        status: task ? shownStatus(task, live) : null,
        report: withReport[0] ? { task: withReport[0].id, ...withReport[0].report } : null };
    });
    // This computer first, then machines by name; roles in impl, qa, plan order.
    rows.sort((a, b) => (a.machine === "" ? -1 : b.machine === "" ? 1 : a.machine.localeCompare(b.machine))
      || ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
    const waiting = rows.filter((r) => r.status === "awaiting-user" || r.status === "blocked").length;
    out.push({ projectKey: key, name: st?.name || reg?.name || key.split("/").pop(), rows, waiting });
  }
  return out.sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name));
}

// Terminal addresses whose status the panel must ask hc for (not in terminals()).
export function addressesToPoll(state, liveByAddress) {
  const out = new Set();
  for (const p of Object.values(state?.projects ?? {}))
    for (const t of p.tasks ?? [])
      if (t.terminal && ["dispatched", "working", "blocked"].includes(t.status) && !(t.terminal in liveByAddress)) out.add(t.terminal);
  return [...out];
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const oneLine = (text, n = 140) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
