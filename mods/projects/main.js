import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, focused, exec, run, theme, props, openOverlay, closeOverlay, shared, setShared, knownAgents, notify } from "herdr";
import { contextForSpace } from "./project-context.js";
import { BACKEND } from "./backend-source.js";
import { projectsFrom, checkoutSpaces, spacePath, boundSpace, localSpaceId, issueMatches, issuePrompt } from "./model.js";

const STATE = "projects.catalogs.v1";
const machineKey = m => m ?? "@local";
const label = m => m ?? "This PC";
const textError = e => String(e?.message ?? e);
async function request(machine, data) {
  const r = await exec("python3", ["-c", BACKEND, JSON.stringify(data)], { on: machine });
  let v;
  try { v = JSON.parse(r.stdout); } catch { throw new Error(r.stderr || "Project helper requires Python 3 on this PC"); }
  if (r.code || !v.ok) throw new Error(v.error || r.stderr || "Project operation failed");
  return v.result;
}
function action(id, text, t, click, active = false) {
  return div().id(id).px(8).py(5).rounded(5).text_size(12).cursor_pointer()
    .bg(active ? t.selected : t.surface).text_color(active ? t.accent : t.foreground)
    .hover(s => s.bg(t.hover)).child(text).on_click(click);
}
function field(state, t) {
  return Input.new(state).h(30).px(8).items_center().rounded(5).border_1().border_color(t.border).bg(t.background).text_color(t.foreground);
}
function issueHost(issue) {
  const match = /^https:\/\/([^/]+)\//.exec(issue.url ?? "");
  return match?.[1]?.toLowerCase() ?? issue.host ?? "github.com";
}
export default class Projects extends View {
  init(_p, cx) {
    this.mode = props()?.mode ?? "sidebar";
    this.catalogs = shared(STATE) ?? {};
    this.errors = {};
    this.busy = false;
    this.error = "";
    this.loading = false;
    this.prepared = null;
    this.issueLoading = false;
    this.issueLoadTicket = 0;
    this.folded = {};
    this.issue = props()?.issue ? { ...props().issue, host: issueHost(props().issue) } : null;
    this.projectId = props()?.projectId ?? shared("projects.selected");
    this.locationId = props()?.locationId ?? null;
    this.machine = props()?.machine ?? null;
    this.issues = [];
    this.issueLoaded = false;
    this.agents = [];
    this.agentIndex = -1;
    this.additional = false;
    this.pending = null;
    this.retryWorkId = props()?.workId ?? null;
    this.agentTicket = 0;
    this.polling = false;
    this.base = InputState.new({ value: "", placeholder: "Base ref, e.g. origin/main" });
    this.branch = InputState.new({ value: this.issue ? `issue/${this.issue.number}` : "", placeholder: "Branch name" });
    this.path = InputState.new({ value: props()?.path ?? "", placeholder: "Repository path on selected PC" });
    this.name = InputState.new({ value: "", placeholder: "Project name (optional)" });
    this.filter = InputState.new({ value: "", placeholder: "Filter issues" });
    for (const input of [this.base, this.branch, this.path, this.name, this.filter]) input.on("change", (_e, cx) => cx.notify());
    // Live Herdr data rerenders automatically. Catalogs include on-disk Git data.
    if (this.mode === "start") this.prepare(cx);
    this.refresh(cx);
    cx.timer.every(20000, cx => this.refresh(cx));
    cx.timer.every(250, cx => { if (this.pending) this.reconcile(cx); });
  }

