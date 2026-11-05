import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, appHome, run, theme, props, closeOverlay, notify, nextCommand, panes, spaces, focused } from "herdr";
import { visibleSessions, pageRows, sessionsInSpace } from "./model.js";

async function request(data) {
  const result = await exec("python3", [`${appHome()}/mods/sessions-weed/backend.py`, JSON.stringify(data)]);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error(result.stderr || "Session helper did not return a result"); }
  if (result.code || !value.ok) throw new Error(value.error || result.stderr || "Session operation failed");
  return value.result;
}

function button(id, text, t, click, selected = false) {
  return div().id(id).px(10).py(6).rounded(6).flex_none().text_size(12).cursor_pointer()
    .bg(selected ? t.selected : t.raised).text_color(selected ? t.accent : t.foreground)
    .hover(el => el.bg(t.hover)).on_click(click).child(text);
}

export default class Sessions extends View {
  init(_p, cx) {
    this.rows = [];
    this.issues = [];
    this.archived = false;
    this.scope = "space";
    this.agent = "all";
    this.page = 0;
    this.loading = false;
    this.busy = false;
    this.error = "";
    this.editing = null;
    this.filter = InputState.new({ value: "", placeholder: "Search title, folder, agent, PC or session ID" });
    this.name = InputState.new({ value: "", placeholder: "Session name" });
    this.filter.on("change", (_e, cx) => { this.page = 0; cx.notify(); });
    this.name.on("change", (_e, cx) => cx.notify());
    this.name.on("submit", (_e, cx) => this.saveName(cx));
    this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(20000, cx => this.refresh(cx));
    cx.timer.every(250, cx => this.reconcile(cx));
    // Desktop commands use the same actions as the visible controls.
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "show-archive" || command === "show-sessions") {
          this.archived = command === "show-archive";
          this.page = 0;
        } else if (command === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const value = await request({ action: "list" });
        this.rows = value.sessions;
        this.issues = value.issues;
        this.error = "";
      } catch (error) { this.error = String(error.message || error); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  act(data, cx) {
    if (this.busy || this.loading) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async cx => {
      try {
        if (data.action === "resume") {
          const row = this.rows.find(row => row.id === data.id);
          const sameHost = spaces().filter(space => (space.machine || "") === (row?.host || ""));
          const space = sameHost.find(space => space.id === focused()?.space) ?? sameHost[0];
          if (space) data.space = space.id.split("/").at(-1);
        }
        const result = await request(data);
        if (data.action === "resume") {
          this.pending = { ...result, until: Date.now() + 15000 };
          this.reconcile(cx);
        } else {
          this.editing = null;
          this.busy = false;
          this.refresh(cx);
        }
      } catch (error) { this.error = String(error.message || error); }
      finally { this.busy = Boolean(this.pending); cx.notify(); }
    });
  }

  reconcile(cx) {
    if (!this.pending) return;
    const pane = panes().find(pane => pane.terminal === this.pending.terminal);
    if (pane) {
      const existing = this.pending.existing;
      this.pending = null;
      this.busy = false;
      run("pane.focus", { pane: pane.pane });
      closeOverlay(props().overlay);
      notify({ title: existing ? "Opened running session" : "Session resume started", level: "success", timeout: 3000 });
    } else if (this.pending.existing && !this.pending.adopting) {
      this.pending.adopting = true;
      run("terminal.keep", { terminal: this.pending.terminal, place: "tab" });
    } else if (Date.now() > this.pending.until) {
      this.error = "The session has a terminal, but its tab did not appear. Refresh and open it again.";
      this.pending = null;
      this.busy = false;
    }
    cx.notify();
  }

  saveName(cx) {
    if (this.editing) this.act({ action: "rename", id: this.editing, title: this.name.value() }, cx);
  }

