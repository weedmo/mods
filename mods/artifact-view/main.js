// Artifact view: HTML pages written by Claude / Codex, rendered beside the terminals.
// Herdr has no web view, so each page is rendered by headless Chrome (render.mjs) into
// PNG tiles that this panel stacks at its own width. It follows the newest HTML file
// found in the watched folders unless one is picked; a file that changes is re-rendered.
// Tiles live in node_modules/render: the app neither reloads the mod for files there
// nor (unlike a hidden folder) refuses to load images from it.
// Scoped to the active space only: its folder, the folders its terminals sit in, and the
// scratchpads of the Claude sessions running in it (from each terminal's labels).
// The pinned file is kept per space. Home itself is never walked: every space shares it.
// Links (http/https) opened "beside" are rendered too and listed per space.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, settings, appHome, home, spaces, terminals, layout, checking, shared } from "herdr";

const SCAN_MS = 4000, TICK_MS = 800, PAD = 6, DAYS = 14, LIMIT = 60;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const isUrl = (p) => /^https?:\/\//i.test(p ?? "");
const base = (p) => isUrl(p) ? p.replace(/^https?:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, "") : p.split("/").pop();
const shortDir = (p) => { if (isUrl(p)) return p.replace(/^(https?:\/\/[^/]+).*$/i, "$1"); const d = p.split("/").slice(0, -1).join("/"); const h = home(); return d.startsWith(h) ? "~" + d.slice(h.length) : d; };
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

export default class ArtifactView extends View {
  init(_props, cx) {
    this.dir = `${appHome()}/mods/artifact-view`;
    this.items = []; this.showList = false;
    this.space = null;      // the space id items belong to
    this.pins = {};         // space id -> picked item
    this.links = {};        // space id -> links opened there, newest first
    this.shot = null;       // { path, mtime, width, dark, tiles, height, title, truncated }
    this.error = null; this.rendering = false; this.scanning = false;
    this.width = 0; this.widthAt = 0;
    this.lastScan = 0; this.repaintUntil = 0;
    // "Show beside" requests from artifact-ask; one already there at start is old.
    this.lastReq = shared("artifact-view.open")?.id ?? null;
    if (checking()) return;
    this.tick(cx, true);
    // PNGs load off-thread and a quiet panel doesn't redraw: repaint briefly after a render.
    cx.timer.every(TICK_MS, (cx) => { this.tick(cx); if (Date.now() < this.repaintUntil) cx.notify(); });
  }

  // Skip work while this copy sits in a hidden side panel or behind another panel tab.
  visible() {
    const root = layout(), body = find(root, "panel-body");
    const mine = body?.children?.find((c) => c.content?.mod === "artifact-view");
    if (!mine) return true;
    return !find(root, "panel")?.hidden && body.active === mine.id;
  }

  get picked() { return this.pins[this.space] ?? null; }
  set picked(v) { if (v) this.pins[this.space] = v; else delete this.pins[this.space]; }

  activeSpace() { return spaces().find((s) => s.active) ?? null; }

  // What belongs to the active space: its folders and its Claude sessions.
  scope() {
    const sp = this.activeSpace();
    if (!sp) return { remote: false, folders: [], sessions: [] };
    if (sp.machine) return { remote: true, folders: [], sessions: [] };
    const h = home(), folders = new Set(), sessions = new Set();
    if (sp.folder) folders.add(sp.folder);
    for (const t of terminals()) {
      if (String(t.address ?? "").includes("/") || t.labels?.["herdr.space"] !== sp.id) continue;
      if (t.cwd) folders.add(t.cwd);
      if (t.foreground?.cwd) folders.add(t.foreground.cwd);
      try {
        const r = JSON.parse(t.labels?.["agent-resume"] ?? "null");
        if (r?.agent === "claude" && /^[0-9a-f-]{36}$/.test(r.session ?? "")) sessions.add(r.session);
      } catch {}
    }
    folders.delete(h); folders.delete(h + "/"); folders.delete("/");
    return { remote: false, folders: [...folders], sessions: [...sessions] };
  }

  roots() {
    const sc = this.scope(), r = [];
    for (const s of sc.sessions) r.push(`claude=3=/tmp/claude-*/*/${s}/scratchpad`);
    for (const f of sc.folders) r.push(`space=4=${f}`);
    // A picked file outside these folders is still watched for changes.
    if (this.picked && !isUrl(this.picked.path)) r.push(`pin=0=${this.picked.path}`);
    return r;
  }

