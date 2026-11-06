import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, focused, notify, nextCommand, keys } from "herdr";

// Resolve displayed shortcuts from the live keymap, rather than duplicating bindings.
function shortcutTip(label, action, iconOnly = true) {
  const shortcuts = [...new Set(keys().filter(k => k.section === "global" && k.action === action).map(k =>
    k.keys.split("-").map(p => ({ctrl:"Ctrl",alt:"Alt",shift:"Shift",cmd:"Super"})[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join("+")
  ))].join(" / ");
  return iconOnly ? label + (shortcuts ? " / " + shortcuts : "") : shortcuts;
}


import { MOVE_KEY, advanceMove } from "./move.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    cx.timer.every(250, cx => this.progressMove(cx));
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); this.command(c); cx.notify(); } });
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.lastDrop = shared("tabs-weed.drop")?.id ?? null;
  }

  // A pressed tab dragged out of the bar: cover the window with the drop overlay.
  startDrop(tab) {
    this.pressed = null;
    if (!tab || tab.active) return;
    openOverlay({ mod: "tab-drop", kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 }, props: { tab: tab.id, target: focused()?.pane } });
  }

  progressMove(cx) {
    const move = shared(MOVE_KEY);
    if (!move) return;
    const result = advanceMove(move, {panes:panes(),spaces:spaces()}, Date.now());
    if (result.patch) setShared(MOVE_KEY, {...move,...result.patch, warned:move.warned || !!result.warning});
    try {
      for (const [command,args] of result.commands ?? []) run(command,args);
      if (result.done) setShared(MOVE_KEY,null);
    } catch (e) {
      // Retain the intent: a later tick or a reloaded mod can still restore it.
      if (!move.warned) notify({title:"이동 대기",body:String(e),level:"warning"});
      setShared(MOVE_KEY,{...move,...result.patch,warned:true});
    }
    if (result.warning) notify({title:"탭 이동",body:result.warning,level:"warning"});
    cx.notify();
  }

  handleDrop(drop, cx) {
    if (!drop || drop.id === this.lastDrop) return;
    // Another request must not park a second terminal while the first is detached.
    if (shared(MOVE_KEY)) return;
    this.lastDrop = drop.id;
    if (shared("tabs-weed.drop")?.id === drop.id) setShared("tabs-weed.drop",null);
    const warn = body => notify({title:"탭 이동",body,level:"warning"});
    if (!["tab","left","right","up","down"].includes(drop.place)) return;
    const all = panes();
    const f = drop.target ? all.find(p => p.pane === drop.target) : all.find(p => p.pane === focused()?.pane);
    let terminal = drop.terminal;
    if (!terminal && drop.tab) {
      const own = all.filter(p => p.tab === drop.tab);
      if (own.length !== 1 || !own[0].terminal) return warn("여러 창이 있는 탭은 창 헤더를 끌어 이동하세요. 탭의 일부만 옮기지 않습니다.");
      terminal = own[0].terminal;
    }
    if (!terminal) return;
    const src = all.find(p => p.terminal === terminal);
    const machineOf = addr => addr?.includes("/") ? addr.split("/")[0] : null;
    if (drop.place === "tab") {
      if (src && all.filter(p => p.tab === src.tab).length < 2) return;
    } else {
      if (!f?.terminal) return warn("대상 창이 없어 이동을 취소했습니다.");
      if (f.terminal === terminal || (drop.tab && drop.tab === f.tab)) return;
      if (machineOf(f.terminal) !== machineOf(terminal)) return warn("같은 PC의 창 사이에서만 이동할 수 있습니다.");
    }
    const sourceSpace = spaces().find(s => s.tabs.some(t => t.id === src?.tab))?.id;
    const intent = {id:drop.id,terminal,sourceSpace,sourceTab:src?.tab,target:f?.pane,targetTab:f?.tab,
      place:drop.place === "left" ? "right" : drop.place === "up" ? "down" : drop.place,
      swap:drop.place === "left" ? "left" : drop.place === "up" ? "up" : null,
      phase:src ? "detaching" : "attaching",started:Date.now(),next:0};
    setShared(MOVE_KEY,intent);
    if (src) {
      try { run("terminal.park",{terminal}); }
      catch (e) { setShared(MOVE_KEY,null); return warn(String(e)); }
    }
    this.progressMove(cx);
  }

  // Key commands ("alt-shift-t": "tabs-weed.detach", "alt-shift-right": "tabs-weed.pull-right").
  // detach: the focused pane becomes its own tab. pull-<dir>: the next tab joins the focused one.
  command(c) {
    const f = focused();
    if (!f) return;
    const drop = (extra) => setShared("tabs-weed.drop", { id: `${Date.now()}-${Math.random()}`, ...extra });
    if (c === "detach") return f.terminal && drop({ terminal: f.terminal, place: "tab" });
    // panel-<id> ("ctrl-shift-g": "tabs-weed.panel-workflow"): toggle that side panel, like its button.
    const p = /^panel-(\w+)$/.exec(c);
    if (p) {
      const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
      if (panel && !panel.hidden && body?.active === p[1]) run("layout.hide", { id: "panel" });
      else { run("layout.select", { stack: "panel-body", child: p[1] }); run("layout.show", { id: "panel" }); }
      return;
    }
    const m = /^pull-(right|left|down|up)$/.exec(c);
    if (!m) return;
    const tabs = (spaces().find(s => s.active)?.tabs ?? []).filter(t => !t.settled);
    const i = tabs.findIndex(t => t.id === f.tab);
    const next = tabs.length > 1 ? tabs[(i + 1) % tabs.length] : null;
    if (next && next.id !== f.tab) drop({ tab: next.id, place: m[1] });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render(cx) {
    this.handleDrop(shared("tabs-weed.drop"), cx);
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(id === "tab-new" ? shortcutTip("새 탭", "tab.new") : ({minimize:"최소화",maximize:"최대화 / 복원","close-window":"창 닫기","recover-move":"탭 이동 복구"})[id] ?? id).on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = { id:c.id, space:space.id }; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from && from.space === space.id && from.id !== c.id && shown.some(t => t.id === from.id))
            run("tab.move", { id:from.id, index:space.tabs.findIndex(x => x.id === c.id)+1 });
          else if (from?.id === c.id) run("tab.select", { id:c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu-weed", kind: "popup", width: 220, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).tooltip(shortcutTip("탭 닫기", "tab.close")).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "graph", "issues", "workflow"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .when(Boolean(shortcutTip(label, id === "workflow" ? "tabs-weed.panel-workflow" : "mod.open:" + id, false)), el => el.tooltip(shortcutTip(label, id === "workflow" ? "tabs-weed.panel-workflow" : "mod.open:" + id, false)))
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    const pd = shared("pane-weed.drag");
    const paneDrag = pd && Date.now() - pd.at < 15000;
    return h_flex().id("tabs-root").size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => {
        this.pressed = null;
        // A pane dragged up here (pane-weed) becomes a tab of its own.
        const pd = shared("pane-weed.drag");
        if (pd && Date.now() - pd.at < 15000) {
          setShared("pane-weed.drag", null);
          setShared("tabs-weed.drop", { id: `${Date.now()}-${Math.random()}`, terminal: pd.terminal, place: "tab" });
        }
      })
      .on_hover((hovered) => { if (!hovered && this.pressed !== null) this.startDrop(shown.find(t => t.id === this.pressed.id)); })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .when(Boolean(paneDrag), el => el.child(div().flex_none().px(10).h(24).flex().items_center().rounded(6)
        .border(1).border_color(t.accent).bg(t.selection).text_size(12).text_color(t.foreground).child("Release here: new tab")))
      .when(Boolean(shared(MOVE_KEY)), el => el.child(button("recover-move", "↻", () => {
        const move = shared(MOVE_KEY); if (move) run("terminal.peek",{terminal:move.terminal});
      })))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(panelButton("graph", "Git", "mods/git-graph/icons/graph.svg"))
      .child(panelButton("issues", "Issues", "mods/tabs-weed/issue.svg"))
      .child(panelButton("workflow", "Workflow", "mods/workflow-graph/icon.svg"))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-weed/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-weed/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-weed/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
