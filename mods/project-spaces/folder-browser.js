// In-app folder browser for one machine, built on backend.listDir (exec on that
// machine): no system picker, no SFTP. The folder shown is the selection.
// Each subfolder is tagged: git / remote / same project / other project / worktree.
// Pinned on the left of the path bar: home, the project's linked folders on that PC,
// and recent folders (per machine, shared "project-spaces.recent": folders people chose).
//
//   const b = new FolderBrowser({ machine, projectKey, pinned, onChange });
//   b.open(path, cx)          load a folder (null: home)
//   b.render(t, { action })   the element; action(entry) -> { label, run } | null per row

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { shared, setShared } from "herdr";
import { listDir, parentOf } from "./backend.js";
import { remoteKey, normPath } from "./project-model.js";
import { icon, pcLabel } from "./ui.js";

const RECENT_MAX = 8;
// Shared, not localStorage: each overlay is a new mod copy with its own storage.
export const SHARED_RECENT = "project-spaces.recent";

export function loadRecent(machine) {
  const all = shared(SHARED_RECENT);
  const v = all && typeof all === "object" ? all[machine ?? ""] : null;
  return Array.isArray(v) ? v.filter((p) => typeof p === "string") : [];
}
// Recent = folders a person chose (connected, cloned into, opened), not every folder browsed.
export function rememberRecent(machine, path) {
  if (!path) return;
  const n = normPath(path);
  const list = [n, ...loadRecent(machine).filter((p) => p !== n)].slice(0, RECENT_MAX);
  const all = shared(SHARED_RECENT);
  setShared(SHARED_RECENT, { ...(all && typeof all === "object" ? all : {}), [machine ?? ""]: list });
}

// Tags for one lsdir entry (or the folder itself, `self`).
export function tagsOf(git, projectKey) {
  if (!git) return [];
  const tags = ["git"];
  const key = remoteKey(git.origin);
  if (key) tags.push("remote");
  if (key && projectKey) tags.push(key === projectKey ? "same-project" : "other-project");
  if (git.kind === "worktree") tags.push("worktree");
  if (git.kind === "submodule") tags.push("submodule");
  return tags;
}

const TAG_LABEL = { git: "git", remote: "remote", "same-project": "this project", "other-project": "other project", worktree: "worktree", submodule: "submodule" };

export class FolderBrowser {
  // Construct in init or an event handler (it makes an InputState).
  constructor({ machine = null, projectKey = null, pinned = [], id = "fb", onChange = null } = {}) {
    this.machine = machine;
    this.projectKey = projectKey;
    this.pinnedExtra = pinned.filter(Boolean);
    this.id = id;
    this.onChange = onChange;
    this.path = null;
    this.home = null;
    this.self = null;
    this.entries = [];
    this.truncated = false;
    this.loading = false;
    this.error = null;
    this.showHidden = false;
    this.seq = 0;
    this.input = InputState.new({ placeholder: "Type a path and press Enter (~ works)" });
    this.input.on("submit", (_e, cx) => this.open(this.input.value().trim() || null, cx));
  }

  // Loads a folder; a stale answer (the person clicked on) is dropped.
  open(path, cx) {
    const seq = ++this.seq;
    this.loading = true;
    this.error = null;
    cx.notify();
    return new Promise((resolve) => cx.spawn(async (cx) => {
      try {
        const out = await listDir(this.machine, path ?? "~");
        if (seq !== this.seq) return resolve(false);
        this.home = out.home;
        if (out.error) { this.error = `${out.path}: ${out.error}`; this.loading = false; cx.notify(); return resolve(false); }
        this.path = out.path;
        this.self = out.self ?? null;
        this.entries = out.entries;
        this.truncated = out.truncated;
        this.input.set_value(out.path);
        this.onChange?.(this, cx);
      } catch (e) {
        if (seq === this.seq) this.error = String(e?.message ?? e);
      }
      if (seq === this.seq) this.loading = false;
      cx.notify();
      resolve(!this.error);
    }));
  }

  up(cx) { if (this.path && this.path !== "/") this.open(parentOf(this.path), cx); }

  pinned() {
    const out = [];
    const add = (path, label, kind) => { const n = normPath(path); if (n && !out.some((p) => p.path === n)) out.push({ path: n, label, kind }); };
    if (this.home) add(this.home, "~", "home");
    for (const p of this.pinnedExtra) add(p, p.split("/").pop(), "linked");
    for (const p of loadRecent(this.machine)) add(p, p.split("/").pop() || "/", "recent");
    return out.slice(0, 12);
  }

