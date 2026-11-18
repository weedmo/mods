// Project lead: per project, which PC holds which role, what the lead dispatched there,
// its live status and the last report. Read-only: the herdr-lead skill (a Claude Code
// skill on this laptop) writes ~/.config/herdr-projects/lead-state.json; roles come from
// the project-spaces registry (projects.json, shared "project-spaces.registry").
// Live status: terminals() by address, else `hc get <address> --json` for active tasks.
// Opens as a window (mod.open:project-lead) or docked in the side panel stack
// (main-weed: panel-body child "lead", toggled with tabs-weed.panel-lead).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, readTextFile, hc, terminals, theme, shared, run, props, closeOverlay, checking, layout } from "herdr";
import { parseState, buildView, addressesToPoll, liveOf, ago, oneLine } from "./model.js";

const ROLE_LABEL = { impl: "impl", qa: "QA", plan: "plan" };
const icon = (name) => `mods/workspace-chrome/${name}.svg`;
const statePath = () => `${home()}/.config/herdr-projects/lead-state.json`;
const registryPath = () => `${home()}/.config/herdr-projects/projects.json`;

function tone(t, status) {
  switch (status) {
    case "working": case "dispatched": return t.working;
    case "blocked": case "error": case "failed": case "awaiting-user": return t.blocked;
    case "reported": case "done": return t.done;
    case "idle": return t.idle;
    default: return t.dim;
  }
}
function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

const STATUS_TEXT = { "awaiting-user": "waiting for you", dispatched: "dispatched", reported: "reported" };

export default class ProjectLead extends View {
  init(_props, cx) {
    this.state = parseState(null);
    this.stateError = null;
    this.registry = null;
    this.polled = {}; // address -> live word from hc get
    this.folded = new Set();
    try { this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]")); } catch {}
    this.overlay = props()?.overlay ?? null;
    if (checking()) return;
    this.reload(cx);
    cx.timer.every(3000, (cx) => { if (this.visible()) this.reload(cx); });
    cx.timer.every(10000, (cx) => { if (this.visible()) this.poll(cx); });
  }

  // As a window it is always shown. Docked in the side panel stack (panel-body), skip
  // work while the panel is hidden or another panel tab is in front (the next tick after
// it is shown catches up).
  visible() {
    if (this.overlay) return true;
    const root = layout(), body = find(root, "panel-body");
    const mine = body?.children?.find((c) => c.content?.mod === "project-lead");
    if (!mine) return true;
    return !find(root, "panel")?.hidden && body.active === mine.id;
  }

