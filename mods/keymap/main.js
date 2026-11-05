// Shortcut manager: list, filter, add, edit and delete keys.json bindings.
// Shows which bindings shadow others (layout/terminal over global) and
// actions that aren't a known app command. Writes keys.json atomically,
// backs it up once per session, and reports keys.error after a save.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, commands, appHome, readTextFile, writeTextFile } from "herdr";

const MODIFIERS = new Set(["shift", "control", "ctrl", "alt", "cmd", "platform", "function", "fn"]);

function label(action) {
  if (action === "terminal") return "pass key to program";
  if (action.startsWith("send:")) return "type " + JSON.stringify(action.slice(5));
  return action;
}

export default class Keymap extends View {
  init(_props, cx) {
    this.path = `${appHome()}/keys.json`;
    this.raw = null;        // text as read, for writeTextFile's stale check
    this.data = {};         // parsed keys.json
    this.filter = "";
    this.section = "all";   // section filter
    this.form = null;       // { section, key, action, orig: {section,key} | null, overwrite }
    this.recording = false;
    this.pendingDelete = null;
    this.message = null;    // { text, error }
    this.backedUp = false;
    this.known = new Set(commands().map((c) => c.name));

    this.input = InputState.new({ placeholder: "Filter by key or action…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.keyInput = InputState.new({ placeholder: "e.g. ctrl-shift-g" });
    this.keyInput.on("change", (_e, cx) => { if (this.form) { this.form.key = this.keyInput.value().trim(); this.form.overwrite = false; } cx.notify(); });
    this.actionInput = InputState.new({ placeholder: "e.g. tab.new, layout.toggle:sidebar, send:\\u0017" });
    this.actionInput.on("change", (_e, cx) => { if (this.form) this.form.action = this.actionInput.value().trim(); cx.notify(); });
    this.sectionInput = InputState.new({ placeholder: "global, terminal, layout:<name>, mod:<name>" });
    this.sectionInput.on("change", (_e, cx) => { if (this.form) { this.form.section = this.sectionInput.value().trim(); this.form.overwrite = false; } cx.notify(); });

    this.handle = cx.focus_handle();
    this.input.focus();
    this.reload(cx);
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      try {
        this.raw = await readTextFile(this.path);
        this.data = this.raw ? JSON.parse(this.raw) : {};
      } catch (e) {
        this.message = { text: `Can't read keys.json: ${e}`, error: true };
      }
      cx.notify();
    });
  }

  rows() {
    const out = [];
    for (const [section, map] of Object.entries(this.data)) {
      if (!map || typeof map !== "object") continue;
      for (const [key, action] of Object.entries(map)) out.push({ section, key, action: String(action) });
    }
    const global = this.data.global ?? {};
    for (const r of out) {
      r.notes = [];
      if (r.section === "global") {
        for (const [s, map] of Object.entries(this.data)) {
          if (s !== "global" && map && map[r.key] !== undefined && map[r.key] !== r.action) r.notes.push(`overridden in ${s}`);
        }
      } else if (global[r.key] !== undefined && global[r.key] !== r.action) {
        r.notes.push(`overrides global: ${global[r.key]}`);
      }
      const name = r.action.split(":")[0];
      r.unknown = !(r.action === "terminal" || r.action.startsWith("send:") || this.known.has(name));
    }
    return out;
  }

  startForm(row) {
    this.form = row
      ? { section: row.section, key: row.key, action: row.action, orig: { section: row.section, key: row.key }, overwrite: false }
      : { section: this.section === "all" ? "global" : this.section, key: "", action: "", orig: null, overwrite: false };
    this.sectionInput.set_value(this.form.section);
    this.keyInput.set_value(this.form.key);
    this.actionInput.set_value(this.form.action);
    this.recording = false;
    this.message = null;
    this.actionInput.focus();
  }

