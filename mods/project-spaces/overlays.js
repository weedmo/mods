// Overlay entry points of project-spaces. The sidebar opens its own mod as an overlay
// with exactly one of these props:
//   { addPc:    { projectKey, name, remotes? } }  project header "+": Add PC dialog
//   { roles:    { projectKey, name, machine } }   PC header right-click: role menu
//   { newSpace: { projectKey, name, machine } }   PC header "+": create a space on that PC
//
// Add PC: pick a PC, then (A) connect an existing checkout there or (B) clone the
// project there. New space: open a linked checkout, a new worktree of it (base +
// branch) or a subfolder of it. Folders are browsed on the PC itself (folder-browser.js);
// every machine operation is in backend.js (argv only). The registry is written only
// through updateRegistry (atomic, expected-compare).
// Roles: toggle impl / QA / plan for this project on this PC, saved at once.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { closeOverlay, openOverlay, run, shared, hc, notify, readTextFile, appHome, checking } from "herdr";
import { ROLES, cleanRoles, setRoles } from "./project-model.js";
import { mergeCatalogs, machineKey, emptyRegistry, decideConnect, linkPath, remoteKey, repoName, suggestCloneUrl, normalizeRemote, normPath, remoteScheme, remoteUrl } from "./project-model.js";
import { sharedRegistry, loadRegistry, updateRegistry, CATALOGS } from "./registry.js";
import { inspectGit, preflightClone, remoteBranches, startClone, cloneProgress, removeTerminal, removeCreated, redactUrl, hasCredentials,
  branches, addWorktree, worktreePath, remoteHome, parentOf, validBranch } from "./backend.js";
import { FolderBrowser, rememberRecent } from "./folder-browser.js";
import { button, dialog, note, roleBadge, pcLabel, icon, field, message, card } from "./ui.js";

export const OVERLAY_KINDS = ["addPc", "roles", "newSpace"];

// Opening helpers, used by the sidebar.
export const openAddPc = (projectKey, name, remotes = []) =>
  openOverlay({ mod: "project-spaces", kind: "dialog", modal: true, width: 600,
    props: { addPc: { projectKey, name, remotes: [...new Set(remotes.filter(Boolean).map(redactUrl))] } } });
export const openRoles = (projectKey, name, machine, remote = null) =>
  openOverlay({ mod: "project-spaces", kind: "popup", width: 260, height: 170,
    props: { roles: { projectKey, name, machine: machine ?? null, remote: remote ? redactUrl(remote) : null } } });
export const openNewSpace = (projectKey, name, machine) =>
  openOverlay({ mod: "project-spaces", kind: "dialog", modal: true, width: 600, props: { newSpace: { projectKey: projectKey ?? null, name, machine: machine ?? null } } });

// Which overlay these props ask for, or null for the sidebar itself.
export function overlayOf(p) {
  for (const kind of OVERLAY_KINDS) if (p?.[kind]) return { kind, spec: p[kind], overlay: p.overlay };
  return null;
}

const merged = (registry) => mergeCatalogs(registry ?? sharedRegistry() ?? emptyRegistry(), shared(CATALOGS) ?? {});

// The PC's linked checkout paths (registry plus project catalogs).
export function linkedPaths(projectKey, machine, registry) {
  if (!projectKey) return [];
  return merged(registry).projects[projectKey]?.pcs[machineKey(machine)]?.paths ?? [];
}
export function pcRoles(projectKey, machine) {
  return sharedRegistry()?.projects[projectKey]?.pcs[machineKey(machine)]?.roles ?? [];
}
// Every origin URL known for a project (registry, catalogs, the sidebar's), redacted.
export function knownRemotes(projectKey, extra = []) {
  const out = [...extra];
  const p = merged().projects[projectKey];
  if (p?.remote) out.push(p.remote);
  for (const cat of Object.values(shared(CATALOGS) ?? {}))
    for (const loc of cat?.locations ?? []) if ((loc.identity?.key ?? loc.projectId ?? remoteKey(loc.remote)) === projectKey && loc.remote) out.push(loc.remote);
  return [...new Set(out.map(redactUrl).filter((u) => remoteKey(u) === projectKey))];
}
// Clone URL to prefill: the scheme the project's links use; never with credentials.
export function cloneUrlFor(projectKey, remotes = []) {
  const known = knownRemotes(projectKey, remotes);
  const project = { remote: known[0] ?? null };
  const url = suggestCloneUrl(project, known);
  return redactUrl(url ?? (projectKey ? `https://${projectKey}.git` : ""));
}

const sleep = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
const errText = (e) => String(e?.message ?? e);
// Runs async work in its own task with its own cx (a handler's cx must not be kept
// across an await). Resolves with the work's result.
const spawned = (cx, fn) => new Promise((resolve) => cx.spawn(async (cx) => resolve(await fn(cx))));