  all() { return projectsFrom(shared(STATE) ?? this.catalogs); }
  project() {
    const all = this.all();
    return this.issue ? all.find(p => p.id === this.projectId && issueMatches(p, this.issue)) ?? all.find(p => issueMatches(p, this.issue)) : all.find(p => p.id === this.projectId) ?? all[0];
  }
  location() {
    const p = this.project();
    return p?.locations.find(l => l.id === this.locationId && machineKey(l.machine) === machineKey(this.machine)) ??
      p?.locations.find(l => !l.offline && !l.error) ?? p?.locations[0];
  }
  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async cx => {
      const targets = machines().map(m => m.name);
      if (!targets.includes(null)) targets.unshift(null);
      const before = shared(STATE) ?? {};
      const entries = await Promise.all(targets.map(async machine => {
        const key = machineKey(machine);
        try { return [key, { ...await request(machine, { op: "list" }), machine, offline: false }]; }
        catch (e) {
          this.errors[key] = textError(e);
          return [key, { ...(before[key] ?? {}), machine, offline: true, error: textError(e) }];
        }
      }));
      this.catalogs = Object.fromEntries(entries);
      for (const [key, old] of Object.entries(before)) if (!this.catalogs[key]) this.catalogs[key] = { ...old, offline: true, error: "PC is no longer connected" };
      setShared(STATE, this.catalogs);
      this.loading = false;
      if (this.mode === "start" && !this.prepared) this.prepare(cx);
      cx.notify();
    });
  }
  async refreshOne(machine) {
    const catalog = { ...await request(machine, { op: "list" }), machine, offline: false };
    setShared(STATE, { ...(shared(STATE) ?? {}), [machineKey(machine)]: catalog });
    return catalog;
  }
  fail(e, cx) { this.error = textError(e); this.busy = false; cx.notify(); }
  overlay(mode, extra = {}) {
    openOverlay({ mod: "projects", kind: "dialog", width: mode === "issues" || mode === "manager" ? 760 : 610, height: mode === "issues" || mode === "manager" ? 680 : 570,
      props: { mode, projectId: this.project()?.id, ...extra } });
  }
  prepare(cx) {
    const l = this.location();
    if (!l) return;
    this.prepared = `${machineKey(l.machine)}:${l.id}`;
    this.base.set_value(l.base || "HEAD");
    this.loadAgents(l.machine, cx);
  }
  loadAgents(machine, cx) {
    const ticket = ++this.agentTicket;
    this.agents = []; this.agentIndex = -1;
    cx.spawn(async cx => {
      try {
        const list = (await knownAgents({ on: machine })).filter(a => a.installed && a.run?.length);
        if (this.agentTicket === ticket) this.agents = list;
      } catch (e) { if (this.agentTicket === ticket) this.error = textError(e); }
      cx.notify();
    });
  }
  selectLocation(l, cx) {
    this.locationId = l.id; this.machine = l.machine;
    this.prepared = null; this.prepare(cx);
    this.issueLoaded = false; this.issueLoadTicket = (this.issueLoadTicket ?? 0) + 1;
    this.issues = []; this.error = ""; cx.notify();
  }
  register(cx) {
    if (this.busy || !this.path.value().trim()) return;
    this.busy = true; this.error = "";
    const machine = this.machine;
    cx.spawn(async cx => {
      try {
        const l = await request(machine, { op: "register", path: this.path.value().trim(), name: this.name.value() });
        await this.refreshOne(machine);
        setShared("projects.selected", l.projectId);
        this.busy = false;
        closeOverlay(props().overlay);
        notify({ title: "Project registered", body: `${l.name} · ${label(machine)}` });
      } catch (e) { this.fail(e, cx); }
    });
  }
  loadIssues(cx) {
    const l = this.location();
    if (!l || l.offline || l.error || this.issueLoading) return;
    this.issueLoading = true; this.error = "";
    const ticket = this.issueLoadTicket = (this.issueLoadTicket ?? 0) + 1;
    cx.spawn(async cx => {
      try {
        const list = await request(l.machine, { op: "issues", locationId: l.id });
        if (ticket === this.issueLoadTicket) { this.issues = list; this.issueLoaded = true; }
      } catch (e) { if (ticket === this.issueLoadTicket) this.error = textError(e); }
      this.issueLoading = false; cx.notify();
    });
  }
  begin(cx) {
    const l = this.location();
    if (this.busy || !l || l.offline || l.error) return;
    if (this.issue && !issueMatches(this.project(), this.issue)) { this.error = "Select a checkout of this issue's repository."; cx.notify(); return; }
    const leaseKey = `${l.machineId}:${l.id}:${this.issue?.number ?? this.branch.value()}`;
    const lease = shared("projects.creating") ?? {};
    if (lease[leaseKey] && Date.now() - lease[leaseKey] < 45000) { this.error = "This work is already being opened."; cx.notify(); return; }
    setShared("projects.creating", { ...lease, [leaseKey]: Date.now() });
    this.busy = true; this.error = "";
    const argv = this.agentIndex >= 0 ? this.agents[this.agentIndex]?.run : null;
    cx.spawn(async cx => {
      try {
        const work = await request(l.machine, { op: "start", locationId: l.id, issue: this.issue, additional: this.additional,
          branch: this.branch.value(), base: this.base.value(), workId: this.retryWorkId });
        this.retryWorkId = work.id;
        await this.refreshOne(l.machine);
        this.open(work, l.machine, cx, argv, leaseKey);
      } catch (e) { this.release(leaseKey); this.fail(e, cx); }
    });
  }
  release(key) {
    const state = { ...(shared("projects.creating") ?? {}) }; delete state[key]; setShared("projects.creating", state);
  }
  open(work, machine, cx, argv = null, leaseKey = null) {
    if (machines().find(m => m.name === machine)?.layout === "unavailable") {
      if (leaseKey) this.release(leaseKey);
      return this.fail(new Error("This PC is offline; work was preserved."), cx);
    }
    const spaceList = spaces(), paneList = panes();
    const existing = boundSpace(work, machine, spaceList, paneList);
    if (existing) {
      run("space.select", { id: existing.id });
      cx.spawn(async cx => {
        try { await request(machine, { op: "bind", workId: work.id, spaceId: localSpaceId(existing) }); await this.refreshOne(machine); }
        catch (e) { this.fail(e, cx); return; }
        if (leaseKey) this.release(leaseKey);
        this.busy = false; if (props().overlay) closeOverlay(props().overlay); cx.notify();
      });
      return;
    }
    const matches = checkoutSpaces(work.path, machine, spaceList, paneList);
    if (matches.length > 1) { if (leaseKey) this.release(leaseKey); return this.fail(new Error("Multiple spaces use this worktree. Select one in the sidebar."), cx); }
    try {
      run("space.new", { machine, folder: work.path, name: work.issue ? `#${work.issue.number} ${work.title}` : work.title,
        ...(argv ? { argv, ...(this.issue ? { task: issuePrompt(this.issue) } : {}) } : {}) });
      this.pending = { work, machine, leaseKey, until: Date.now() + 10000 };
      this.busy = true; cx.notify();
    } catch (e) { if (leaseKey) this.release(leaseKey); this.fail(e, cx); }
  }
  reconcile(cx) {
    if (this.polling || !this.pending) return;
    const p = this.pending;
    const matches = checkoutSpaces(p.work.path, p.machine, spaces(), panes());
    if (matches.length === 1) {
      this.polling = true;
      cx.spawn(async cx => {
        try {
          await request(p.machine, { op: "bind", workId: p.work.id, spaceId: localSpaceId(matches[0]) });
          await this.refreshOne(p.machine);
          run("space.select", { id: matches[0].id });
          this.busy = false; this.pending = null;
          if (props().overlay) closeOverlay(props().overlay);
        } catch (e) { this.pending = null; this.fail(e, cx); }
        if (p.leaseKey) this.release(p.leaseKey);
        this.polling = false; cx.notify();
      });
    } else if (Date.now() > p.until || matches.length > 1) {
      this.pending = null; if (p.leaseKey) this.release(p.leaseKey);
      this.fail(new Error("Worktree is ready. Space creation could not be confirmed; reopen this work to retry."), cx);
    }
  }
  header(title, t) {
    return h_flex().gap(8).items_center().child(div().flex_1().font_semibold().child(title))
      .when(!!props().overlay, e => e.child(action("close", "Close", t, () => closeOverlay(props().overlay))));
  }
  locationPicker(t, cx) {
    const p = this.project(), chosen = this.location();
    return v_flex().gap(5).children((p?.locations ?? []).map(l => action(`loc-${machineKey(l.machine)}-${l.id}`,
      `${label(l.machine)} · ${l.path}${l.offline ? " · offline" : l.error ? " · unavailable" : ""}`, t,
      (_e, cx) => this.selectLocation(l, cx), chosen === l || !!chosen && chosen.id === l.id && chosen.machine === l.machine)));
  }
  renderDialog(cx, t) {
    if (this.mode === "register") {
      return this.dialog(t).child(this.header("Add project location", t))
        .child(div().text_color(t.muted).child("Choose the PC and an existing Git checkout. Locations of the same remote are grouped into one project."))
        .child(h_flex().gap(5).flex_wrap().children(machines().map(m => action(`machine-${machineKey(m.name)}`, label(m.name), t, (_e, cx) => { this.machine = m.name; cx.notify(); }, m.name === this.machine))))
        .child(field(this.path, t)).child(field(this.name, t)).child(this.errorView(t))
        .child(action("register", this.busy ? "Registering…" : "Register location", t, (_e, cx) => this.register(cx)));
    }
    const p = this.project(), l = this.location();
    const result = this.dialog(t).child(this.header(this.mode === "issues" ? `${p?.name ?? "Project"} · Issues` : "Start workspace", t));
    if (!p) return result.child(div().text_color(t.muted).child(this.loading ? "Loading projects…" : "Register this issue's repository on a PC first."))
      .child(action("add-missing", "Add repository location", t, () => this.overlay("register")));
    if (this.mode === "start" && this.issue) result.child(div().font_semibold().child(`#${this.issue.number} ${this.issue.title}`));
    result.child(this.locationPicker(t, cx));
    if (this.mode === "issues") {
      result.child(h_flex().gap(6).child(div().flex_1().child(field(this.filter, t)))
        .child(action("load-issues", this.issueLoading ? "Loading…" : "Refresh issues", t, (_e, cx) => this.loadIssues(cx))));
      if (!this.issueLoaded && !this.issueLoading && !this.error && !this.loading) this.loadIssues(cx);
      const query = this.filter.value().toLowerCase();
      const list = this.issues.filter(i => `${i.number} ${i.title}`.toLowerCase().includes(query));
      result.child(v_flex().id("project-issues").flex_1().min_h(0).overflow_y_scrollbar().gap(5).children(list.map(i =>
        v_flex().id(`issue-${i.number}`).p(9).gap(6).rounded(6).border_1().border_color(t.border)
          .child(div().child(`#${i.number} ${i.title}`))
          .child(h_flex().gap(5)
            .child(action(`issue-view-${i.number}`, "Details", t, () => openOverlay({ mod: "issues-projects", kind: "dialog", width: 0.86, height: 0.9,
              props: { issue: { repo: l.identity.slug, number: i.number, on: l.machine, data: i, host: l.identity.host } } })))
            .child(action(`issue-start-${i.number}`, "Start workspace", t, () => this.overlay("start", { locationId: l.id, machine: l.machine,
              issue: { ...i, repo: l.identity.slug, host: l.identity.host } })))))));
      if (this.issueLoaded && !list.length) result.child(div().text_color(t.muted).child("No matching open issues."));
    } else {
      result.child(div().text_color(t.muted).child("Base branch")); result.child(field(this.base, t));
      result.child(div().text_color(t.muted).child("Work branch")); result.child(field(this.branch, t));
      result.child(div().text_color(t.muted).child("Start with"));
      result.child(h_flex().gap(5).flex_wrap().child(action("shell", "Shell", t, (_e, cx) => { this.agentIndex = -1; cx.notify(); }, this.agentIndex < 0))
        .children(this.agents.map((a, n) => action(`agent-${n}`, a.name ?? a.id ?? a.run[0], t, (_e, cx) => { this.agentIndex = n; cx.notify(); }, this.agentIndex === n))));
      if (this.issue) result.child(action("additional", this.additional ? "✓ Create additional work" : "Reopen linked work if it exists", t, (_e, cx) => { this.additional = !this.additional; this.retryWorkId = null; this.branch.set_value(`issue/${this.issue.number}${this.additional ? "-" + Date.now().toString(36) : ""}`); cx.notify(); }, this.additional));
      result.child(action("start-work", this.busy ? "Opening workspace…" : "Start workspace", t, (_e, cx) => this.begin(cx)));
    }
    return result.child(this.errorView(t));
  }
  dialog(t) { return v_flex().id("projects-dialog").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13); }
  errorView(t) { return div().text_size(12).text_color(t.blocked).child(this.error || ""); }
  render(cx) {
    const t = theme();
    if (this.mode === "toolbar") {
      const space = spaces().find(s => s.active);
      const context = contextForSpace(space, panes(), shared(STATE));
      return h_flex().size_full().items_center().justify_end().gap(4).pr(8).bg(t.chrome)
        .child(action("space-issues", "Issues", t, () => {
          if (context) this.overlay("issues", { projectId: context.projectId, locationId: context.location.id, machine: context.machine });
          else { run("layout.select", { stack: "panel-body", child: "issues" }); run("layout.show", { id: "panel" }); }
        }))
        .child(action("project-options", "⋯", t, () => this.overlay("manager")));
    }
    if (this.mode !== "sidebar" && this.mode !== "manager") return this.renderDialog(cx, t);
    const all = this.all();
    const body = v_flex().id("projects").size_full().min_h(0).gap(5).bg(t.chrome).text_color(t.foreground).text_size(12)
      .child(h_flex().px(8).gap(5).items_center().child(div().flex_1().font_semibold().child("PROJECTS"))
        .when(!!props()?.overlay, e => e.child(action("close-project-manager", "Close", t, () => closeOverlay(props().overlay))))
        .child(action("refresh-projects", this.loading ? "…" : "↻", t, (_e, cx) => this.refresh(cx)))
        .child(action("add-project", "+", t, () => {
          const s = spaces().find(s => s.active); const f = focused();
          this.overlay("register", { machine: s?.machine ?? null, path: f?.cwd || (s ? spacePath(s, panes()) : "") });
        })))
      .child(v_flex().id("projects-list").flex_1().min_h(0).overflow_y_scrollbar().gap(5).px(6)
        .children(all.map(p => this.renderProject(p, cx, t)))
        .when(!all.length, e => e.child(div().p(8).text_color(t.muted).child(this.loading ? "Reading PCs…" : "Add a Git checkout with +. The same repository on other PCs joins this project."))))
      .child(this.errorView(t));
    const failures = Object.values(shared(STATE) ?? {}).filter(c => c.offline);
    if (failures.length) body.child(div().px(8).py(4).text_color(t.dim).child(failures.map(f => `${label(f.machine)} unavailable`).join(" · ")));
    return body;
  }
  renderProject(p, cx, t) {
    const selected = p.id === shared("projects.selected"), folded = this.folded[p.id];
    const out = v_flex().gap(3).pb(5).child(h_flex().gap(3).items_center()
      .child(div().id(`project-${p.id}`).flex_1().px(5).py(6).rounded(5).cursor_pointer().bg(selected ? t.selected : t.chrome)
        .on_click((_e, cx) => { this.projectId = p.id; setShared("projects.selected", p.id); this.folded[p.id] = !folded; cx.notify(); })
        .child(`${folded ? "▸" : "▾"} ${p.name}`))
      .child(action(`issues-${p.id}`, "Issues", t, () => this.overlay("issues", { projectId: p.id })))
      .child(action(`new-${p.id}`, "+", t, () => this.overlay("start", { projectId: p.id }))));
    if (folded) return out;
    out.child(div().pl(16).text_size(10).text_color(t.dim).child(p.id));
    for (const l of p.locations) {
      out.child(div().pl(16).py(3).text_color(l.offline || l.error ? t.blocked : t.accent).child(`${label(l.machine)}${l.offline ? " · offline" : ""}`));
      out.child(div().pl(23).text_size(10).text_color(t.dim).child(l.path));
      if (l.error) out.child(div().pl(23).text_color(t.blocked).child(l.error));
      for (const w of l.works) {
        const s = boundSpace(w, l.machine, spaces(), panes());
        const live = s?.branch ?? l.checkouts?.find(c => c.path === w.path)?.branch;
        const title = `${w.issue ? `#${w.issue.number} ` : ""}${w.title}`;
        out.child(v_flex().id(`work-${l.machineId}-${w.id}`).ml(22).p(6).gap(2).rounded(5).cursor_pointer().hover(e => e.bg(t.hover))
          .on_click((_e, cx) => {
            if (w.state === "failed" || w.state === "creating") {
              this.overlay("start", { projectId: p.id, locationId: l.id, machine: l.machine, issue: w.issue, workId: w.id });
            } else this.open(w, l.machine, cx);
          }).child(div().text_color(s?.active ? t.accent : t.foreground).child(title))
          .child(div().text_size(10).text_color(t.muted).child(`${live ?? w.branch} · ${s?.status ?? (s ? "open" : w.state)}`))
          .when(!!w.error, e => e.child(div().text_color(t.blocked).child(w.error))));
      }
      for (const c of l.checkouts ?? []) {
        if (l.works.some(w => w.path === c.path)) continue;
        const matches = checkoutSpaces(c.path, l.machine, spaces(), panes(), l.checkouts);
        out.child(div().id(`checkout-${l.machineId}-${l.id}-${c.path}`).ml(22).px(6).py(4).rounded(4).cursor_pointer().hover(e => e.bg(t.hover))
          .text_color(matches.some(s => s.active) ? t.accent : t.muted).child(`${c.branch ?? `Detached ${(c.head ?? "").slice(0, 7)}`}${matches.length ? " · open" : ""}`)
          .on_click(() => {
            if (l.offline || l.error) return;
            if (matches.length === 1) run("space.select", { id: matches[0].id });
            else if (!matches.length) run("space.new", { machine: l.machine, folder: c.path });
          }));
      }
    }
    return out;
  }
}