  async write(next, cx, done) {
    const text = JSON.stringify(next, null, 2) + "\n";
    try {
      if (!this.backedUp && this.raw) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await writeTextFile(`${appHome()}/keys.json.keymap-backup-${stamp}`, this.raw, null);
        this.backedUp = true;
      }
      await writeTextFile(this.path, text, this.raw);
      this.raw = text;
      this.data = next;
      this.message = { text: done, error: false };
    } catch (e) {
      this.message = { text: `Save failed (keys.json changed elsewhere?): ${e}. Reloaded.`, error: true };
      this.reload(cx);
    }
    cx.notify();
    // The app validates keys.json on change; surface its verdict.
    cx.timer.after(1200, () => cx.spawn(async (cx) => {
      const err = await readTextFile(`${appHome()}/keys.error`).catch(() => null);
      if (err) { this.message = { text: `keys.error: ${err.trim()}`, error: true }; cx.notify(); }
    }));
  }

  save(cx) {
    const f = this.form;
    if (!f.section || !f.key || !f.action) { this.message = { text: "Section, key and action are all required.", error: true }; cx.notify(); return; }
    const next = JSON.parse(JSON.stringify(this.data));
    const same = f.orig && f.orig.section === f.section && f.orig.key === f.key;
    const existing = next[f.section]?.[f.key];
    if (existing !== undefined && !same && !f.overwrite) {
      f.overwrite = true;
      this.message = { text: `${f.key} in ${f.section} is already "${existing}". Press Save again to replace it.`, error: true };
      cx.notify();
      return;
    }
    if (f.orig) delete next[f.orig.section]?.[f.orig.key];
    next[f.section] ??= {};
    next[f.section][f.key] = f.action;
    this.form = null;
    cx.spawn(async (cx) => this.write(next, cx, `Saved ${f.key} → ${f.action} (${f.section}).`));
  }

  remove(row, cx) {
    const next = JSON.parse(JSON.stringify(this.data));
    delete next[row.section]?.[row.key];
    if (next[row.section] && Object.keys(next[row.section]).length === 0) delete next[row.section];
    this.pendingDelete = null;
    cx.spawn(async (cx) => this.write(next, cx, `Deleted ${row.key} (${row.section}).`));
  }

  onKey(e, cx) {
    if (this.recording) {
      if (MODIFIERS.has(e.key)) return;
      if (e.key === "escape" && !e.modifiers?.control && !e.modifiers?.alt && !e.modifiers?.shift) { this.recording = false; cx.notify(); return; }
      // GPUI spells the platform key "cmd" everywhere; keys.json uses the same spelling.
      this.form.key = e.keystroke;
      this.form.overwrite = false;
      this.keyInput.set_value(e.keystroke);
      this.recording = false;
      this.actionInput.focus();
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (e.key === "escape") {
      if (this.form) { this.form = null; this.input.focus(); cx.notify(); return; }
      closeOverlay(props().overlay);
    }
  }

  button(id, text, onClick, { danger = false, primary = false } = {}) {
    const t = theme();
    return div().id(id).h(26).px(10).flex_none().flex().items_center().rounded(6).text_size(12)
      .bg(primary ? t.accent : t.background).text_color(primary ? t.background : danger ? t.blocked : t.foreground)
      .border_1().border_color(danger ? t.blocked : t.border)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(text);
  }

  renderForm(t) {
    const f = this.form;
    const q = (f.action || "").toLowerCase();
    const suggestions = q && !this.known.has(f.action.split(":")[0])
      ? commands().filter((c) => c.name.includes(q)).slice(0, 8)
      : [];
    const field = (name, state, extra) => h_flex().gap(8).items_center()
      .child(div().w(64).flex_none().text_color(t.dim).child(name))
      .child(Input.new(state).flex_1().h(30).px(8).rounded(7).border_1().border_color(t.border).bg(t.background).text_size(12.5).text_color(t.foreground))
      .when(!!extra, (el) => el.child(extra));
    return v_flex().flex_none().gap(8).p(12).rounded(9).border_1().border_color(t.accent).bg(t.chrome)
      .child(div().font_semibold().text_color(t.foreground).child(f.orig ? `Edit ${f.orig.key} (${f.orig.section})` : "New shortcut"))
      .child(field("Section", this.sectionInput))
      .child(field("Key", this.keyInput, this.button("km-record", this.recording ? "Press keys… (Esc cancels)" : "Record", (cx) => {
        this.recording = true; this.handle.focus(); cx.notify();
      }, { primary: this.recording })))
      .child(field("Action", this.actionInput))
      .when(suggestions.length > 0, (el) => el.child(
        v_flex().pl(72).gap(1).children(suggestions.map((c) =>
          h_flex().id(`km-sug-${c.name}`).h(24).px(6).gap(10).rounded(5).items_center().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.form.action = c.name; this.actionInput.set_value(c.name); cx.notify(); })
            .child(div().w(190).flex_none().text_color(t.accent).child(c.name))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(c.about))))))
      .child(h_flex().gap(8).justify_end()
        .child(this.button("km-cancel", "Cancel", (cx) => { this.form = null; this.input.focus(); cx.notify(); }))
        .child(this.button("km-save", f.overwrite ? "Replace" : "Save", (cx) => this.save(cx), { primary: true })));
  }

  render(cx) {
    const t = theme();
    const all = this.rows();
    const sections = ["all", ...Object.keys(this.data)];
    const f = this.filter.toLowerCase();
    const shown = all.filter((r) => (this.section === "all" || r.section === this.section)
      && (!f || r.key.toLowerCase().includes(f) || r.action.toLowerCase().includes(f)));
    const shadowed = all.filter((r) => r.notes.length).length;

    return v_flex().id("keymap").track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(12.5)
      .child(h_flex().h(24).items_center().justify_between()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Shortcuts"))
        .child(h_flex().gap(10).items_center()
          .child(div().text_size(11).text_color(t.dim).child(`${all.length} bindings · ${shadowed} shadowing`))
          .child(this.button("km-add", "+ Add", (cx) => { this.startForm(null); cx.notify(); }, { primary: true }))
          .child(this.button("km-reload", "Reload", (cx) => { this.message = null; this.reload(cx); }))))
      .child(Input.new(this.input).h(34).flex_none().px(10).rounded(9).border_1().border_color(t.border).bg(t.background).text_color(t.foreground))
      .child(h_flex().flex_none().gap(4).flex_wrap().children(sections.map((s) =>
        div().id(`km-sec-${s}`).h(24).px(9).flex().items_center().rounded(12).text_size(11.5)
          .bg(this.section === s ? t.selected : t.background).text_color(this.section === s ? t.foreground : t.muted)
          .border_1().border_color(t.border).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.section = s; cx.notify(); }).child(s))))
      .when(!!this.message, (el) => el.child(div().flex_none().px(10).py(6).rounded(7).text_size(12)
        .bg(t.background).text_color(this.message.error ? t.blocked : t.done).child(this.message.text)))
      .when(!!this.form, (el) => el.child(this.renderForm(t)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(1).children(shown.map((r) => {
        const id = `${r.section}|${r.key}`;
        const confirming = this.pendingDelete === id;
        return h_flex().id(`km-row-${id}`).min_h(32).px(8).gap(10).rounded(7).items_center().hover((s) => s.bg(t.hover))
          .child(div().w(170).flex_none().text_color(t.accent).child(r.key))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_color(r.unknown ? t.muted : t.foreground).child(label(r.action) + (r.unknown ? "  (mod/unknown)" : "")))
            .when(r.notes.length > 0, (el) => el.child(div().truncate().text_size(11).text_color(t.blocked).child(r.notes.join(" · ")))))
          .child(div().w(130).flex_none().truncate().text_size(11).text_color(t.dim).child(r.section))
          .child(this.button(`km-edit-${id}`, "Edit", (cx) => { this.startForm(r); cx.notify(); }))
          .child(this.button(`km-del-${id}`, confirming ? "Confirm" : "Delete", (cx) => {
            if (confirming) this.remove(r, cx); else { this.pendingDelete = id; cx.notify(); }
          }, { danger: true }));
      })));
  }
}