export function initOverlay(view, cx) {
  const { kind, spec, overlay } = view.overlayState;
  const close = () => closeOverlay(overlay);
  if (kind === "addPc") view.overlayCtl = new AddPcDialog(spec, close, cx);
  else if (kind === "newSpace") view.overlayCtl = new NewSpaceDialog(spec, close, cx);
  else if (kind === "roles") view.overlayCtl = new RolesMenu(spec, close, cx);
}

export function renderOverlay(view, t) {
  return view.overlayCtl.render(t);
}

// ========================================================================= Roles

const ROLE_HELP = { impl: "Implements tasks on this PC", qa: "Tests and reviews here", plan: "Plans and writes specs here" };

// PC header right-click: toggle impl / QA / plan for this project on this PC.
// Several roles may be on; every toggle is saved at once through updateRegistry.
// Roles are only ever set here, by the person; nothing assigns them automatically.
export class RolesMenu {
  constructor(spec, close, cx) {
    this.spec = spec;
    this.closeOverlay = close;
    this.roles = pcRoles(spec.projectKey, spec.machine);
    this.saving = false;
    this.error = null;
    if (cx && !checking()) cx.spawn(async (cx) => {
      // The file on disk wins over what the sidebar last published.
      const { registry, error } = await loadRegistry().catch((e) => ({ registry: null, error: errText(e) }));
      if (error) this.error = error;
      else if (!this.saving) this.roles = registry.projects[spec.projectKey]?.pcs[machineKey(spec.machine)]?.roles ?? [];
      cx.notify();
    });
  }

  close() { this.closeOverlay(); }

  // Applies one toggle; resolves with the roles now saved.
  async toggle(role) {
    // Only this one role changes, applied to the roles on disk at write time, so a
    // concurrent change to another role (another window, the lead) is not overwritten.
    const on = !this.roles.includes(role);
    const flip = (list) => (on ? [...list.filter((r) => r !== role), role] : list.filter((r) => r !== role));
    this.roles = cleanRoles(flip(this.roles));
    this.saving = true;
    this.error = null;
    try {
      const { projectKey, name, machine, remote } = this.spec;
      const saved = await updateRegistry((reg) => {
        const cur = reg.projects[projectKey]?.pcs[machineKey(machine)]?.roles ?? [];
        return setRoles(reg, projectKey, machine, flip(cur), { name, remote: remote ?? null });
      });
      this.roles = saved.projects[projectKey]?.pcs[machineKey(machine)]?.roles ?? [];
    } catch (e) {
      this.error = errText(e);
      this.roles = pcRoles(this.spec.projectKey, this.spec.machine);
    } finally {
      this.saving = false;
    }
    return this.roles;
  }

  render(t) {
    const rows = ROLES.map((r) => {
      const on = this.roles.includes(r);
      return h_flex().id(`ps-roles-${r}`).h(34).px(8).gap(10).items_center().rounded(6)
        .when(!this.saving, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.spawn(async (cx) => { await this.toggle(r); cx.notify(); }); cx.notify(); }))
        .child(div().size(14).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input)
          .bg(on ? t.accent : t.background).text_size(10).text_color(t.accent_foreground)
          .flex().items_center().justify_center().child(on ? "✓" : ""))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().gap(6).items_center().child(roleBadge(t, r, `ps-roles-badge-${r}`)))
          .child(div().text_size(10.5).text_color(t.dim).truncate().child(ROLE_HELP[r])));
    });
    return v_flex().id("ps-roles").size_full().p(8).gap(4).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(div().px(8).pt(2).text_size(11).text_color(t.dim).truncate().child(`Roles · ${pcLabel(this.spec.machine)} · ${this.spec.name ?? ""}`))
      .children(rows)
      .child(div().px(8).text_size(10.5).text_color(this.error ? t.blocked : t.dim)
        .child(this.error ? `Not saved: ${this.error}` : this.saving ? "Saving…" : "Saved to projects.json. The lead uses these PCs per role."));
  }
}

// ======================================================================== Add PC

export class AddPcDialog {
  constructor(spec, close, cx) {
    this.spec = spec;
    this.key = spec.projectKey;
    this.closeOverlay = close;
    this.step = "pc"; // pc | mode | connect | clone | cloning | failed | confirm-delete | done
    this.machines = null; // [{ name, state }] from hc machine ls
    this.machine = null;
    this.msg = null; // { level, text }
    this.busy = false;
    this.pendingWarn = null; // { path, decision } awaiting "Connect anyway"
    this.result = null; // { path, machine, note }
    this.job = null; // clone job
    this.disposed = false;
    if (cx && !checking()) this.loadMachines(cx);
  }

