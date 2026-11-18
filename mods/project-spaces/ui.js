// Small shared UI pieces for the project-spaces sidebar and its overlays.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";

// Avatar colors (same table space-folders uses): one strong color per hue.
export const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
export const ROLE_LABEL = { impl: "impl", qa: "QA", plan: "plan" };
export const icon = (name) => `mods/workspace-chrome/${name}.svg`;

// A project's tile color: stable per project key.
export function projectColor(key) {
  if (!key) return null;
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return MARK[PALETTE[h % PALETTE.length]];
}

export const pcLabel = (machine) => machine ?? "This computer";

export function button(t, id, label, primary, action, { disabled = false } = {}) {
  return h_flex().id(id).h(32).px(14).flex_none().items_center().rounded(8).border_1()
    .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground)
    .text_size(12.5).font_medium()
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
    .child(label);
}

export function roleBadge(t, role, key) {
  return div().id(key).flex_none().px(5).h(15).rounded(4).flex().items_center()
    .bg(t.accent + "22").text_size(9.5).font_semibold().text_color(t.accent).child(ROLE_LABEL[role] ?? role);
}

// A dialog frame: title, optional subtitle, body children, footer buttons.
export function dialog(t, id, title, subtitle, body, footer, onEscape) {
  return v_flex().id(id).w_full().p(20).gap(14).bg(t.popover).text_color(t.foreground).text_size(13)
    .on_key_down((e, cx) => { if (e.key === "escape") { onEscape(); cx.stop_propagation(); } })
    .child(v_flex().gap(4)
      .child(div().text_size(15).font_semibold().child(title))
      .when(Boolean(subtitle), (el) => el.child(div().text_size(12).text_color(t.dim).child(subtitle))))
    .children(body)
    .child(h_flex().pt(4).gap(8).justify_end().children(footer));
}

// A labelled one-line text field over a retained InputState.
export function field(t, id, label, state, hint) {
  return v_flex().id(id).gap(5)
    .child(div().text_size(11.5).text_color(t.dim).child(label))
    .child(Input.new(state).h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
    .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
}

// A status line: level "error" | "warn" | "ok" | "info".
export function message(t, id, level, text) {
  const color = level === "error" ? t.blocked : level === "warn" ? t.ansi3 : level === "ok" ? t.ansi2 : t.muted;
  return h_flex().id(id).gap(8).px(10).py(8).rounded(8).bg(color + "1c").text_size(12).text_color(color)
    .child(div().flex_none().child(level === "error" ? "✕" : level === "warn" ? "!" : level === "ok" ? "✓" : "·"))
    .child(div().flex_1().min_w(0).child(text));
}

// A big choice card (Add PC mode, New space action).
export function card(t, id, title, body, action, { disabled = false } = {}) {
  return v_flex().id(id).flex_1().min_w(0).p(12).gap(4).rounded(10).border_1().border_color(t.border).bg(t.raised)
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.border_color(t.accent)).on_click(action))
    .child(div().text_size(13).font_semibold().child(title))
    .child(div().text_size(11.5).text_color(t.dim).child(body));
}

export function note(t, text) {
  return h_flex().gap(8).p(10).rounded(8).bg(t.raised).text_size(12).text_color(t.muted)
    .child(svg(icon("clock")).size(13).flex_none().text_color(t.dim))
    .child(div().flex_1().min_w(0).child(text));
}