  target() {
    if (this.picked) return this.items.find((i) => i.path === this.picked.path) ?? this.picked;
    return this.items[0] ?? null;
  }

  tick(cx, force = false) {
    const sp = this.activeSpace()?.id ?? null;
    if (sp !== this.space) {
      // Another space: drop the old list so nothing from it shows here.
      this.space = sp; this.items = []; this.error = null; this.showList = false;
      this.lastScan = 0; this.scanSeq = (this.scanSeq ?? 0) + 1; force = true; cx.notify();
    }
    const req = shared("artifact-view.open");
    if (req?.id && req.id !== this.lastReq) {
      this.lastReq = req.id;
      this.pick({ path: req.path, mtime: 0, title: "", source: "open" }, cx);
      this.lastScan = 0; force = true;
    }
    if (!force && !this.visible()) return;
    if (!this.scanning && (force || Date.now() - this.lastScan > SCAN_MS)) this.scan(cx);
    this.maybeRender(cx);
  }

  scan(cx) {
    this.scanning = true; this.lastScan = Date.now();
    const seq = this.scanSeq ?? 0, roots = this.roots();
    cx.spawn(async (cx) => {
      try {
        const r = roots.length ? await exec("python3", [`${this.dir}/scan.py`, String(DAYS), String(LIMIT), ...roots], { timeout: 15000 })
          : { code: 0, stdout: "[]" };
        if (seq !== (this.scanSeq ?? 0)) { /* the space changed meanwhile */ }
        else if (r.code === 0) this.items = JSON.parse(r.stdout || "[]");
        else this.error = r.stderr.trim().split("\n").pop();
      } catch (e) { this.error = String(e?.message ?? e); }
      this.scanning = false; this.lastScan = Date.now();
      this.maybeRender(cx); cx.notify();
    });
  }

  // on_size_change reports only changes, so a reloaded copy may not hear its width yet:
  // fall back to the side panel's size from the layout until it does.
  viewWidth() {
    if (this.width > 0) return this.width;
    const px = find(layout(), "panel")?.size?.px;
    return px ? px - 16 : 0;
  }

  maybeRender(cx, force = false) {
    const t = this.target(), w = Math.round(this.viewWidth() - 2 * PAD);
    if (!t || this.rendering || w < 120 || Date.now() - this.widthAt < 350) return;
    const dark = Boolean(settings().dark), s = this.shot;
    const stale = force || !s || s.path !== t.path || s.mtime !== t.mtime || s.dark !== dark || Math.abs(s.width - w) > 24;
    if (!stale) return;
    // Don't loop on a page that failed to render: retry only when something changes.
    const key = `${t.path}|${t.mtime}|${dark}|${w}`;
    if (!force && this.failedKey === key) return;
    this.rendering = true;
    const prefix = `${hash(t.path)}-${Date.now().toString(36)}`;
    cx.spawn(async (cx) => {
      try {
        const node = await this.node();
        const r = await exec(node, [`${this.dir}/render.mjs`, t.path, String(w), `${this.dir}/node_modules/render`, prefix, dark ? "1" : "0", "2"], { timeout: 60000 });
        const o = JSON.parse(r.stdout || "{}");
        if (o.error || r.code !== 0) { this.error = o.error ?? (r.stderr.trim() || `render failed (${r.code})`); this.failedKey = key; }
        else { this.shot = { ...o, path: t.path, mtime: t.mtime, dark }; this.error = null; this.failedKey = null; this.repaintUntil = Date.now() + 4000; }
      } catch (e) { this.error = String(e?.message ?? e); this.failedKey = key; }
      this.rendering = false; cx.notify();
    });
    cx.notify();
  }

  // Herdr's exec PATH may lack nvm's node: ask a shell, then fall back to nvm's newest.
  async node() {
    if (this.nodePath) return this.nodePath;
    const r = await exec("sh", ["-c", 'command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1']);
    const p = r.stdout.trim().split("\n").pop();
    if (!p) throw new Error("node not found (needed to drive headless Chrome)");
    return (this.nodePath = p);
  }

  pick(item, cx) {
    if (isUrl(item.path)) {
      const list = (this.links[this.space] ?? []).filter((l) => l.path !== item.path);
      item = { ...item, source: "link", mtime: 0, at: Date.now() };
      this.links[this.space] = [item, ...list].slice(0, 20);
    }
    this.picked = item; this.showList = false; this.error = null;
    this.maybeRender(cx); cx.notify();
  }

