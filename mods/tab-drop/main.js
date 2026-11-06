// Choose an explicit side of the captured target. Never paint a fake half-window
// preview: sidebar/panels and multi-pane layouts do not describe the target bounds.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, panes, focused, theme, closeOverlay, setShared, window } from "herdr";

export default class TabDrop extends View {
  init(_p,cx) {
    this.done = false;
    this.target = props()?.target ?? focused()?.pane;
    this.place = null;
    this.focusHandle = cx.focus_handle();
    this.focusHandle.focus();
  }
  finish(place) {
    if (this.done) return;
    this.done = true;
    const p = props() ?? {};
    // A target that vanished mid-drag must not silently become the current pane.
    if (place && panes().some(p => p.pane === this.target))
      setShared("tabs-weed.drop",{id:`${Date.now()}-${Math.random()}`,tab:p.tab??null,terminal:p.terminal??null,target:this.target,place});
    closeOverlay(p.overlay);
  }
  render(cx) {
    if (window() && !window().active) cx.timer.after(0, () => this.finish(null));
    const t=theme(), target=panes().find(p => p.pane===this.target);
    const cell=(place,label) => div().id(`drop-${place??"cancel"}`).w(108).h(54).rounded(7)
      .flex().items_center().justify_center().border(1).border_color(this.place===place?t.accent:t.border)
      .bg(this.place===place?t.selection:t.surface).text_color(t.foreground).text_size(13).child(label)
      .on_hover((on,cx) => {this.place=on?place:null;cx.notify();})
      .on_mouse_up("left",(_e,cx) => {cx.stop_propagation();this.finish(place);});
    return v_flex().id("root").size_full().items_center().justify_center().track_focus(this.focusHandle)
      .on_key_down((e,cx) => {if(e.keystroke === "escape" || e.keystroke?.key === "escape" || e.key === "escape"){cx.stop_propagation();this.finish(null);}})
      .on_mouse_up("left",() => this.finish(null))
      .on_mouse_down("left",(_e,cx) => {cx.stop_propagation();this.finish(null);})
      .on_mouse_down("right",(_e,cx) => {cx.stop_propagation();this.finish(null);})
      .child(v_flex().w(368).p(14).gap(8).rounded(10).bg(t.popover).border(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("방향 위에서 놓으면 창을 이동합니다"))
        .child(div().text_size(11).text_color(t.muted).truncate().child(target?`대상: ${target.title || target.program?.name || target.terminal}`:"대상 창이 없습니다 · 이동 취소"))
        .child(h_flex().justify_center().child(cell("up","↑ 위쪽")))
        .child(h_flex().gap(6).child(cell("left","← 왼쪽")).child(cell(null,"취소")).child(cell("right","오른쪽 →")))
        .child(h_flex().justify_center().child(cell("down","↓ 아래쪽")))
        .child(div().text_size(11).text_color(t.muted).child("바깥에서 놓거나 Esc를 누르면 취소됩니다.")));
  }
}
