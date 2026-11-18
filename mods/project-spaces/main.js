// Project spaces: the sidebar grouped by project, then by PC, then spaces.
// Derived from space-folders (itself a clone of Herdr's "spaces"); folders are gone.
//
//   Project (normalized git origin: host/owner/repo; ssh and https are the same)
//     PC (this computer first, then machines by name) - connection, role badges
//       spaces on that PC, worktrees nested under their checkout
//   기타: spaces with no git remote and no linked folder, per PC
//
// A space joins a project by its origin remote, else by the deepest folder linked
// to a project on its PC (projects.json registry, or the projects mod's catalogs).
// PCs linked to a project show even with no open space.
//
// Click a space to show it, right-click for its menu, drag to reorder within the
// same project and PC. A project's "+" adds a PC, a PC's "+" makes a space there,
// right-click on a PC sets its roles (overlays.js). Publishes
// shared("project-spaces.projects") = { spaceId: projectKey | null } for agents-weed.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout, nextCommand, checking } from "herdr";
import { contextForSpace } from "./project-context.js";
import { groupSpaces, spaceProjects, where, emptyRegistry } from "./project-model.js";
import { loadRegistry, publishRegistry, loadLocalCatalog, sharedRegistry, droppedMessage, SHARED_PROJECTS, CATALOGS } from "./registry.js";
import { overlayOf, initOverlay, renderOverlay, openAddPc, openRoles, openNewSpace } from "./overlays.js";
import { redactUrl } from "./backend.js";
import { MARK, PALETTE, projectColor, roleBadge, pcLabel, icon } from "./ui.js";

const URGENT = ["blocked", "done", "working"]; // Herdr's order; idle says nothing
const FALLBACK = 60000; // re-check git in view this often while the window is in front
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Left padding: project header, PC header, space row.
const PAD = { project: 8, pc: 20, space: 30 };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}
const tone = (t, status) => t[status] ?? t.unknown;
const urgentOf = (statuses) => URGENT.find((s) => statuses.includes(s)) ?? null;
const slotKey = (projectKey, pcKey) => `${projectKey ?? "\u0000other"}|${pcKey}`;

export default class ProjectSpaces extends View {
  init(_props, cx) {
    const o = overlayOf(props());
    if (o) { this.overlayState = o; initOverlay(this, cx); return; }

    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked, remote } | null
    this.checked = {};
    this.unsure = new Set();
    this.pending = new Set();
    this.busy = {};
    this.ready = {};
    this.at = {};
    this.watching = new Set();
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.front = null; // { id, near }: the space in front, and where to go if it closes
    this.pressed = null; // space id being dragged
    this.over = null;
    this.slot = {}; // space id -> project|pc, for drag limits
    this.seen = [];
    this.machines = []; // hc machine ls, non-temporary
    this.registry = sharedRegistry() ?? emptyRegistry();
    this.registryError = null;
    this.localCatalog = null;
    this.folded = new Set(this.load("folded"));