  close() { this.dispose(); this.closeOverlay(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const job = this.job;
    if (!job) return;
    if (job.state === "live") notify({ title: "Clone still running", body: `${job.target} on ${pcLabel(job.machine)} (${job.address}). Connect it with Add PC when it ends.`, level: "info" });
    else removeTerminal(job.address);
  }

  loadMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        const list = r.code === 0 ? (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary) : [];
        this.machines = [{ name: null, state: "connected" }, ...list.map((m) => ({ name: m.name, state: m.state ?? "unknown" }))];
      } catch (e) {
        this.machines = [{ name: null, state: "connected" }];
        this.msg = { level: "warn", text: `Could not list machines: ${errText(e)}` };
      }
      cx.notify();
    });
  }

  linkedOn(machine) { return linkedPaths(this.key, machine); }

  choosePc(machine, cx) {
    this.machine = machine;
    this.step = "mode";
    this.msg = null;
    cx?.notify();
  }

  // ---- A: connect an existing folder

  // `start`: folder to show first (null: home).
  enterConnect(cx, start = null) {
    this.step = "connect";
    this.msg = null;
    this.pendingWarn = null;
    this.browser = new FolderBrowser({ machine: this.machine, projectKey: this.key, pinned: this.linkedOn(this.machine), id: "ps-fb",
      onChange: () => { this.pendingWarn = null; this.msg = null; } });
    return this.browser.open(start, cx);
  }

  // Resolves with the decision taken: refuse | noop | warn | link.
  connect(path, force, cx) { return spawned(cx, (cx) => this._connect(path, force, cx)); }

  // From a clone name collision: show the existing checkout in the connect step, then
  // connect it (after the browser loaded, since its onChange clears the message).
  connectInstead(cx) {
    const target = this.preflight?.target;
    if (!target) return null;
    return spawned(cx, async (cx) => { await this.enterConnect(cx, target); return this._connect(target, false, cx); });
  }
  async _connect(path, force, cx) {
    this.busy = true;
    this.msg = null;
    cx.notify();
    try {
      const info = await inspectGit(this.machine, path);
      const git = info.git ? { top: info.git.top, remote: info.git.remote, linked: info.git.linked } : null;
      const { registry, error } = await loadRegistry();
      if (error) throw new Error(`projects.json: ${error}`);
      const d = decideConnect({ registry: merged(registry), projectKey: this.key, machine: this.machine, git });
      if (d.action === "refuse") {
        this.msg = { level: "error", text: info.exists ? `${path} is not a git checkout. Only git checkouts can be connected.` : `${path} does not exist.` };
      } else if (d.action === "noop") {
        this.msg = { level: "info", text: `${d.path} is already linked on ${pcLabel(this.machine)}. Nothing changed.` };
      } else if (d.action === "warn" && !force) {
        this.pendingWarn = { path: d.path, decision: d };
        this.msg = { level: "warn", text: d.reason === "no-remote"
          ? `${d.path} has no origin remote. Connect it to ${this.spec.name} anyway?`
          : `${d.path} belongs to ${d.remoteKey}, not ${this.key}. Connect it anyway?` };
      } else {
        await this.link(d.path, git?.remote);
        this.result = { path: d.path, machine: this.machine, note: d.action === "warn" ? "Linked despite the remote warning." : null };
        this.step = "done";
      }
      this.busy = false;
      cx.notify();
      return d.action;
    } catch (e) {
      this.busy = false;
      this.msg = { level: "error", text: errText(e) };
      cx.notify();
      return "error";
    }
  }

  async link(path, remote) {
    const sameRemote = remoteKey(remote) === this.key ? redactUrl(remote) : null;
    await updateRegistry((reg) => linkPath(reg, { projectKey: this.key, machine: this.machine, path, name: this.spec.name, remote: sameRemote ?? knownRemotes(this.key, this.spec.remotes)[0] ?? null }));
    rememberRecent(this.machine, parentOf(path));
  }

  // ---- B: clone

  enterClone(cx) {
    this.step = "clone";
    this.msg = null;
    this.preflight = null;
    const url = cloneUrlFor(this.key, this.spec.remotes ?? []);
    this.urlInput = InputState.new({ value: url, placeholder: "git@host:owner/repo.git or https://…" });
    this.nameInput = InputState.new({ value: repoName(url) ?? normalizeRemote(url)?.slug.split("/").pop() ?? "", placeholder: "folder name" });
    this.branch = ""; // "" = the remote's default branch
    this.branchOpen = false;
    const stale = (_e, cx) => { this.preflight = null; cx.notify(); };
    for (const i of [this.urlInput, this.nameInput]) { i.on("change", stale); i.on("submit", (_e, cx) => this.check(cx)); }
    this.remote = null; // { url, loading, ok, err, list, def }: branches of the URL's remote on that PC
    this.urlInput.on("change", (_e, cx) => { if (this.remote && this.remote.url !== this.urlInput.value().trim()) { this.remote = null; this.branchOpen = false; cx.notify(); } });
    this.loadBranches(cx);
    this.parentBrowser = new FolderBrowser({ machine: this.machine, projectKey: this.key, id: "ps-fb-parent",
      pinned: this.linkedOn(this.machine).map(parentOf), onChange: (_b, cx) => { this.preflight = null; } });
    return this.parentBrowser.open(null, cx);
  }

  cloneSpec() {
    return { parent: this.parentBrowser?.path, name: this.nameInput.value().trim(), url: this.urlInput.value().trim(), branch: this.branch };
  }

  // Lists the remote's branches as seen from that PC, for the branch picker.
  loadBranches(cx) { return spawned(cx, (cx) => this._loadBranches(cx)); }
  async _loadBranches(cx) {
    const url = this.urlInput.value().trim();
    if (!url || (this.remote?.url === url && (this.remote.loading || this.remote.ok))) return;
    this.remote = { url, loading: true, ok: false, err: null, list: [], def: null };
    cx.notify();
    const r = await remoteBranches(this.machine, url).catch((e) => ({ ok: false, err: errText(e), list: [], def: null }));
    if (this.remote?.url !== url) return; // the URL changed meanwhile
    this.remote = { url, loading: false, ...r };
    cx.notify();
  }

  // Branch dropdown: a trigger showing the choice; pressing it toggles the list.
  branchTrigger(t) {
    const r = this.remote;
    const label = this.branch || (r?.def ? `${r.def} (default)` : "Default branch");
    const hint = !r ? "not loaded" : r.loading ? "loading…" : !r.ok ? "can't read remote" : null;
    return v_flex().gap(5)
      .child(div().text_size(11.5).text_color(t.dim).child("Branch"))
      .child(h_flex().id("ps-clone-branch").h(32).px(10).gap(6).items_center().rounded(8).border_1()
        .border_color(this.branchOpen ? t.accent : t.input).bg(t.background).text_size(12.5)
        .cursor_pointer().hover((st) => st.border_color(t.accent))
        .on_click((_e, cx) => {
          this.branchOpen = !this.branchOpen;
          if (this.branchOpen && !(this.remote?.ok || this.remote?.loading)) { this.remote = null; this.loadBranches(cx); }
          cx.notify();
        })
        .child(div().flex_1().min_w(0).truncate().text_color(this.branch ? t.foreground : t.muted).child(hint ? `${label} · ${hint}` : label))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(this.branchOpen ? "▲" : "▼")));
  }

  // The open list under the Name/Branch row: default first, then every remote branch.
  branchList(t) {
    const r = this.remote;
    const box = (children) => v_flex().id("ps-br-list").max_h(180).overflow_y_scrollbar().p(4).rounded(8)
      .border_1().border_color(t.border).bg(t.raised).children(children);
    if (!r || r.loading) return box([div().px(8).py(6).text_size(12).text_color(t.dim).child("Loading branches…")]);
    if (!r.ok) return box([message(t, "ps-br-err", "error", `Can't read the remote: ${r.err}`)]);
    const row = (id, value, label, extra) => {
      const on = value === this.branch;
      return h_flex().id(id).h(26).px(8).gap(8).items_center().rounded(5).text_size(12.5)
        .bg(on ? t.accent + "22" : t.raised).text_color(on ? t.accent : t.foreground)
        .cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => this.pickBranch(value, cx))
        .child(div().w(12).flex_none().child(on ? "✓" : ""))
        .child(div().flex_1().min_w(0).truncate().child(label))
        .when(Boolean(extra), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(extra)));
    };
    return box([
      row("ps-br-def", "", "Default branch", r.def ?? null),
      ...r.list.map((b, n) => row(`ps-br-${n}`, b, b, b === r.def ? "default" : null)),
    ]);
  }

  pickBranch(b, cx) {
    this.branch = b;
    this.branchOpen = false;
    this.preflight = null;
    cx.notify();
  }

  // Rewrites the Remote URL to the same repo over ssh or https and checks again.
  setScheme(scheme, cx) {
    const ident = normalizeRemote(this.urlInput.value().trim());
    const url = remoteUrl(ident, scheme);
    if (!url) return;
    this.urlInput.set_value(url);
    this.preflight = null;
    cx.notify();
    return this.check(cx);
  }

  check(cx) { return spawned(cx, (cx) => this._check(cx)); }
  async _check(cx) {
    if (this.busy) return this.preflight;
    this.busy = true;
    this.msg = null;
    cx.notify();
    try {
      const s = this.cloneSpec();
      this.preflight = await preflightClone(this.machine, s);
      this.preflight.spec = s;
      if (hasCredentials(s.url)) this.preflight.checks.push({ id: "creds", ok: false, level: "warn", text: "The URL carries a password or token; it will be stored in that checkout's .git/config." });
      if (remoteKey(s.url) && remoteKey(s.url) !== this.key) this.preflight.checks.push({ id: "other", ok: false, level: "warn", text: `That URL is ${remoteKey(s.url)}, not ${this.key}.` });
      if (this.preflight.checks.some((c) => c.id === "auth" && c.ok) && !(this.remote?.ok && this.remote.url === s.url)) this._loadBranches(cx).catch(() => {});
      const alt = this.preflight.altUrl;
      if (alt) this.preflight.checks.push({ id: "alt", ok: false, level: "warn",
        text: `${remoteScheme(alt) === "https" ? "HTTPS" : "SSH"} works on this PC: ${alt}. Use it instead.` });
    } catch (e) {
      this.preflight = null;
      this.msg = { level: "error", text: errText(e) };
    }
    this.busy = false;
    cx.notify();
    return this.preflight;
  }

  // Starts the clone (after a passing preflight for the same inputs) and follows it.
  clone(cx) { return spawned(cx, (cx) => this._clone(cx)); }
  async _clone(cx) {
    const s = this.cloneSpec();
    if (!this.preflight?.ok || JSON.stringify(this.preflight.spec) !== JSON.stringify(s)) {
      const p = await this._check(cx);
      if (!p?.ok) return "preflight";
    }
    this.busy = true;
    cx.notify();
    try {
      const started = await startClone(this.machine, s);
      this.job = { ...started, ...s, machine: this.machine, state: "live", exit: null, lines: [], created: false, home: this.parentBrowser.home };
      this.step = "cloning";
    } catch (e) {
      this.busy = false;
      this.msg = { level: "error", text: `Could not start the clone: ${errText(e)}` };
      cx.notify();
      return "error";
    }
    this.busy = false;
    cx.notify();
    return this.follow(cx);
  }

  async follow(cx) {
    const job = this.job;
    for (;;) {
      await sleep(cx, 1000);
      if (this.disposed) return "closed";
      try {
        const p = await cloneProgress(job.address, job.target);
        job.lines = p.lines.length ? p.lines : job.lines;
        job.created ||= p.created;
        if (p.state !== "live") { job.state = "finished"; job.exit = p.exit; break; }
      } catch (e) {
        job.lines = [...job.lines, errText(e)].slice(-8);
      }
      cx.notify();
    }
    if (job.exit === 0) {
      try {
        const info = await inspectGit(this.machine, job.target);
        if (!info.git) throw new Error(`${job.target} is not a checkout after the clone.`);
        await this.link(info.git.top, info.git.remote ?? job.url);
        this.result = { path: info.git.top, machine: this.machine, note: `Cloned ${redactUrl(job.url)}${job.branch ? ` (${job.branch})` : ""}.` };
        this.step = "done";
        await removeTerminal(job.address);
        job.state = "removed";
      } catch (e) {
        this.step = "failed";
        this.msg = { level: "error", text: errText(e) };
      }
    } else {
      // The last lines can trail the exit on a remote machine: read once more.
      await sleep(cx, 500);
      const p = await cloneProgress(job.address, job.target).catch(() => null);
      if (p?.lines.length) job.lines = p.lines;
      job.created ||= Boolean(p?.created);
      // The script exits 90 only when its mkdir failed; past that, the folder is this
      // run's (the preflight saw the target free, and mkdir refuses an existing one).
      if (!job.created && job.exit != null && job.exit !== 90)
        job.created = (await inspectGit(this.machine, job.target).catch(() => null))?.exists === true;
      this.step = "failed";
      this.msg = { level: "error", text: job.exit === 90 ? `${job.target} appeared before the clone; nothing was deleted.` : `git clone failed (exit ${job.exit ?? "?"}).` };
    }
    cx.notify();
    return this.step;
  }

  askDelete(cx) { this.step = "confirm-delete"; cx.notify(); }

  deleteCreated(cx) { return spawned(cx, (cx) => this._deleteCreated(cx)); }
  async _deleteCreated(cx) {
    const job = this.job;
    this.busy = true;
    cx.notify();
    try {
      if (!job?.created) throw new Error("This run did not create that folder; nothing deleted.");
      await removeCreated(job.machine, job);
      job.created = false;
      this.msg = { level: "ok", text: `Deleted ${job.target}.` };
    } catch (e) {
      this.msg = { level: "error", text: errText(e) };
    }
    this.busy = false;
    this.step = "failed";
    cx.notify();
  }

  openSpace() {
    const r = this.result;
    this.close();
    // "" explicitly selects this computer; omitting it would use the focused space's machine.
    run("space.new", { machine: r.machine ?? "", folder: r.path });
  }

  // ---- drawing

  render(t) {
    const title = `Add PC to ${this.spec.name ?? this.key}`;
    const sub = this.machine !== null || this.step !== "pc" ? `${this.key} · ${pcLabel(this.machine)}` : this.key;
    const body = [];
    const foot = [];
    const back = (to, id = "ps-add-back") => button(t, id, "Back", false, (_e, cx) => { this.step = to; this.msg = null; cx.notify(); });
    if (this.step === "pc") {
      body.push(div().text_size(12).text_color(t.dim).child("Which PC should work on this project?"));
      if (!this.machines) body.push(div().text_color(t.dim).child("Loading machines…"));
      else body.push(v_flex().gap(6).children(this.machines.map((m, n) => {
        const linked = this.linkedOn(m.name).length;
        const ok = m.state === "connected";
        return h_flex().id(`ps-add-pc-${n}`).h(36).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.border)
          .when(ok, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choosePc(m.name, cx)))
          .when(!ok, (el) => el.opacity(0.55))
          .child(svg(icon(m.name ? "server" : "monitor")).size(13).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().child(pcLabel(m.name)))
          .when(linked > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child(`${linked} linked`)))
          .child(div().flex_none().text_size(11).text_color(ok ? t.ansi2 : t.dim).child(String(m.state).replace(/_/g, " ")));
      })));
      foot.push(button(t, "ps-add-cancel", "Cancel", false, () => this.close()));
    } else if (this.step === "mode") {
      const linked = this.linkedOn(this.machine);
      if (linked.length) body.push(note(t, `Already linked here: ${linked.join(", ")}`));
      body.push(h_flex().gap(10)
        .child(card(t, "ps-add-mode-connect", "Connect existing folder", "Browse that PC and link a checkout that is already there.", (_e, cx) => this.enterConnect(cx)))
        .child(card(t, "ps-add-mode-clone", "Clone", "git clone the project into a folder on that PC.", (_e, cx) => this.enterClone(cx))));
      foot.push(back("pc"), button(t, "ps-add-cancel", "Cancel", false, () => this.close()));
    } else if (this.step === "connect") {
      body.push(this.browser.render(t, { action: (e) => (e.git ? { label: "Connect", run: (e2, cx) => this.connect(e2.path, false, cx) } : null) }));
      foot.push(back("mode"));
      if (this.pendingWarn) foot.push(button(t, "ps-add-anyway", "Connect anyway", false, (_e, cx) => this.connect(this.pendingWarn.path, true, cx), { disabled: this.busy }));
      foot.push(button(t, "ps-add-connect", this.busy ? "Checking…" : "Connect this folder", true, (_e, cx) => this.connect(this.browser.path, false, cx), { disabled: this.busy || !this.browser.path }));
    } else if (this.step === "clone") {
      const s = this.cloneSpec();
      body.push(div().text_size(11.5).text_color(t.dim).child("Parent folder (the clone goes inside it):"));
      body.push(this.parentBrowser.render(t, { height: 170 }));
      body.push(h_flex().gap(10)
        .child(div().flex_1().child(field(t, "ps-clone-name", "Folder name", this.nameInput, s.parent && s.name ? `→ ${normPath(s.parent)}/${s.name}` : null)))
        .child(div().w(200).flex_none().child(this.branchTrigger(t))));
      if (this.branchOpen) body.push(this.branchList(t));
      body.push(field(t, "ps-clone-url", "Remote URL", this.urlInput));
      const cur = remoteScheme(s.url), canSwitch = Boolean(normalizeRemote(s.url));
      body.push(h_flex().id("ps-clone-scheme").gap(6).items_center()
        .child(div().text_size(11.5).text_color(t.dim).mr(2).child("Protocol"))
        .children(["ssh", "https"].map((sc) => h_flex().id(`ps-scheme-${sc}`).h(24).px(10).items_center().rounded(6).border_1()
          .border_color(cur === sc ? t.accent : t.input).bg(cur === sc ? t.accent + "22" : t.raised)
          .text_size(11.5).text_color(cur === sc ? t.accent : t.foreground)
          .when(!canSwitch || this.busy, (el) => el.opacity(0.5))
          .when(canSwitch && !this.busy && cur !== sc, (el) => el.cursor_pointer().hover((st) => st.opacity(0.85)).on_click((_e, cx) => this.setScheme(sc, cx)))
          .child(sc === "ssh" ? "SSH" : "HTTPS"))));
      for (const [n, c] of (this.preflight?.checks ?? []).entries()) body.push(message(t, `ps-pf-${n}`, c.ok ? "ok" : c.level === "warn" ? "warn" : "error", c.text));
      foot.push(back("mode"));
      if (this.preflight?.existing?.git) foot.push(button(t, "ps-clone-connect", "Connect it instead", false, (_e, cx) => this.connectInstead(cx)));
      const alt = this.preflight?.altUrl;
      if (alt && !this.preflight.ok) foot.push(button(t, "ps-clone-alt", `Use ${remoteScheme(alt) === "https" ? "HTTPS" : "SSH"}`, false, (_e, cx) => this.setScheme(remoteScheme(alt), cx), { disabled: this.busy }));
      foot.push(button(t, "ps-clone-check", this.busy ? "Checking…" : "Check", false, (_e, cx) => this.check(cx), { disabled: this.busy }));
      foot.push(button(t, "ps-clone-go", "Clone", true, (_e, cx) => this.clone(cx), { disabled: this.busy || !this.preflight?.ok }));
    } else if (this.step === "cloning" || this.step === "failed" || this.step === "confirm-delete") {
      const job = this.job;
      body.push(div().text_size(12).child(`${job.state === "live" ? "Cloning into" : "Clone into"} ${job.target} on ${pcLabel(job.machine)}`));
      body.push(v_flex().id("ps-clone-out").h(150).p(8).rounded(8).bg(t.background).border_1().border_color(t.border)
        .overflow_y_scrollbar().text_size(11).text_color(t.muted)
        .children(job.lines.length ? job.lines.map((l, n) => div().id(`ps-clone-l${n}`).truncate().child(l)) : [div().child("Starting…")]));
      if (this.step === "confirm-delete")
        body.push(message(t, "ps-del-confirm", "warn", `Delete ${job.target} on ${pcLabel(job.machine)}? This run created it; everything in it goes.`));
      if (job.address && job.state !== "removed") foot.push(button(t, "ps-clone-peek", "Show terminal", false, () => run("terminal.peek", { terminal: job.address })));
      if (this.step === "failed") {
        if (job.created) foot.push(button(t, "ps-clone-del", "Delete created folder…", false, (_e, cx) => this.askDelete(cx)));
        foot.push(button(t, "ps-clone-retry", "Back", false, (_e, cx) => { removeTerminal(job.address); job.state = "removed"; this.job = null; this.step = "clone"; this.preflight = null; this.msg = null; cx.notify(); }));
        foot.push(button(t, "ps-add-close", "Close", true, () => this.close()));
      } else if (this.step === "confirm-delete") {
        foot.push(button(t, "ps-del-no", "Keep it", false, (_e, cx) => { this.step = "failed"; cx.notify(); }));
        foot.push(button(t, "ps-del-yes", "Delete", true, (_e, cx) => this.deleteCreated(cx), { disabled: this.busy }));
      } else body.push(svg(icon("spinner")).size(14).text_color(t.working).spin(900));
    } else if (this.step === "done") {
      const r = this.result;
      body.push(message(t, "ps-add-done", "ok", `Linked ${r.path} on ${pcLabel(r.machine)}.`));
      if (r.note) body.push(div().text_size(11.5).text_color(t.dim).child(r.note));
      foot.push(button(t, "ps-add-close", "Close", false, () => this.close()));
      foot.push(button(t, "ps-add-open", "Open space", true, () => this.openSpace()));
    }
    if (this.msg) body.push(message(t, "ps-add-msg", this.msg.level, this.msg.text));
    return dialog(t, "ps-add-pc", title, sub, body, foot, () => this.close());
  }
}

