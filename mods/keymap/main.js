// Shortcut manager: list, filter, add, edit and delete keys.json bindings.
// Shows which bindings shadow others (layout/terminal over global) and
// actions that aren't a known app command. Writes keys.json atomically,
// backs it up once per session, and reports keys.error after a save.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, commands, appHome, readTextFile, writeTextFile } from "herdr";

const MODIFIERS = new Set(["shift", "control", "ctrl", "alt", "cmd", "platform", "function", "fn"]);

const descriptions = {
  "space.select": ["작업 공간 선택", "번호에 해당하는 작업 공간으로 이동합니다."],
  "space.next": ["다음 작업 공간", "다음 작업 공간으로 이동합니다."], "space.prev": ["이전 작업 공간", "이전 작업 공간으로 이동합니다."],
  "space-folders.next": ["다음 작업 공간", "폴더 목록에 표시된 순서대로 다음 작업 공간으로 이동합니다."], "space-folders.prev": ["이전 작업 공간", "폴더 목록에 표시된 순서대로 이전 작업 공간으로 이동합니다."],
  "space.new": ["작업 공간 만들기", "새 작업 공간을 추가합니다."], "space.rename": ["작업 공간 이름 변경", "현재 작업 공간의 이름을 바꿉니다."],
  "tab.select": ["탭 선택", "번호에 해당하는 탭으로 이동합니다."], "tab.next": ["다음 탭", "현재 작업 공간의 다음 탭으로 이동합니다."], "tab.prev": ["이전 탭", "현재 작업 공간의 이전 탭으로 이동합니다."],
  "tab.new": ["새 탭 열기", "현재 작업 공간에 새 터미널 탭을 엽니다."], "tab.close": ["현재 탭 닫기", "현재 탭을 닫습니다. 실행 중인 작업을 먼저 확인하세요."], "tab.rename": ["탭 이름 변경", "현재 탭의 이름을 바꿉니다."],
  "pane.go": ["분할 창으로 이동", "지정한 방향의 터미널로 입력 포커스를 옮깁니다."], "pane.swap": ["분할 창 위치 교환", "현재 터미널과 지정한 방향의 터미널 위치를 맞바꿉니다."],
  "pane.split": ["터미널 분할", "현재 창 옆 또는 아래에 새 터미널을 엽니다."], "pane.close": ["현재 분할 창 닫기", "현재 선택한 분할 터미널을 닫습니다."], "pane.zoom": ["분할 창 확대 / 복원", "현재 터미널을 크게 보거나 원래 분할 화면으로 돌아갑니다."],
  "agent.next": ["다음 에이전트", "다음 에이전트로 이동합니다."], "agent.prev": ["이전 에이전트", "이전 에이전트로 이동합니다."],
  "app.zoom_in": ["화면 확대", "글자와 UI를 크게 표시합니다."], "app.zoom_out": ["화면 축소", "글자와 UI를 작게 표시합니다."], "app.zoom_reset": ["화면 배율 초기화", "기본 크기로 돌아갑니다."],
  "app.help": ["도움말 열기", "Herdr 사용 안내를 엽니다."], "app.settings": ["설정 열기", "화면 모양, 단축키 등 앱 설정을 확인합니다."], "app.palette": ["명령 검색", "실행할 기능을 이름으로 검색합니다."],
  "layout.toggle": ["사이드바 표시 / 숨기기", "왼쪽 작업 공간 목록을 접거나 펼칩니다."], "layout.switch": ["화면 배치 변경", "다른 레이아웃으로 전환합니다."],
  "terminal.copy": ["선택한 텍스트 복사", "터미널에서 선택한 텍스트를 클립보드에 복사합니다."], "terminal.paste": ["텍스트 붙여넣기", "클립보드 내용을 터미널에 입력합니다."], "terminal.paste_image": ["이미지 붙여넣기", "클립보드 이미지를 현재 터미널에 붙여넣습니다."], "terminal.search": ["터미널 내용 검색", "터미널 출력에서 원하는 문자열을 찾습니다."],
  "tabs-weed.detach": ["분할 창을 탭으로 분리", "현재 분할 터미널을 별도의 탭으로 옮깁니다."], "tabs-weed.panel-workflow": ["워크플로 패널 열기 / 닫기", "현재 작업 공간의 워크플로 실행 상태를 확인합니다."],
};
const directions = {right:"오른쪽",left:"왼쪽",up:"위쪽",down:"아래쪽"};
const modNames = {"settings-weed":"설정",keymap:"단축키 목록",picker:"작업 검색","agent-resume":"에이전트 이어하기","sessions-weed":"저장된 세션"};
function describe(value) {
  const [name, suffix] = typeof value === "string" ? value.split(":") : [value?.command, null];
  const args = typeof value === "object" ? value.args ?? {} : {};
  if (name === "mod.open") return [(modNames[suffix ?? args.name] ?? suffix ?? args.name) + " 열기", "해당 기능의 창을 열거나 닫습니다."];
  if (name?.startsWith("tabs-weed.pull-")) return ["인접 탭을 분할 창으로 가져오기", directions[name.slice(15)] + "에 배치하도록 인접 탭을 가져옵니다."];
  if (name === "send") return ["터미널 편집 키 전송", {"\\u0017":"커서 앞의 단어를 지웁니다.","\\u001bb":"커서를 이전 단어로 옮깁니다.","\\u001bf":"커서를 다음 단어로 옮깁니다."}[JSON.stringify(value.slice(5)).slice(1,-1)] ?? "프로그램에 터미널 제어 문자를 보냅니다."];
  if (name === "terminal") return ["프로그램에 키 전달", "Herdr가 처리하지 않고 실행 중인 프로그램에 전달합니다."];
  const result = descriptions[name] ?? [name ?? "사용자 지정 명령", commands().find(c => c.name === name)?.about ?? "사용자가 추가한 기능입니다."];
  const detail = directions[args.direction ?? suffix] ?? ((name === "tab.select" || name === "space.select") ? suffix + "번" : "");
  const program = args.argv?.[0];
  return [result[0] + (detail ? " · " + detail : "") + (program ? " · " + program : ""), result[1] + (program ? " " + program + "을 실행합니다." : "")];
}
function sectionLabel(s) { return s === "all" ? "전체" : s === "global" ? "앱 전체" : s === "terminal" ? "터미널 안에서" : s.startsWith("layout:") ? "레이아웃: " + s.slice(7) : s; }

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

    this.input = InputState.new({ placeholder: "기능 설명 또는 단축키로 검색…" });
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
      for (const [key, action] of Object.entries(map)) out.push({ section, key, action: typeof action === "string" ? action : JSON.stringify(action), value: action });
    }
    const global = this.data.global ?? {};
    for (const r of out) {
      r.notes = [];
      if (r.section === "global") {
        for (const [s, map] of Object.entries(this.data)) {
          if (s !== "global" && map && map[r.key] !== undefined && map[r.key] !== r.action) r.notes.push(`${sectionLabel(s)}에서는 다른 기능 실행`);
        }
      } else if (global[r.key] !== undefined && global[r.key] !== r.action) {
        r.notes.push(`앱 전체 설정보다 우선 적용`);
      }
      const name = typeof r.value === "object" ? r.value.command : r.action.split(":")[0];
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
    try { next[f.section][f.key] = f.action.startsWith("{") ? JSON.parse(f.action) : f.action; } catch (_) { this.message = { text: "Invalid action JSON", error: true }; cx.notify(); return; }
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
      && (!f || r.key.toLowerCase().includes(f) || r.action.toLowerCase().includes(f) || describe(r.value).join(" ").toLowerCase().includes(f)));
    const shadowed = all.filter((r) => r.notes.length).length;

    return v_flex().id("keymap").track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(12.5)
      .child(h_flex().h(24).items_center().justify_between()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("단축키 안내"))
        .child(h_flex().gap(10).items_center()
          .child(div().text_size(11).text_color(t.dim).child(`${all.length} bindings · ${shadowed} shadowing`))
          .child(this.button("km-add", "+ Add", (cx) => { this.startForm(null); cx.notify(); }, { primary: true }))
          .child(this.button("km-reload", "Reload", (cx) => { this.message = null; this.reload(cx); }))))
      .child(div().text_size(12).text_color(t.muted).child("키를 함께 누르면 아래 기능이 실행됩니다. 앱 전체는 공통 단축키, 터미널 안에서는 터미널 전용 단축키입니다. 같은 키가 겹치면 해당 화면의 설정이 우선합니다."))
      .child(Input.new(this.input).h(34).flex_none().px(10).rounded(9).border_1().border_color(t.border).bg(t.background).text_color(t.foreground))
      .child(h_flex().flex_none().gap(4).flex_wrap().children(sections.map((s) =>
        div().id(`km-sec-${s}`).h(24).px(9).flex().items_center().rounded(12).text_size(11.5)
          .bg(this.section === s ? t.selected : t.background).text_color(this.section === s ? t.foreground : t.muted)
          .border_1().border_color(t.border).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.section = s; cx.notify(); }).child(sectionLabel(s)))))
      .when(!!this.message, (el) => el.child(div().flex_none().px(10).py(6).rounded(7).text_size(12)
        .bg(t.background).text_color(this.message.error ? t.blocked : t.done).child(this.message.text)))
      .when(!!this.form, (el) => el.child(this.renderForm(t)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(1).children(shown.map((r) => {
        const id = `${r.section}|${r.key}`;
        const confirming = this.pendingDelete === id;
        return h_flex().id(`km-row-${id}`).min_h(64).py(6).px(8).gap(10).rounded(7).items_center().hover((s) => s.bg(t.hover))
          .child(div().w(170).flex_none().text_color(t.accent).child(r.key))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_color(r.unknown ? t.muted : t.foreground).child(describe(r.value)[0]))
            .child(div().text_size(11).text_color(t.muted).child(describe(r.value)[1]))
            .child(div().text_size(10).text_color(t.dim).tooltip(r.action).truncate().child(r.action))
            .when(r.notes.length > 0, (el) => el.child(div().truncate().text_size(11).text_color(t.blocked).child(r.notes.join(" · ")))))
          .child(div().w(130).flex_none().truncate().text_size(11).text_color(t.dim).tooltip("이 단축키가 적용되는 범위").child(sectionLabel(r.section)))
          .child(this.button(`km-edit-${id}`, "수정", (cx) => { this.startForm(r); cx.notify(); }))
          .child(this.button(`km-del-${id}`, confirming ? "삭제 확인" : "삭제", (cx) => {
            if (confirming) this.remove(r, cx); else { this.pendingDelete = id; cx.notify(); }
          }, { danger: true }));
      })));
  }
}