  render(cx) {
    const t = theme(), cur = this.target(), s = this.shot;
    const btn = (id, label, tip, on, onClick) => h_flex().id(id).h(22).px(7).flex_none().items_center().rounded(5)
      .text_size(11).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((st) => st.bg(t.hover)).tooltip(tip).on_click((_e, cx) => onClick(cx)).child(label);

    const header = h_flex().h(30).px(PAD).gap(4).flex_none().items_center().border_b(1).border_color(t.border)
      .child(btn("av-list", "≡", "Artifact list", this.showList, (cx) => { this.showList = !this.showList; cx.notify(); }))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground)
        .child(cur ? (s?.path === cur.path && s.title) || cur.title || base(cur.path) : "Artifacts"))
      .when(this.rendering, (el) => el.child(div().text_size(11).text_color(t.working).frames(["◐", "◓", "◑", "◒"], 140)))
      .child(btn("av-follow", this.picked ? "Pinned" : "Latest", this.picked ? "Click to follow the newest file" : "Following the newest file",
        !this.picked, (cx) => { this.picked = null; this.maybeRender(cx); cx.notify(); }))
      .child(btn("av-reload", "⟳", "Re-render", false, (cx) => { this.lastScan = 0; this.tick(cx, true); this.maybeRender(cx, true); }))
      .when(Boolean(cur), (el) => el.child(btn("av-open", "↗", "Open in Chrome", false, () => exec("sh", ["-c", '"$0" "$1" >/dev/null 2>&1 &', "google-chrome", cur.path]).catch(() => null))));

    let body;
    if (this.showList || !cur) {
      body = v_flex().id("av-items").flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(1)
        .children([...(this.links[this.space] ?? []), ...this.items].map((it, i) => {
          const on = cur?.path === it.path;
          return v_flex().id(`av-it-${i}`).px(6).py(4).rounded(5).bg(on ? t.selected : t.surface)
            .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.pick(it, cx))
            .child(h_flex().gap(6).items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(it.title || base(it.path)))
              .child(div().flex_none().text_size(10).text_color(t.dim).child(`${it.source} · ${ago(it.at ?? it.mtime)}`)))
            .child(div().truncate().text_size(10).text_color(t.muted).child(`${shortDir(it.path)}/${base(it.path)}`));
        }))
        .when(!this.items.length && !(this.links[this.space] ?? []).length, (el) => el.child(v_flex().p(10).gap(6).text_size(12).text_color(t.muted)
          .child(this.scanning ? "Scanning…" : this.scope().remote ? "This space is on another machine: its files can't be shown here."
            : "No HTML artifacts in this space from the last 14 days.")
          .child("Shows only this space: its folders and its Claude sessions' scratchpads.")
          .child("Ctrl+click a link or an .html path and pick 옆에서 보기 to show it here.")
          .child("Drop an .html file here to show it.")));
    } else {
      const w = Math.round(this.viewWidth() - 2 * PAD);
      const tiles = s?.path === cur.path ? s.tiles : [];
      const k = s ? w / s.width : 1;
      body = v_flex().id(`av-view-${s?.path ?? ""}`).flex_1().min_h(0).overflow_y_scrollbar().px(PAD).py(PAD)
        .children(tiles.map((tile) => image(`mods/artifact-view/node_modules/render/${tile.file}`).w(w).h(Math.round(tile.height * k)).flex_none()))
        .when(Boolean(s?.truncated), (el) => el.child(div().py(6).text_size(11).text_color(t.dim).child("Page cut at 30000px — open in browser for the rest.")))
        .when(!tiles.length && this.rendering, (el) => el.child(div().p(10).text_size(12).text_color(t.muted).child(`Rendering ${base(cur.path)}…`)));
    }

    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) < 1) return;
        this.width = size.width; this.widthAt = Date.now(); cx.notify();
      })
      .child(header)
      .when(Boolean(this.error), (el) => el.child(div().px(PAD).py(4).text_size(11).text_color(t.blocked).truncate().child(this.error)))
      .child(body.on_drop((event, cx) => {
        const p = event.paths.find((x) => /\.html?$/i.test(x));
        if (p) this.pick({ path: p, mtime: 0, title: "", source: "drop" }, cx);
      }))
  }
}
