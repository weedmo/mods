// Full-window overlay opened while a tab (from tabs-weed) or an agent (from agents-weed)
// is dragged toward the terminals. It previews which side of the focused pane the
// terminal will land on and, on release, hands the drop to tabs-weed through
// shared("tabs-weed.drop"). Zones follow Orca's edge split: the nearest window edge
// wins; the top band (back over the tab bar) and the center box cancel.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, closeOverlay, setShared, window } from "herdr";

const CANCEL_BAND = 48;
const CENTER = 0.2; // half-size of the center cancel box, as a share of each axis

const LABEL = { right: "Split right", left: "Split left", down: "Split down", up: "Split up" };

export default class TabDrop extends View {
  init() {
    this.size = null;
    this.pos = null;
    this.done = false;
  }

  zone() {
    if (!this.size || !this.pos) return null;
    const { width, height } = this.size, { x, y } = this.pos;
    if (y < CANCEL_BAND) return null;
    const h = Math.max(1, height - CANCEL_BAND);
    const nx = x / width - 0.5, ny = (y - CANCEL_BAND) / h - 0.5;
    if (Math.abs(nx) < CENTER && Math.abs(ny) < CENTER) return null;
    return Math.abs(nx) >= Math.abs(ny) ? (nx > 0 ? "right" : "left") : (ny > 0 ? "down" : "up");
  }

  finish(place) {
    if (this.done) return;
    this.done = true;
    const p = props();
    if (place) setShared("tabs-weed.drop", { id: `${Date.now()}-${Math.random()}`, tab: p.tab ?? null, terminal: p.terminal ?? null, place });
    closeOverlay(p.overlay);
  }

  render(cx) {
    // Missed release fallback: the window lost focus mid-drag.
    if (window() && !window().active) cx.timer.after(0, () => this.finish(null));
    const t = theme(), place = this.zone();
    const hint = (text, color) => div().px(14).py(8).rounded(8).bg(t.popover).border(1).border_color(color)
      .text_size(13).text_color(t.foreground).child(text);
    const target = div().flex_1().flex().items_center().justify_center().rounded(10)
      .border(2).border_color(t.accent).bg(t.selection).opacity(0.85).child(hint(LABEL[place] ?? "", t.accent));
    const blank = div().flex_1();
    const preview = place === "right" ? h_flex().flex_1().gap(6).child(blank).child(target)
      : place === "left" ? h_flex().flex_1().gap(6).child(target).child(blank)
      : place === "down" ? v_flex().flex_1().gap(6).child(blank).child(target)
      : place === "up" ? v_flex().flex_1().gap(6).child(target).child(blank)
      : v_flex().flex_1().items_center().justify_center().child(
          hint("Move toward an edge to split beside the focused pane · release here to cancel", t.border));
    return v_flex().id("root").size_full().p(8).pt(CANCEL_BAND)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_move((e, cx) => { this.pos = e.local_position ?? e.position; cx.notify(); })
      .on_mouse_up("left", (e) => { this.pos = e.local_position ?? e.position ?? this.pos; this.finish(this.zone()); })
      // A press here means the release was missed (it happened before the overlay showed): cancel.
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.finish(null); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.finish(null); })
      .child(preview);
  }
}
