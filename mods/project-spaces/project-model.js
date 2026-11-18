// Pure model for the project-spaces sidebar: no herdr imports, so node can test it.
// Projects are identified by their normalized git origin remote (host/owner/repo).
// Machines: herdr uses null for this laptop; the registry uses "" as its key.

export const ROLES = ["impl", "qa", "plan"];
export const OTHER_NAME = "기타";

// ---------------------------------------------------------------- paths, machines

export function normPath(p) {
  const s = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return s === "" && String(p ?? "").startsWith("/") ? "/" : s;
}
export function within(path, root) {
  const p = normPath(path), r = normPath(root);
  if (!p || !r) return false;
  return p === r || p.startsWith(r === "/" ? "/" : r + "/");
}
export const machineKey = (m) => m ?? "";
export const machineOf = (key) => (key === "" || key == null ? null : key);

// Where a space is now: its first terminal's live folder, else where it was made.
export function place(space, panes = []) {
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  return panes.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || "";
}
// Same key space-folders uses for its git cache.
export const where = (space, panes = []) => JSON.stringify([space.machine ?? null, place(space, panes)]);

// ---------------------------------------------------------------- remotes

// Mirrors projects/backend.py remote_identity(): scp-form ssh, ssh://, https, git://.
// Returns null for anything that is not host + owner/repo.
export function normalizeRemote(url) {
  const value = String(url ?? "").trim();
  if (!value) return null;
  let host, path;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme) {
    if (!/^(https?|ssh|git|git\+ssh|ssh\+git)$/i.test(scheme[1])) return null;
    const rest = value.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const authority = rest.slice(0, slash).replace(/^[^@]*@/, "");
    host = authority.startsWith("[") ? authority.slice(1, authority.indexOf("]")) : authority.replace(/:\d*$/, "");
    path = rest.slice(slash).replace(/[?#].*$/, "");
  } else {
    const m = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(value);
    if (!m) return null;
    [, host, path] = m;
  }
  const parts = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (!host || parts.length < 2 || !parts.every(Boolean)) return null;
  const h = host.toLowerCase(), slug = parts.join("/");
  return { host: h, slug, key: `${h}/${slug.toLowerCase()}` };
}
export const remoteKey = (url) => normalizeRemote(url)?.key ?? null;
export const repoName = (url) => normalizeRemote(url)?.slug.split("/").pop() ?? null;

// "ssh" for scp-form / ssh://, "https" for http(s), null otherwise.
export function remoteScheme(url) {
  const v = String(url ?? "").trim();
  if (/^https?:\/\//i.test(v)) return "https";
  if (/^(ssh|git\+ssh|ssh\+git):\/\//i.test(v) || /^(?:[^@/]+@)?[^/:]+:[^/]/.test(v)) return "ssh";
  return null;
}
export function remoteUrl(identity, scheme = "https") {
  if (!identity) return null;
  return scheme === "ssh" ? `git@${identity.host}:${identity.slug}.git` : `https://${identity.host}/${identity.slug}.git`;
}
// Clone URL for a project: the scheme its existing links use (most common wins),
// the registry's own remote when that scheme matches it.
export function suggestCloneUrl(project, knownRemotes = []) {
  const ident = normalizeRemote(project?.remote) ?? null;
  const urls = [project?.remote, ...knownRemotes].filter((u) => u && remoteKey(u) === ident?.key);
  const count = {};
  for (const u of urls) { const s = remoteScheme(u); if (s) count[s] = (count[s] ?? 0) + 1; }
  const scheme = Object.keys(count).sort((a, b) => count[b] - count[a])[0] ?? remoteScheme(project?.remote) ?? "https";
  if (project?.remote && remoteScheme(project.remote) === scheme) return project.remote;
  return remoteUrl(ident, scheme) ?? project?.remote ?? null;
}
export function cloneTarget(parent, name) {
  const n = String(name ?? "").trim();
  if (!n || n === "." || n === ".." || n.includes("/")) return null;
  const p = normPath(parent);
  return p === "/" ? `/${n}` : `${p}/${n}`;
}

// ---------------------------------------------------------------- registry

export const emptyRegistry = () => ({ version: 1, projects: {} });

function cleanPaths(list) {
  const out = [];
  for (const p of list ?? []) {
    const n = normPath(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}
export function cleanRoles(list) {
  const set = new Set((list ?? []).filter((r) => ROLES.includes(r)));
  return ROLES.filter((r) => set.has(r));
}
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Tolerant read. Fields this mod does not know are kept as they are (so a save writes
// them back). Rows it cannot use (a project or PC that is not an object, a non-list
// `paths` / `roles`, unknown roles, empty paths) are left out of `registry` and listed in
// `dropped`; callers must not save over a file that had dropped rows, or the next write
// would lose them. Duplicate / trailing-slash paths are only normalized, not "dropped".
export function inspectRegistry(text) {
  let raw;
  try { raw = typeof text === "string" ? (text.trim() ? JSON.parse(text) : {}) : (text ?? {}); }
  catch { throw new Error("projects.json is not valid JSON"); }
  if (!isObj(raw)) throw new Error("projects.json is not a JSON object");
  const dropped = [];
  if (raw.projects != null && !isObj(raw.projects)) dropped.push("projects (not an object)");
  const projects = {};
  for (const [key, p] of Object.entries(isObj(raw.projects) ? raw.projects : {})) {
    if (!key || !isObj(p)) { dropped.push(`project ${JSON.stringify(key)}`); continue; }
    if (p.pcs != null && !isObj(p.pcs)) dropped.push(`${key}: pcs (not an object)`);
    const pcs = {};
    for (const [m, pc] of Object.entries(isObj(p.pcs) ? p.pcs : {})) {
      if (!isObj(pc)) { dropped.push(`${key}: pc ${JSON.stringify(m)}`); continue; }
      if (pc.paths != null && !Array.isArray(pc.paths)) dropped.push(`${key}/${m}: paths (not a list)`);
      if (pc.roles != null && !Array.isArray(pc.roles)) dropped.push(`${key}/${m}: roles (not a list)`);
      const rawPaths = Array.isArray(pc.paths) ? pc.paths : [];
      const rawRoles = Array.isArray(pc.roles) ? pc.roles : [];
      for (const x of rawPaths) if (typeof x !== "string" || !normPath(x)) dropped.push(`${key}/${m}: path ${JSON.stringify(x)}`);
      for (const r of rawRoles) if (!ROLES.includes(r)) dropped.push(`${key}/${m}: role ${JSON.stringify(r)}`);
      pcs[m] = { ...pc, paths: cleanPaths(rawPaths.filter((x) => typeof x === "string")), roles: cleanRoles(rawRoles) };
    }
    projects[key] = { ...p, name: String(p.name ?? "") || key.split("/").pop(), remote: p.remote ?? null, pcs };
  }
  return { registry: { ...raw, version: raw.version ?? 1, projects }, dropped };
}
export const parseRegistry = (text) => inspectRegistry(text).registry;
export const serializeRegistry = (reg) => JSON.stringify(reg, null, 2) + "\n";

function withProject(reg, key, fn) {
  const projects = { ...reg.projects };
  const next = fn(projects[key]);
  if (next === undefined) delete projects[key]; else projects[key] = next;
  return { ...reg, projects };
}
function ensureProject(p, key, meta = {}) {
  return p ?? { name: meta.name || key.split("/").pop(), remote: meta.remote ?? null, pcs: {} };
}

// Link a checkout path to a project on a machine. Returns `reg` itself when
// nothing changes (duplicate link), a new object otherwise.
export function linkPath(reg, { projectKey, machine, path, name, remote }) {
  const m = machineKey(machine), n = normPath(path);
  if (!projectKey || !n) return reg;
  const cur = reg.projects[projectKey];
  if (cur?.pcs[m]?.paths.includes(n)) return reg;
  return withProject(reg, projectKey, (p) => {
    const base = ensureProject(p, projectKey, { name, remote });
    const pc = base.pcs[m] ?? { paths: [], roles: [] };
    return { ...base, remote: base.remote ?? remote ?? null, pcs: { ...base.pcs, [m]: { ...pc, paths: [...pc.paths, n] } } };
  });
}
export function setRoles(reg, projectKey, machine, roles, meta = {}) {
  const m = machineKey(machine), next = cleanRoles(roles);
  if (!projectKey) return reg;
  const cur = reg.projects[projectKey]?.pcs[m];
  if (cur && cur.roles.join() === next.join()) return reg;
  if (!cur && !next.length) return reg;
  return withProject(reg, projectKey, (p) => {
    const base = ensureProject(p, projectKey, meta);
    const pc = base.pcs[m] ?? { paths: [], roles: [] };
    return { ...base, pcs: { ...base.pcs, [m]: { ...pc, roles: next } } };
  });
}
// Remove one path (or the whole PC when `path` is omitted). A PC with no paths
// and no roles goes; a project with no PCs goes.
export function unlink(reg, projectKey, machine, path) {
  const m = machineKey(machine), p = reg.projects[projectKey], pc = p?.pcs[m];
  if (!pc) return reg;
  const n = path == null ? null : normPath(path);
  if (n != null && !pc.paths.includes(n)) return reg;
  return withProject(reg, projectKey, (proj) => {
    const pcs = { ...proj.pcs };
    const left = n == null ? null : { ...pc, paths: pc.paths.filter((x) => x !== n) };
    if (!left || (!left.paths.length && !left.roles.length)) delete pcs[m]; else pcs[m] = left;
    return Object.keys(pcs).length ? { ...proj, pcs } : undefined;
  });
}
// Fold catalog.json locations (projects mod) in as links. Immutable.
export function mergeCatalogs(reg, catalogs = {}) {
  let out = reg;
  for (const cat of Object.values(catalogs ?? {})) {
    for (const loc of cat?.locations ?? []) {
      const key = loc.identity?.key ?? loc.projectId ?? remoteKey(loc.remote);
      if (!key || !loc.path) continue;
      out = linkPath(out, { projectKey: key, machine: cat.machine ?? null, path: loc.path, name: loc.name, remote: loc.remote });
    }
  }
  return out;
}
export function samePcs(reg, projectKey) {
  return Object.keys(reg.projects[projectKey]?.pcs ?? {});
}

// ---------------------------------------------------------------- folder browser

// entry: { name, path, dir, git: null | { top, remote, linked } }
// kind: "none" | "worktree" | "same-project" | "other-remote" | "git"
export function classifyFolder(entry, projectKey) {
  const g = entry?.git;
  if (!g) return { kind: "none", tags: [], remoteKey: null };
  const key = remoteKey(g.remote);
  const tags = ["git"];
  if (key) tags.push("remote");
  if (key && key === projectKey) tags.push("same-project");
  if (g.linked) tags.push("worktree");
  const kind = g.linked ? "worktree" : !key ? "git" : key === projectKey ? "same-project" : "other-remote";
  return { kind, tags, remoteKey: key };
}

// Mode A decision for a picked folder.
// git: null (not a repo) | { top, remote, linked }
export function decideConnect({ registry, projectKey, machine, git }) {
  if (!git?.top) return { action: "refuse", reason: "not-git" };
  const path = normPath(git.top);
  if (registry.projects[projectKey]?.pcs[machineKey(machine)]?.paths.includes(path)) return { action: "noop", path, reason: "duplicate" };
  const key = remoteKey(git.remote);
  if (!key) return { action: "warn", path, reason: "no-remote" };
  if (key !== projectKey) return { action: "warn", path, reason: "other-remote", remoteKey: key };
  return { action: "link", path, reason: "same-remote" };
}

// ---------------------------------------------------------------- grouping

const URGENCY = ["blocked", "error", "waiting", "working", "done", "idle"];
export function mostUrgent(statuses) {
  let best = null;
  for (const s of statuses ?? []) {
    const i = URGENCY.indexOf(s);
    if (i >= 0 && (best == null || i < URGENCY.indexOf(best))) best = s;
  }
  return best;
}

// Worktree spaces nested under the first main checkout of their repo (as
// space-folders' ordered()). rows: [{ space, git }] in sidebar order.
export function nestRows(rows) {
  const mains = new Set(rows.filter((r) => r.git && !r.git.linked).map((r) => r.git.repo));
  const nested = (r) => r.git?.linked && mains.has(r.git.repo);
  const out = [], placed = new Set();
  for (const r of rows) {
    if (nested(r)) continue;
    out.push({ ...r, tree: null });
    if (!r.git || r.git.linked || placed.has(r.git.repo)) continue;
    placed.add(r.git.repo);
    const kids = rows.filter((k) => nested(k) && k.git.repo === r.git.repo);
    kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
  }
  return out;
}

function deepestMatch(cwd, candidates) {
  let best = null;
  for (const c of candidates) if (within(cwd, c.path) && (!best || normPath(c.path).length > normPath(best.path).length)) best = c;
  return best;
}

// Which project a space belongs to: its origin remote, else the deepest linked
// path (registry or catalog) on its machine containing its folder, else null.
export function projectOfSpace(space, { panes = [], gitInfo = {}, registry, catalogs = {} }) {
  const g = gitInfo[where(space, panes)];
  const key = remoteKey(g?.remote);
  if (key) return key;
  const m = machineKey(space.machine), cwd = place(space, panes);
  const cands = [];
  for (const [k, p] of Object.entries(registry?.projects ?? {}))
    for (const path of p.pcs[m]?.paths ?? []) cands.push({ path, key: k });
  for (const cat of Object.values(catalogs ?? {})) {
    if (machineKey(cat?.machine) !== m) continue;
    for (const loc of cat.locations ?? []) {
      const k = loc.identity?.key ?? loc.projectId;
      if (!k) continue;
      for (const t of [{ path: loc.path }, ...(loc.checkouts ?? [])]) if (t.path) cands.push({ path: t.path, key: k });
    }
  }
  return deepestMatch(cwd, cands)?.key ?? null;
}

// machines: optional [{ name, state }] (herdr machines()); local is always connected.
function isConnected(m, machines, catalogs) {
  if (m === "") return true;
  if (machines) return machines.some((k) => k.name === m && k.state === "connected");
  const cats = Object.values(catalogs ?? {}).filter((c) => machineKey(c?.machine) === m);
  return cats.length ? cats.some((c) => !c.offline) : false;
}
const pcOrder = (a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b));

// Ordered groups for the sidebar:
// [{ projectKey, name, other, pcs: [{ machine, key, connected, roles, paths, rows: [{ space, git, tree }] }] }]
// Projects in order of their first space, then space-less ones by name; "기타" last.
export function groupSpaces({ spaces = [], panes = [], gitInfo = {}, registry = emptyRegistry(), catalogs = {}, machines = null }) {
  const reg = mergeCatalogs(registry, catalogs);
  const projects = new Map(); // key -> { name, firstIndex, pcs: Map<m, rows[]> }
  const touch = (key) => {
    let p = projects.get(key);
    if (!p) { p = { firstIndex: Infinity, pcs: new Map() }; projects.set(key, p); }
    return p;
  };
  const other = new Map(); // m -> rows[]
  spaces.forEach((space, i) => {
    const git = gitInfo[where(space, panes)] ?? null;
    const key = projectOfSpace(space, { panes, gitInfo, registry: reg, catalogs });
    const m = machineKey(space.machine);
    const bucket = key ? touch(key) : null;
    if (bucket) bucket.firstIndex = Math.min(bucket.firstIndex, i);
    const pcs = bucket ? bucket.pcs : other;
    if (!pcs.has(m)) pcs.set(m, []);
    pcs.get(m).push({ space, git });
  });
  for (const [key, p] of Object.entries(reg.projects)) {
    const b = touch(key);
    for (const m of Object.keys(p.pcs)) if (!b.pcs.has(m)) b.pcs.set(m, []);
  }
  const nameOf = (key, rows) => reg.projects[key]?.name
    || normalizeRemote(rows.map((r) => r.git?.remote).find(Boolean))?.slug.split("/").pop()
    || key.split("/").pop();
  const pcList = (key, pcs) => [...pcs.keys()].sort(pcOrder).map((m) => {
    const entry = key ? reg.projects[key]?.pcs[m] : null;
    return { machine: machineOf(m), key: m, connected: isConnected(m, machines, catalogs),
      roles: entry?.roles ?? [], paths: entry?.paths ?? [], rows: nestRows(pcs.get(m)) };
  });
  const out = [...projects.entries()]
    .map(([key, p]) => {
      const pcs = pcList(key, p.pcs);
      return { projectKey: key, name: nameOf(key, pcs.flatMap((x) => x.rows)), other: false, firstIndex: p.firstIndex, pcs };
    })
    .sort((a, b) => a.firstIndex - b.firstIndex || a.name.localeCompare(b.name))
    .map(({ firstIndex, ...g }) => g);
  if (other.size) out.push({ projectKey: null, name: OTHER_NAME, other: true, pcs: pcList(null, other) });
  return out;
}

// { spaceId: projectKey } for shared("project-spaces.projects"); "기타" spaces map to null.
export function spaceProjects(groups) {
  const map = {};
  for (const g of groups) for (const pc of g.pcs) for (const r of pc.rows) map[r.space.id] = g.projectKey;
  return map;
}
// Drag reorder is allowed only within one project + PC.
export function canReorder(groups, fromId, toId) {
  const map = spaceProjects(groups);
  const pcOf = (id) => groups.flatMap((g) => g.pcs).find((pc) => pc.rows.some((r) => r.space.id === id))?.key;
  return fromId in map && toId in map && map[fromId] === map[toId] && pcOf(fromId) === pcOf(toId);
}