// ======================================================================== New space

export class NewSpaceDialog {
  constructor(spec, close, cx) {
    this.spec = spec;
    this.machine = spec.machine ?? null;
    this.closeOverlay = close;
    this.step = "pick"; // pick | browse | worktree | subfolder
    this.msg = null;
    this.busy = false;
    this.checkout = null; // { path, top, main, branch }
  }

  close() { this.closeOverlay(); }

  paths() { return linkedPaths(this.spec.projectKey, this.machine); }

  open(folder) {
    this.close();
    if (folder) rememberRecent(this.machine, folder);
    // "" explicitly selects this computer; omitting it would use the focused space's machine.
    run("space.new", { machine: this.machine ?? "", ...(folder ? { folder } : {}) });
  }

  enterBrowse(cx) {
    this.step = "browse";
    this.msg = null;
    this.browser = new FolderBrowser({ machine: this.machine, projectKey: this.spec.projectKey, pinned: this.paths(), id: "ps-ns-fb" });
    return this.browser.open(this.paths()[0] ?? null, cx);
  }

  // New worktree of the checkout at `path`: reads its repo, branches and the worktree folder.
  enterWorktree(path, cx) { return spawned(cx, (cx) => this._enterWorktree(path, cx)); }
  async _enterWorktree(path, cx) {
    this.busy = true;
    this.msg = null;
    cx.notify();
    try {
      const info = await inspectGit(this.machine, path);
      if (!info.git) throw new Error(`${path} is not a git checkout.`);
      this.checkout = { path, ...info.git };
      this.branchList = await branches(this.machine, info.git.top);
      const settings = JSON.parse((await readTextFile(`${appHome()}/settings.json`).catch(() => null)) || "{}");
      this.wtDir = settings?.worktrees?.directory ?? "~/.herdr/worktrees";
      this.home = await remoteHome(this.machine);
      this.branchInput = InputState.new({ placeholder: "new or existing branch" });
      this.baseInput = InputState.new({ value: info.git.branch ?? "HEAD", placeholder: "base (branch, tag or commit)" });
      const redraw = (_e, cx) => { this.msg = null; cx.notify(); };
      this.branchInput.on("change", redraw);
      this.baseInput.on("change", redraw);
      this.branchInput.on("submit", (_e, cx) => this.createWorktree(cx));
      this.step = "worktree";
    } catch (e) {
      this.msg = { level: "error", text: errText(e) };
    }
    this.busy = false;
    cx.notify();
  }