  visible() {
    return this.entries.filter((e) => this.showHidden || !e.hidden);
  }

  tagChip(t, tag, key) {
    const strong = tag === "same-project" ? t.ansi2 : tag === "other-project" ? t.blocked : tag === "worktree" ? t.accent : t.dim;
    return div().id(key).flex_none().px(5).h(15).rounded(4).flex().items_center()
      .bg(strong + "22").text_size(9.5).font_semibold().text_color(strong).child(TAG_LABEL[tag] ?? tag);
  }

  render(t, { action = null, height = 240 } = {}) {
    const id = this.id;
    const shown = this.visible();
    const pins = this.pinned();
    const here = tagsOf(this.self, this.projectKey);
    const row = (e, n) => {
      const tags = tagsOf(e.git, this.projectKey);
      const act = action?.(e) ?? null;
      return h_flex().id(`${id}-row-${n}`).h(28).flex_none().px(8).gap(7).items_center().rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.open(e.path, cx))
        .child(svg(icon(e.git ? "branch" : "folder")).size(12).flex_none().text_color(e.git ? t.accent : t.dim))
        .child(div().flex_shrink(1).min_w(0).truncate().text_color(e.hidden ? t.muted : t.foreground).child(e.name))
        .children(tags.filter((g) => g !== "git" || tags.length === 1).map((g) => this.tagChip(t, g, `${id}-tag-${n}-${g}`)))
        .child(div().flex_1())
        .when(Boolean(act), (el) => el.child(div().id(`${id}-act-${n}`).flex_none().px(8).h(20).rounded(5).flex().items_center()
          .border_1().border_color(t.input).text_size(11).text_color(t.foreground).hover((s) => s.bg(t.raised))
          .on_click((_e, cx) => { cx.stop_propagation(); act.run(e, cx); }).child(act.label)));
    };
    return v_flex().id(id).gap(6).text_size(12)
      .child(h_flex().gap(6).items_center()
        .child(svg(icon(this.machine ? "server" : "monitor")).size(12).flex_none().text_color(t.dim))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(pcLabel(this.machine)))
        .child(Input.new(this.input).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))
        .child(div().id(`${id}-up`).flex_none().px(8).h(28).rounded(6).flex().items_center().border_1().border_color(t.input)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.up(cx)).child("Up")))
      .child(h_flex().gap(4).flex_wrap()
        .children(pins.map((p, n) => div().id(`${id}-pin-${n}`).flex_none().px(7).h(20).rounded(5).flex().items_center()
          .bg(normPath(p.path) === this.path ? t.selected : t.raised).text_size(11).text_color(p.kind === "linked" ? t.accent : t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(p.path)
          .on_click((_e, cx) => this.open(p.path, cx)).child(p.label)))
        .child(div().flex_1())
        .child(div().id(`${id}-hidden`).flex_none().px(7).h(20).rounded(5).flex().items_center().text_size(11)
          .text_color(this.showHidden ? t.foreground : t.dim).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.showHidden = !this.showHidden; cx.notify(); }).child(this.showHidden ? "Hide dot folders" : "Show dot folders")))
      .when(here.length > 0, (el) => el.child(h_flex().gap(4).items_center().text_size(11).text_color(t.dim)
        .child("This folder:").children(here.map((g) => this.tagChip(t, g, `${id}-here-${g}`)))
        .when(Boolean(this.self?.origin), (e2) => e2.child(div().min_w(0).truncate().child(this.self.origin)))))
      .child(v_flex().id(`${id}-list`).h(height).flex_none().p(4).rounded(8).border_1().border_color(t.border).bg(t.background)
        .overflow_y_scrollbar()
        .when(this.loading, (el) => el.child(div().p(8).text_color(t.dim).child("Loading…")))
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_color(t.blocked).child(this.error)))
        .when(!this.loading && !this.error && !shown.length, (el) => el.child(div().p(8).text_color(t.dim).child("No subfolders.")))
        .children(this.loading ? [] : shown.map(row))
        .when(this.truncated, (el) => el.child(div().p(6).text_size(11).text_color(t.dim).child("Only the first 500 folders are listed."))));
  }
}