  reload(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(statePath());
        try { this.state = parseState(text); this.stateError = null; }
        catch (e) { this.stateError = `lead-state.json: ${String(e?.message ?? e)}`; } // keep the last good one
        if (!shared("project-spaces.registry")) {
          const reg = await readTextFile(registryPath());
          try { this.registry = reg ? JSON.parse(reg) : null; } catch { /* sidebar shows the error */ }
        }
      } finally {
        this.loading = false;
      }
      cx.notify();
    });
  }

  liveMap() {
    const out = {};
    for (const term of terminals() ?? []) if (term?.address) out[term.address] = liveOf(term);
    return out;
  }

  poll(cx) {
    const todo = addressesToPoll(this.state, this.liveMap());
    if (!todo.length) return;
    cx.spawn(async (cx) => {
      for (const a of todo) {
        try {
          const r = await hc(["get", a, "--json"]);
          this.polled[a] = r.code === 0 ? liveOf(JSON.parse(r.stdout)) : "gone";
        } catch { this.polled[a] = "gone"; }
      }
      cx.notify();
    });
  }

  toggle(key, cx) {
    this.folded.has(key) ? this.folded.delete(key) : this.folded.add(key);
    try { localStorage.setItem("folded", JSON.stringify([...this.folded])); } catch {}
    cx.notify();
  }

  view() {
    const registry = shared("project-spaces.registry") ?? this.registry;
    return buildView({ state: this.state, registry, liveByAddress: { ...this.polled, ...this.liveMap() } });
  }

  render(_cx) {
    const t = theme();
    const groups = this.view();
    const now = Date.now();
    return v_flex().id("pl-root").size_full().bg(t.chrome).text_color(t.foreground).text_size(12)
      .child(this.header(t, groups))
      .when(Boolean(this.stateError), (el) => el.child(div().mx(10).mb(6).p(8).rounded(6).bg(t.blocked + "1f")
        .text_size(11).text_color(t.blocked).child(this.stateError)))
      .child(v_flex().id("pl-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(8).gap(2)
        .when(!groups.length, (el) => el.child(this.empty(t)))
        .children(groups.flatMap((g) => this.project(g, t, now))));
  }

  header(t, groups) {
    const waiting = groups.reduce((n, g) => n + g.waiting, 0);
    return h_flex().id("pl-head").h(34).flex_none().px(12).gap(8).items_center()
      .child(div().text_size(12.5).font_semibold().child("Project lead"))
      .when(waiting > 0, (el) => el.child(div().px(6).h(16).rounded(8).flex().items_center().bg(t.blocked + "26")
        .text_size(10).text_color(t.blocked).child(`${waiting} waiting for you`)))
      .child(div().flex_1())
      .when(Boolean(this.overlay), (el) => el.child(div().id("pl-close").px(6).rounded(4).cursor_pointer().text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => closeOverlay(this.overlay)).child("✕")));
  }

  empty(t) {
    return v_flex().id("pl-empty").p(12).gap(6).text_color(t.muted)
      .child(div().child("No lead activity yet."))
      .child(div().text_size(11).text_color(t.dim).child(
        "Set roles with a right-click on a PC in Project spaces, then ask Claude to lead (herdr-lead skill). Dispatched tasks show here."));
  }

  project(g, t, now) {
    const fold = `p:${g.projectKey}`;
    const folded = this.folded.has(fold);
    const head = h_flex().id(`pl-p-${g.projectKey}`).h(28).flex_none().px(6).gap(6).items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.toggle(fold, cx))
      .child(svg(icon(`chevron-${folded ? "right" : "down"}`)).size(10).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(g.name))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${new Set(g.rows.map((r) => r.machine)).size} PC`));
    if (folded) return [head];
    if (!g.rows.length) return [head, div().pl(22).text_size(11).text_color(t.dim).child("No roles set")];
    return [head, ...g.rows.map((r, i) => this.row(g, r, i, t, now))];
  }

  row(g, r, i, t, now) {
    const task = r.task;
    const status = r.status;
    const clickable = Boolean(task?.terminal) && !["exited", "gone"].includes(r.live ?? "");
    return v_flex().id(`pl-r-${g.projectKey}-${i}`).flex_none().pl(22).pr(8).py(5).gap(2).rounded(6)
      .when(clickable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(`Peek at ${task.terminal}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("terminal.peek", { terminal: task.terminal })))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().px(5).h(15).rounded(4).flex().items_center().bg(t.accent + "22")
          .text_size(9.5).font_semibold().text_color(t.accent).child(ROLE_LABEL[r.role] ?? r.role))
        .child(svg(icon(r.machine ? "server" : "monitor")).size(11).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.machine || "This computer"))
        .when(Boolean(status), (el) => el
          .child(div().size(6).rounded(3).flex_none().bg(tone(t, status)))
          .child(div().flex_none().text_size(10.5).text_color(tone(t, status)).child(STATUS_TEXT[status] ?? status))))
      .child(div().truncate().text_size(11.5).text_color(task ? t.foreground : t.dim)
        .child(task ? `${task.id}${task.scope ? ` · ${oneLine(task.scope, 80)}` : ""}` : r.assigned ? "Idle: no task" : ""))
      .when(Boolean(task?.branch || task?.terminal), (el) => el.child(div().truncate().text_size(10.5).text_color(t.dim)
        .child([task.branch && `⎇ ${task.branch}`, task.terminal, task.updated_ms && ago(task.updated_ms, now)].filter(Boolean).join(" · "))))
      .when(Boolean(r.report), (el) => el.child(div().mt(1).px(6).py(3).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted)
        .child(`${r.report.task} · ${ago(r.report.at_ms, now)}: ${oneLine(r.report.text, 160)}`)));
  }
}