  worktreeTarget() {
    const b = this.branchInput?.value().trim();
    if (!b || !this.checkout) return null;
    return worktreePath(this.wtDir, this.home, this.checkout.main.split("/").pop(), b);
  }

  createWorktree(cx) { return spawned(cx, (cx) => this._createWorktree(cx)); }
  async _createWorktree(cx) {
    if (this.busy) return null;
    const branch = this.branchInput.value().trim();
    const base = this.baseInput.value().trim();
    if (!branch) { this.msg = { level: "error", text: "Type a branch name." }; cx.notify(); return null; }
    if (!validBranch(branch)) { this.msg = { level: "error", text: "That branch name is not valid." }; cx.notify(); return null; }
    this.busy = true;
    cx.notify();
    try {
      const path = this.worktreeTarget();
      await addWorktree(this.machine, { top: this.checkout.top, path, branch, base });
      this.busy = false;
      this.open(path);
      return path;
    } catch (e) {
      this.busy = false;
      this.msg = { level: "error", text: errText(e) };
      cx.notify();
      return null;
    }
  }

  enterSubfolder(path, cx) {
    this.step = "subfolder";
    this.msg = null;
    this.checkout = { path };
    this.browser = new FolderBrowser({ machine: this.machine, projectKey: this.spec.projectKey, pinned: [path], id: "ps-ns-sub" });
    return this.browser.open(path, cx);
  }

