// A pane's header (cloned from Herdr's `pane`), plus pane drag and drop that works in
// every split tab, remote machines included (Herdr's own grip is off there).
//   Press the header and drag: every other pane's header shows ← ↑ ↓ → targets.
//   Release on one: the dragged terminal moves beside that pane, on that side.
//   Release over the tab bar: it becomes a tab of its own (tabs-weed handles it).
// The move itself runs in tabs-weed (shared "tabs-weed.drop"); the drag in progress
// is shared "pane-weed.drag" = { terminal, pane, tab, at }.
// Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, shared, setShared } from "herdr";

const DRAG_KEY = "pane-weed.drag";
const STALE_MS = 15000; // a drag released over a terminal body is never reported; let it lapse
const THRESHOLD = 6;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

const machineOf = (addr) => (addr && addr.includes("/") ? addr.split("/")[0] : null);

function activeDrag() {
  const d = shared(DRAG_KEY);
  return d && Date.now() - d.at < STALE_MS ? d : null;
}

export default class Pane extends View {
  init() {
    this.hovered = false;
    this.press = null;
    this.target = null;
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  startDrag(p) {
    this.press = null;
    if (!p.terminal) return;
    setShared(DRAG_KEY, { terminal: p.terminal, pane: p.pane, tab: p.tab, at: Date.now() });
  }

  drop(drag, place) {
    setShared(DRAG_KEY, null);
    setShared("tabs-weed.drop", { id: `${Date.now()}-${Math.random()}`, terminal: drag.terminal, target: props().pane, place });
  }

  // The ← ↑ ↓ → targets another pane's header shows while a pane is dragged.
  targets(t, drag, pane) {
    const arrow = (place, glyph) => div()
      .id(`pd-${place}-${pane}`)
      .w(30).h(22).flex().items_center().justify_center().rounded(5)
      .border(1).border_color(this.target === place ? t.accent : t.border)
      .bg(this.target === place ? t.selection : t.raised)
      .text_size(13).text_color(this.target === place ? t.foreground : t.muted)
      .on_hover((on, cx) => { this.target = on ? place : this.target === place ? null : this.target; cx.notify(); })
      .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.drop(drag, place); })
      .child(glyph);
    return h_flex().gap(4).flex_none().items_center()
      .child(div().text_size(11).text_color(t.dim).child("Drop beside:"))
      .child(arrow("left", "←")).child(arrow("up", "↑")).child(arrow("down", "↓")).child(arrow("right", "→"));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const drag = activeDrag();
    // Let a drag released over a terminal body lapse on screen too.
    if (drag && this.expiry !== drag.at) { this.expiry = drag.at; cx.timer.after(STALE_MS + 50, (cx) => cx.notify()); }
    const source = drag?.pane === pane;
    const canTarget = drag && !source && p.terminal && machineOf(p.terminal) === machineOf(drag.terminal);
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(source ? t.selection : t.background)
      .border_b(1)
      .border_color(canTarget ? t.accent : t.border)
      .text_size(12)
      .cursor_pointer()
      .on_hover((hovered, cx) => {
        this.hovered = hovered;
        if (!hovered) this.target = null;
        // Pressed and pulled out of the header: that's a drag too.
        if (!hovered && this.press) this.startDrag(p);
        cx.notify();
      })
      .on_mouse_down("left", (e) => {
        if (activeDrag()) setShared(DRAG_KEY, null);
        this.press = { x: e.position.x, y: e.position.y };
      })
      .on_mouse_move((e) => {
        if (!this.press) return;
        if (Math.abs(e.position.x - this.press.x) + Math.abs(e.position.y - this.press.y) >= THRESHOLD) this.startDrag(p);
      })
      .on_mouse_up("left", () => {
        this.press = null;
        // Released on a header outside the targets (or on its own): cancel.
        if (activeDrag()) setShared(DRAG_KEY, null);
      })
      .on_click(() => { if (!drag) run("pane.focus", { pane }); })
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(source ? "Dragging · drop on another pane's arrows, or on the tab bar for a new tab" : folder(p.cwd)))
      .when(Boolean(canTarget), (el) => el.child(this.targets(t, drag, pane)))
      .when(!drag && st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(!drag && st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(!drag && st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(!drag && this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