    if (checking()) return; // no helpers, git or hc during `herdr-app check`
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    this.refreshRegistry(cx);
    cx.timer.every(5000, (cx) => this.refreshRegistry(cx));
    cx.timer.every(250, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).split(".").pop();
        if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1);
        cx.notify();
      }
    });
  }

  // An overlay closing: a finished clone terminal goes; a running one is left to finish.
  async close(_cx) {
    this.overlayCtl?.dispose?.();
  }

  load(name) {
    try { return JSON.parse(localStorage.getItem(name) ?? "[]"); } catch { return []; }
  }

  toggle(key, cx) {
    this.folded.has(key) ? this.folded.delete(key) : this.folded.add(key);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  // ---- data ----

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch {}
      cx.notify();
    });
  }

  refreshRegistry(cx) {
    if (this.loadingRegistry) return;
    this.loadingRegistry = true;
    cx.spawn(async (cx) => {
      try {
        const { registry, error, dropped } = await loadRegistry();
        // A broken file keeps the last good registry on screen; dropped rows show the
        // usable rest and a warning (saving is refused until the file is fixed).
        this.registryError = error ?? (dropped?.length ? droppedMessage(dropped) : null);
        if (!error) { this.registry = registry; publishRegistry(registry); }
        if (!shared(CATALOGS)) this.localCatalog = await loadLocalCatalog();
      } catch (e) {
        this.registryError = String(e?.message ?? e);
      } finally {
        this.loadingRegistry = false;
      }
      cx.notify();
    });
  }

  catalogs() {
    return shared(CATALOGS) ?? (this.localCatalog ? { "@local": this.localCatalog } : {});
  }

  tick(cx) {
    const now = Date.now(), sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    this.closed(sp);
    const front = sp.find((s) => s.active);
    if (front) this.front = { id: front.id, near: this.near(front.id) };
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed (see space-folders' due()).
  due(now, sp, ps) {
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    const offline = new Set();
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      if (!ready) offline.add(m.name ?? null);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      // Like space-folders: the timed re-check is only for places on screen. Spaces under
      // a folded project / PC, and PCs that are not ready (whose exec would only time
      // out and hold up the queue), wait until they are shown or come back.
      const inView = new Set();
      for (const [id, k] of Object.entries(at)) if (!this.hiddenSpaces?.has(id) && !offline.has(JSON.parse(k)[0])) inView.add(k);
      for (const k of keys) if (inView.has(k) && (this.git[k] || this.unsure.has(k)) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
    }
    return due;
  }

  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const batch = [...this.pending];
        this.pending.clear();
        for (const key of batch) await this.check(key, cx);
        cx.notify();
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo, and its origin remote.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const origin = await exec("git", ["remote", "get-url", "origin"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = {
        name, branch: null, ahead: 0, behind: 0,
        repo: JSON.stringify([on, repo]), top: top.stdout.trim(),
        linked: repo !== `${top.stdout.trim()}/.git`,
        remote: origin.code === 0 ? origin.stdout.trim() || null : null,
      };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // ---- navigation ----

  // One space down (1) or up (-1) the list as shown, past folded groups, wrapping.
  step(dir) {
    const seen = this.seen, len = seen.length;
    if (!len) return;
    const at = seen.findIndex((s) => s.id === spaces().find((w) => w.active)?.id);
    const from = at >= 0 ? at : dir > 0 ? -1 : len;
    for (let n = 1; n <= len; n++) {
      const s = seen[(((from + dir * n) % len) + len) % len];
      if (s.shown) { run("space.select", { id: s.id }); return; }
    }
  }

  // Where to go when this space closes: the space above it in the list, else below.
  near(id) {
    const list = this.seen.filter((e) => e.shown || e.id === id), i = list.findIndex((e) => e.id === id);
    return i < 0 ? null : (list[i - 1] ?? list[i + 1])?.id ?? null;
  }

  closed(sp) {
    const was = this.front;
    if (!was?.id || sp.some((s) => s.id === was.id)) return;
    this.front = null;
    if (was.near && sp.some((s) => s.id === was.near)) run("space.select", { id: was.near });
  }

  menu(w) {
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // ---- grouping ----

  groups() {
    const sp = spaces(), ps = panes(), now = Date.now();
    // A new space waits a moment for its git, so it appears in its project at once.
    for (const w of sp) {
      if (this.shown.has(w.id)) continue;
      if (where(w, ps) in this.git || now - (this.born[w.id] ??= now) > 1500) this.shown.add(w.id);
    }
    const list = sp.filter((w) => this.shown.has(w.id));
    const known = this.machines.length ? this.machines.map((m) => ({ name: m.name, state: m.state })) : null;
    return groupSpaces({ spaces: list, panes: ps, gitInfo: this.git, registry: sharedRegistry() ?? this.registry, catalogs: this.catalogs(), machines: known });
  }

  publish(groups) {
    const map = spaceProjects(groups);
    if (JSON.stringify(shared(SHARED_PROJECTS) ?? null) !== JSON.stringify(map)) setShared(SHARED_PROJECTS, map);
  }

  loading() {
    return machines().some((m) => m.layout === "loading") || spaces().some((s) => !this.shown.has(s.id));
  }

  // ---- drawing ----

  // Origin URLs of a project's open spaces (redacted), to prefill a clone.
  remotesOf(g) {
    return [...new Set(g.pcs.flatMap((pc) => pc.rows.map((r) => redactUrl(r.git?.remote))).filter(Boolean))];
  }

  projectHead(g, t, folded, collapsed) {
    const statuses = g.pcs.flatMap((pc) => pc.rows.map((r) => r.space.status));
    const status = urgentOf(statuses);
    const fold = `p:${g.projectKey ?? "other"}`;
    const color = g.other ? t.dim : projectColor(g.projectKey);
    const tile = h_flex().size(18).flex_none().rounded(5).items_center().justify_center().bg(color)
      .child(g.other ? svg(icon("folder")).size(12).text_color("#ffffff")
        : div().text_size(10.5).font_bold().text_color("#ffffff").child([...g.name][0]?.toUpperCase() ?? "?"));
    const head = h_flex().id(`ps-project-${g.projectKey ?? "other"}`).h(30).flex_none().gap(8).items_center().rounded(8)
      .px(collapsed ? 2 : PAD.project).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .when(Boolean(g.projectKey), (el) => el.tooltip(g.projectKey))
      .on_click((_e, cx) => this.toggle(fold, cx));
    if (collapsed) return head.justify_center().child(tile);
    return head
      .child(tile)
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(g.name))
      .when(status === "working", (el) => el.child(svg(icon("spinner")).size(11).flex_none().text_color(t.working).spin(900)))
      .when(Boolean(status) && status !== "working", (el) => el.child(div().flex_none().text_color(tone(t, status)).child(glyph(status))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${g.pcs.length} PC`))
      .when(!g.other, (el) => el.child(div().id(`ps-add-pc-${g.projectKey}`).flex_none().px(4).rounded(4).text_color(t.dim)
        .tooltip("PC 추가").hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); openAddPc(g.projectKey, g.name, this.remotesOf(g)); }).child("+")))
      .child(svg(icon(`chevron-${folded ? "right" : "down"}`)).size(11).flex_none().text_color(t.dim));
  }

  pcHead(g, pc, t, folded) {
    const m = this.machines.find((k) => k.name === pc.machine);
    const state = pc.key === "" ? "connected" : m?.state ?? (this.machines.length ? "not added" : "…");
    const id = `${g.projectKey ?? "other"}-${pc.key || "local"}`;
    const fold = `m:${slotKey(g.projectKey, pc.key)}`;
    const status = urgentOf(pc.rows.map((r) => r.space.status));
    return h_flex().id(`ps-pc-${id}`).h(26).flex_none().pl(PAD.pc).pr(8).gap(6).items_center().rounded(6)
      .text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(fold, cx))
      .when(!g.other, (el) => el.on_mouse_down("right", () => openRoles(g.projectKey, g.name, pc.machine, this.remotesOf(g)[0] ?? null)))
      .child(svg(icon(pc.machine ? "server" : "monitor")).size(12).flex_none())
      .child(div().flex_shrink(1).min_w(0).truncate().child(pcLabel(pc.machine)))
      .children(pc.roles.map((r) => roleBadge(t, r, `ps-role-${id}-${r}`)))
      .child(div().flex_1())
      .when(folded && Boolean(status), (el) => el.child(div().flex_none().text_color(tone(t, status)).child(glyph(status))))
      .when(!pc.connected, (el) => el.child(div().flex_none().text_size(10.5).child(String(state).replace(/_/g, " "))))
      .when(pc.connected, (el) => el.child(div().id(`ps-new-${id}`).flex_none().px(4).rounded(4)
        .tooltip(`${pcLabel(pc.machine)}에 새 작업 공간 만들기`).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); openNewSpace(g.projectKey, g.name, pc.machine); }).child("+")))
      .child(div().size(6).rounded(3).flex_none().bg(pc.connected ? t.ansi2 : t.dim))
      .child(svg(icon(`chevron-${folded ? "right" : "down"}`)).size(10).flex_none());
  }

  emptyPc(g, pc, t) {
    const id = `${g.projectKey ?? "other"}-${pc.key || "local"}`;
    return h_flex().id(`ps-empty-${id}`).h(26).flex_none().pl(PAD.space).pr(8).gap(7).items_center().rounded(7)
      .text_size(11.5).text_color(t.dim)
      .when(pc.connected, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => openNewSpace(g.projectKey, g.name, pc.machine)))
      .child(svg(icon("plus")).size(11))
      .child(pc.connected ? "No open space · open one" : "No open space");
  }

  // Only what's unusual after the name: repo, branch (not main/master), ahead/behind.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const text = [repo, branch].filter(Boolean).join(" · ");
    return h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(11.5).text_color(t.dim)
      .when(Boolean(text), (el) => el.child(div().min_w(0).truncate().child(text)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)));
  }

  row(r, t, index, ps, catalogs) {
    const w = r.space, g = r.git, tree = r.tree, on = w.active;
    const context = contextForSpace(w, ps, catalogs);
    const issue = context?.work?.issue;
    const badge = issue && !w.name.includes(`#${issue.number}`) ? `#${issue.number}` : null;
    const detail = on && context ? [context.name, g?.branch ?? context.branch].filter(Boolean).filter((v, n, all) => all.indexOf(v) === n).join(" · ") : null;
    const color = (shared("space.colors") ?? {})[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const i = index.get(w.id);
    const dragging = this.pressed !== null;
    return v_flex().relative().id(`space-${w.id}`).pl(PAD.space).pr(8)
      .h((tree ? 28 : 30) + (detail ? 14 : 0)).flex_none().justify_center().rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(dragging && this.over === w.id && this.pressed !== w.id, (el) => {
        const from = index.get(this.pressed);
        return el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(from < i, (line) => line.bottom(0)).when(from > i, (line) => line.top(0)));
      })
      .on_mouse_down("left", () => { this.pressed = w.id; this.over = w.id; })
      .on_mouse_move((_e, cx) => {
        if (this.pressed === null) return;
        // Only within the same project and PC.
        const over = this.slot[this.pressed] === this.slot[w.id] ? w.id : null;
        if (this.over !== over) { this.over = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed, over = this.over;
        this.pressed = null; this.over = null;
        if (from !== null && over === w.id && from !== w.id && this.slot[from] === this.slot[w.id]) run("space.move", { id: from, index: i + 1 });
        else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(h_flex().gap(9).items_center()
        .when(Boolean(tree), (el) => el.pl(16).child(svg(icon("branch")).size(13).text_color(t.dim)))
        .when(!tree, (el) => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center()
          .text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
        .child(div().flex_shrink(0).max_w(140).truncate().text_color(t.foreground).child(w.name))
        .when(Boolean(badge), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.accent).child(badge)))
        .child(g && !detail ? this.gitTail(g, tree, w.name, t) : div().flex_1()))
      .when(Boolean(detail), (el) => el.child(div().pl(tree ? 38 : 27).pr(2).text_size(10.5).text_color(t.dim).truncate().child(detail)));
  }

  compact(r, t, index) {
    const w = r.space;
    return h_flex().id(`space-${w.id}`).h(26).flex_none().justify_center().gap(4)
      .when(w.active, (el) => el.bg(t.raised)).hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .on_mouse_down("right", () => this.menu(w))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(index.get(w.id) + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  // Every row in order; `seen` collects spaces in list order with whether they show.
  rows(groups, t, collapsed, seen) {
    const index = new Map(spaces().map((s, i) => [s.id, i]));
    const ps = panes(), catalogs = shared(CATALOGS) ?? {};
    const slot = {};
    const hidden = new Set();
    const out = [];
    for (const g of groups) {
      const pFolded = this.folded.has(`p:${g.projectKey ?? "other"}`);
      out.push(this.projectHead(g, t, pFolded, collapsed));
      for (const pc of g.pcs) {
        const mFolded = this.folded.has(`m:${slotKey(g.projectKey, pc.key)}`);
        if (!pFolded && !collapsed) out.push(this.pcHead(g, pc, t, mFolded));
        const away = pFolded || mFolded;
        for (const r of pc.rows) {
          slot[r.space.id] = slotKey(g.projectKey, pc.key);
          if (away && !collapsed) hidden.add(r.space.id);
          seen.push({ id: r.space.id, shown: !away || collapsed });
          if (collapsed) out.push(this.compact(r, t, index));
          else if (!away) out.push(this.row(r, t, index, ps, catalogs));
        }
        if (!away && !collapsed && !pc.rows.length) out.push(this.emptyPc(g, pc, t));
      }
      if (!collapsed) out.push(div().h(4).flex_none());
    }
    this.slot = slot;
    this.hiddenSpaces = hidden;
    return out;
  }

  // Each space keeps its avatar color across mods (shared "space.colors").
  assignColors() {
    const sp = spaces(), ids = new Set(sp.map((p) => p.id));
    const all = shared("space.colors") ?? {};
    const kept = Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(all).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[p.id] = PALETTE.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
  }

  render() {
    const t = theme();
    if (this.overlayState) return renderOverlay(this, t);
    const collapsed = narrow();
    this.assignColors();
    const groups = this.groups();
    this.publish(groups);
    const seen = [];
    const rows = this.rows(groups, t, collapsed, seen);
    this.seen = seen;
    const empty = !groups.length;
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, (el) => el.child("Projects"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .tooltip("이 컴퓨터에 새 작업 공간 만들기").hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new", { machine: "" }))
          .child(svg(icon("plus")).size(14))))
      .when(Boolean(this.registryError) && !collapsed, (el) => el.child(div().mx(12).mb(6).p(8).rounded(6)
        .bg(t.blocked + "1f").text_size(11).text_color(t.blocked).child(`projects.json: ${this.registryError}`)))
      .child(v_flex().id("ps-list").flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.over = null; cx.notify(); })
        .when(empty, (el) => el.child(div().id("ps-loading").h(28).px(8).text_size(12).text_color(t.dim)
          .child(this.loading() ? (collapsed ? "…" : "Loading…") : collapsed ? "" : "No spaces")))
        .children(rows));
  }
}