  render(t) {
    const title = `New space on ${pcLabel(this.machine)}`;
    const body = [], foot = [];
    const small = (id, label, action) => div().id(id).flex_none().px(8).h(22).rounded(5).flex().items_center().border_1().border_color(t.input)
      .text_size(11).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.raised))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
    const back = button(t, "ps-ns-back", "Back", false, (_e, cx) => { this.step = "pick"; this.msg = null; cx.notify(); });
    if (this.step === "pick") {
      const paths = this.paths();
      if (paths.length) body.push(v_flex().gap(6).children(paths.map((path, n) => h_flex().id(`ps-new-${n}`).h(36).px(10).gap(8).items_center().rounded(8)
        .border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => this.open(path))
        .child(svg(icon("folder")).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().child(path))
        .child(small(`ps-new-wt-${n}`, "New worktree…", (cx) => this.enterWorktree(path, cx)))
        .child(small(`ps-new-sub-${n}`, "Subfolder…", (cx) => this.enterSubfolder(path, cx))))));
      else body.push(div().text_size(12).text_color(t.muted).child(this.spec.projectKey ? "No linked folder on this PC yet. Browse to one, or add it with the project's +." : "Browse to a folder, or start in this PC's home."));
      body.push(div().text_size(11.5).text_color(t.dim).child("Click a checkout to open it as a space."));
      foot.push(button(t, "ps-new-cancel", "Cancel", false, () => this.close()));
      foot.push(button(t, "ps-new-browse", "Browse…", false, (_e, cx) => this.enterBrowse(cx)));
      foot.push(button(t, "ps-new-home", "Open in home", true, () => this.open(null)));
    } else if (this.step === "browse" || this.step === "subfolder") {
      if (this.step === "subfolder") body.push(div().text_size(11.5).text_color(t.dim).child(`A folder inside ${this.checkout.path}:`));
      body.push(this.browser.render(t, { action: (e) => (e.git && this.step === "browse" ? { label: "Worktree…", run: (e2, cx) => this.enterWorktree(e2.path, cx) } : null) }));
      foot.push(back);
      if (this.step === "browse" && this.browser.self) foot.push(button(t, "ps-ns-wt-here", "New worktree…", false, (_e, cx) => this.enterWorktree(this.browser.path, cx), { disabled: this.busy }));
      foot.push(button(t, "ps-ns-open-here", "Open space here", true, () => this.open(this.browser.path), { disabled: !this.browser.path }));
    } else if (this.step === "worktree") {
      const target = this.worktreeTarget();
      body.push(div().text_size(12).child(`New worktree of ${this.checkout.main}`));
      body.push(h_flex().gap(10)
        .child(div().flex_1().child(field(t, "ps-wt-branch", "Branch", this.branchInput, target ? `→ ${target}` : "Existing branches are checked out; new ones start at the base.")))
        .child(div().w(200).flex_none().child(field(t, "ps-wt-base", "Base", this.baseInput))));
      const chips = (this.branchList ?? []).slice(0, 10);
      if (chips.length) body.push(h_flex().gap(4).flex_wrap().children(chips.map((b, n) => small(`ps-wt-base-${n}`, b, (cx) => { this.baseInput.set_value(b); cx.notify(); }))));
      foot.push(back);
      foot.push(button(t, "ps-wt-create", this.busy ? "Creating…" : "Create worktree", true, (_e, cx) => this.createWorktree(cx), { disabled: this.busy }));
    }
    if (this.busy && this.step === "pick") body.push(div().text_size(11.5).text_color(t.dim).child("Reading the checkout…"));
    if (this.msg) body.push(message(t, "ps-ns-msg", this.msg.level, this.msg.text));
    return dialog(t, "ps-new-space", title, this.spec.name ?? null, body, foot, () => this.close());
  }
}