  row(row, t) {
    const running = row.live_terminal;
    const stamp = new Date(row.updated_at).toLocaleDateString();
    return v_flex().id(`session-${row.id}`).flex_none().px(12).py(10).gap(5)
      .rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().child(row.title))
        .child(div().text_size(11).text_color(running ? t.working : t.dim).child(running ? "Running" : "Saved"))
        .child(div().text_size(11).text_color(t.dim).child(stamp)))
      .child(div().truncate().text_size(11.5).text_color(t.muted).child(`${row.agent} · ${row.host || "This PC"} · ${row.cwd}`))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(row.session))
        .child(button(`resume-${row.id}`, running ? "Open" : "Resume", t, (_e, cx) => this.act({ action: "resume", id: row.id }, cx), true))
        .child(button(`rename-${row.id}`, "Rename", t, (_e, cx) => {
          this.editing = row.id;
          this.name.set_value(row.title);
          this.name.focus();
          cx.notify();
        }))
        .child(button(`archive-${row.id}`, this.archived ? "Restore" : "Archive", t, (_e, cx) =>
          this.act({ action: this.archived ? "restore" : "archive", id: row.id }, cx))))
      .when(!row.available, el => el.child(div().text_size(11).text_color(t.blocked).child("Working folder or saved conversation is missing")));
  }

  render() {
    const t = theme();
    const allSpaces = spaces();
    const space = allSpaces.find(space => space.id === focused()?.space);
    const scopeKey = this.scope === "space" ? space?.id : "all";
    if (this.lastScope !== scopeKey) { this.page = 0; this.editing = null; this.lastScope = scopeKey; }
    const scoped = this.scope === "space" ? sessionsInSpace(this.rows, space, allSpaces, panes()) : this.rows;
    const active = scoped.filter(row => !row.archived_at).length;
    const archived = scoped.length - active;
    const rows = visibleSessions(scoped, { archived: this.archived, query: this.filter.value(), agent: this.agent });
    const page = pageRows(rows, this.page);
    const agents = [...new Set(scoped.map(row => row.agent))].sort();
    return v_flex().id("session-manager").size_full().min_h(0).p(18).gap(12)
      .track_focus(this.handle).bg(t.popover).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(17).font_semibold().child("Sessions"))
        .child(button("sessions-refresh", this.loading ? "Refreshing…" : "Refresh", t, (_e, cx) => this.refresh(cx)))
        .child(button("sessions-close", "Close", t, () => closeOverlay(props().overlay))))
      .child(div().text_size(11.5).text_color(t.muted).child("Archive keeps the conversation and its running terminal. Resume continues the saved conversation."))
      .child(h_flex().gap(6).items_center()
        .child(button("sessions-scope-space", "Current space", t, (_e, cx) => { this.scope = "space"; cx.notify(); }, this.scope === "space"))
        .child(button("sessions-scope-all", "All spaces", t, (_e, cx) => { this.scope = "all"; cx.notify(); }, this.scope === "all"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
          .child(this.scope === "space" ? `${space?.name || "No space selected"} · ${space?.machine || "This PC"}` : "All saved sessions")))
      .child(h_flex().gap(6)
        .child(button("sessions-active", `Sessions (${active})`, t, (_e, cx) => { this.archived = false; this.page = 0; cx.notify(); }, !this.archived))
        .child(button("sessions-archive", `Archive (${archived})`, t, (_e, cx) => { this.archived = true; this.page = 0; cx.notify(); }, this.archived)))
      .child(Input.new(this.filter).h(34).px(10).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground))
      .child(h_flex().gap(5).children(["all", ...agents].map(agent => button(`sessions-filter-${agent}`, agent === "all" ? "All agents" : agent, t,
        (_e, cx) => { this.agent = agent; this.page = 0; cx.notify(); }, this.agent === agent))))
      .when(Boolean(this.editing), el => el.child(h_flex().gap(6).items_center()
        .child(Input.new(this.name).flex_1().h(32).px(8).border_1().border_color(t.accent).rounded(6).bg(t.background))
        .child(button("sessions-name-save", "Save name", t, (_e, cx) => this.saveName(cx), true))
        .child(button("sessions-name-cancel", "Cancel", t, (_e, cx) => { this.editing = null; cx.notify(); }))))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(this.issues.length > 0, el => el.child(div().text_size(11).text_color(t.blocked).child(this.issues.join(" · "))))
      .child(v_flex().id("session-rows").flex_1().min_h(0).overflow_y_scrollbar().gap(7)
        .children(page.rows.map(row => this.row(row, t)))
        .when(!rows.length, el => el.child(div().p(20).text_size(13).text_color(t.muted)
          .child(this.loading ? "Loading session history…" : this.filter.value() ? "No matching sessions" : this.archived ? "No archived sessions" : "No saved sessions yet"))))
      .child(h_flex().items_center().gap(7)
        .child(div().flex_1().text_size(11).text_color(t.dim).child(this.busy ? "Saving…" : `${rows.length} sessions · ${page.page + 1} / ${page.count}`))
        .child(button("sessions-previous", "Previous", t, (_e, cx) => { this.page = Math.max(0, page.page - 1); cx.notify(); }))
        .child(button("sessions-next", "Next", t, (_e, cx) => { this.page = Math.min(page.count - 1, page.page + 1); cx.notify(); })));
  }
}
