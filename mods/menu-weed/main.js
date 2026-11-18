// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, focused, setShared, hc, home } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// File paths printed in a terminal's recent text that exist on disk, newest first.
const MAX_PATHS = 6;
async function recentPaths(terminal, cwd) {
  const r = await hc(["read", "--lines", "400", terminal]);
  if (r.code !== 0) return [];
  const on = terminal.includes("/") ? terminal.split("/")[0] : null;
  const seen = new Set(), found = [];
  // Absolute (/x/y), home (~/x) or relative (a/b.ext, ./x, ../x) paths, with backticks, quotes and :line stripped.
  const re = /(?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\/?[\w.@+-]*/g;
  const lines = r.stdout.split("\n").reverse();
  for (const line of lines) {
    const hits = [...line.matchAll(re)].map((m) => m[0].replace(/[.,:;]+$/, "")).filter((x) => x.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(x)).reverse();
    for (let raw of hits) {
      raw = raw.replace(/[.,:;]+$/, "");
      if (raw.length < 3 || /^https?:/.test(raw) || seen.has(raw)) continue;
      seen.add(raw);
      const abs = raw.startsWith("~/") ? home() + raw.slice(1) : raw.startsWith("/") ? raw : cwd ? `${cwd}/${raw}` : null;
      if (abs) found.push({ raw, abs });
    }
    if (found.length > 200) break;
  }
  if (!found.length) return [];
  // Keep only regular files, checked in one shell call.
  const check = await exec("sh", ["-c", 'for p; do [ -f "$p" ] && printf "%s\\0" "$p"; done; true', "check", ...found.map((f) => f.abs)], { on }).catch(() => null);
  const files = new Set((check?.stdout ?? "").split("\0").filter(Boolean));
  const out = [], abs = new Set();
  for (const f of found) {
    const real = f.abs.replace(/\/\.\//g, "/");
    if (!files.has(f.abs) || abs.has(real)) continue;
    abs.add(real);
    out.push({ ...f, abs: real });
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

const short = (p) => (p.length > 38 ? "…" + p.slice(-37) : p);

function items(p, git, paths) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      return [
        ...(paths ?? []).map((f) => [`Open ${short(f.raw)}`, "openfile", { path: f.abs }]),
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(panes().filter((x) => x.tab === panes().find((y) => y.pane === tg.pane)?.tab).length > 1 && term
          ? [["Move to new tab", "tabmove", { terminal: term.address, place: "tab" }]]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ["Close pane", "pane.close", { pane: tg.pane }],
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        // Orca's "Move Tab to Split": this tab's terminal joins the shown tab, beside the focused pane.
        ...(focused()?.tab !== tg.id
          ? [["Move to split: right", "tabmove", { tab: tg.id, place: "right" }],
             ["Move to split: left", "tabmove", { tab: tg.id, place: "left" }],
             ["Move to split: down", "tabmove", { tab: tg.id, place: "down" }],
             ["Move to split: up", "tabmove", { tab: tg.id, place: "up" }]]
          : []),
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" || command === "tabmove" ? "panel-right" : command === "pane.zoom" ? "square" : command === "openfile" ? "file-text" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  if (name === "tabmove") {
    const k = keys().find((b) => b.section === "global" && b.action === (args.place === "tab" ? "tabs-weed.detach" : `tabs-weed.pull-${args.place}`));
    return k && args.place === "tab" ? k.keys : "";
  }
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    this.paths = [];
    if (p?.tab === "pane" && p.target?.terminal) {
      const cwd = panes().find((x) => x.pane === p.target.pane)?.cwd || focused()?.cwd || null;
      cx.spawn(async (cx) => {
        this.paths = await recentPaths(p.target.terminal, cwd).catch(() => []);
        cx.notify();
      });
    }
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  choose(i, cx) {
    const it = items(props(), this.git, this.paths)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else if (it[1] === "openfile") {
      run("layout.show", { id: "panel" });
      run("layout.select", { stack: "panel-body", child: "files" });
      setShared("files.open", { id: `${Date.now()}-${Math.random()}`, at: Date.now(), path: it[2].path });
    }
    else if (it[1] === "tabmove") setShared("tabs-weed.drop", { id: `${Date.now()}-${Math.random()}`, tab: null, terminal: null, ...it[2] });
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git, this.paths);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || (it[1] !== "openfile" && list[i - 1][1] === "openfile") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
