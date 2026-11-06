// Workflow graph: Claude Code workflow runs, matt-auto runs and autocode runs
// drawn the way git-graph draws history. Phases (workflow phases, matt-auto
// stages/waves/review/PR, autocode experiments/frontier) are merge points and
// their items sit on lanes; a running item's line is dashed and its dot pulses.
// Shows only the active space: runs on its machine started in its folders (or their repos).
// Follows the newest live run unless a run is picked from the list.
import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, readTextFile, theme, settings, appHome, spaces, panes } from "herdr";
import { buildGraph } from "./model.js";

const ROW = 24, LANE = 12, PAD = 8, DETAILS_H = 200;
const LIVE_MS = 2000, IDLE_MS = 15000;
const laneColors = (t) => [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi10, t.ansi13, t.ansi11, t.ansi14, t.ansi9];

const pad2 = (n) => String(n).padStart(2, "0");
function dur(ms) {
  if (ms == null || !isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`;
}
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const kilo = (n) => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
// Run keys carry their machine: "<machine>|<reader key>", "" for this one.
const joinKey = (m, k) => `${m}|${k}`;
const splitKey = (k) => { const i = k.indexOf("|"); return [k.slice(0, i), k.slice(i + 1)]; };
const SOURCE = { workflow: "WF", matt: "matt", autocode: "auto" };
const stateColor = (t, s) => (s === "running" ? t.working : s === "failed" || s === "error" || s === "blocked" ? t.blocked : s === "stopped" ? t.unknown : s === "queued" ? t.dim : t.done);

export default class WorkflowGraph extends View {
  init(_props, cx) {
    this.listId = `wf-rows-${Math.random().toString(36).slice(2)}`;
    this.runs = []; this.run = null; this.graph = null; this.error = null;
    this.pinned = null; this.picking = false; this.selected = null; this.sig = null;
    this.per = new Map(); // machine ("" = this one) -> { out, error, busy, at }
    this.code = null; this.scope = null;
    this.refresh(cx);
    cx.timer.every(LIVE_MS, (cx) => this.refresh(cx));
  }

  get busy() { return [...this.per.values()].some((m) => m.busy); }

  // The reader as one `python3 -c` program, so it runs on remote machines too.
  async program() {
    if (this.code) return this.code;
    const dir = `${appHome()}/mods/workflow-graph`;
    const [reader, loops] = await Promise.all([readTextFile(`${dir}/reader.py`), readTextFile(`${dir}/loops.py`)]);
    if (!reader || !loops) throw new Error("reader.py / loops.py missing");
    this.code = ["import sys, types", "sys.dont_write_bytecode = True", "L = types.ModuleType('loops')",
      `exec(${JSON.stringify(loops)}, L.__dict__)`, "sys.modules['loops'] = L",
      `exec(${JSON.stringify(reader)}, {'__name__': '__main__'})`].join("\n");
    return this.code;
  }

  // The active space: its machine, and its folder plus its panes' folders. Only runs started
  // in those folders (or their repositories) are shown.
  targets() {
    const sp = spaces().find((s) => s.active);
    if (!sp) return new Map();
    const tabs = new Set(sp.tabs.map((tab) => tab.id));
    const folders = new Set([sp.folder, ...panes().filter((p) => tabs.has(p.tab)).map((p) => p.cwd)].filter(Boolean));
    return new Map([[sp.machine ?? "", folders]]);
  }

  // Each machine is read on its own: a slow or unreachable one never holds the others back.
  refresh(cx, force = false) {
    const targets = this.targets(), scope = JSON.stringify([...targets].map(([m, f]) => [m, [...f].sort()]));
    if (scope !== this.scope) {
      this.scope = scope; this.per = new Map(); this.pinned = null; this.selected = null; this.sig = null; this.picking = false;
      this.runs = []; this.run = null; this.graph = null; force = true;
    }
    const [pm, pk] = this.pinned ? splitKey(this.pinned) : [null, null];
    const shownLive = this.run && (this.run.status === "running" || this.run.status === "blocked");
    for (const [m, folders] of targets) {
      const st = this.per.get(m) ?? { out: null, error: null, busy: false, at: 0 };
      this.per.set(m, st);
      const due = force || Date.now() - st.at > IDLE_MS || (shownLive && this.run.machine === m);
      if (st.busy || !due) continue;
      st.busy = true;
      const mine = this.scope;
      cx.spawn(async (cx) => {
        try {
          const args = ["-B", "-c", await this.program(), "--filter", "--pick", pm === m ? pk : "", ...folders];
          const r = await exec("python3", args, { on: m || null });
          if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "reader failed");
          st.out = JSON.parse(r.stdout); st.error = null;
        } catch (e) { st.error = String(e?.message ?? e); }
        finally { st.busy = false; st.at = Date.now(); if (mine === this.scope) this.merge(); cx.notify(); }
      });
    }
    cx.notify();
  }

  merge() {
    const tag = (m, x) => x && { ...x, machine: m || null, key: joinKey(m, x.key) };
    const all = [...this.per.entries()].filter(([, st]) => st.out);
    this.runs = all.flatMap(([m, st]) => (st.out.runs ?? []).map((x) => tag(m, x))).sort((a, b) => b.mtime - a.mtime);
    const local = this.per.get("");
    this.error = local?.error ?? null;
    // Pinned: that run. Otherwise the newest live run of any machine, else the newest run.
    const picks = all.map(([m, st]) => tag(m, st.out.run)).filter(Boolean);
    const isLive = (x) => x.status === "running" || x.status === "blocked";
    let run = this.pinned ? picks.find((x) => x.key === this.pinned) : null;
    if (this.pinned && !run) run = this.run?.key === this.pinned ? this.run : null;
    if (!this.pinned) {
      const order = (a, b) => (isLive(b) - isLive(a)) || (b.mtime - a.mtime);
      run = picks.sort(order)[0] ?? null;
    }
    // Rebuild the lanes only when something moved: a quiet poll keeps the table as is.
    const sig = JSON.stringify(run && [run.key, run.status, run.current, run.agentList.map((a) => [a.id, a.state, a.end, a.sub])]);
    if (sig !== this.sig) {
      this.sig = sig; this.run = run;
      this.graph = run ? buildGraph(run) : null;
      if (this.selected && !this.graph?.nodes.some((n) => n.hash === this.selected)) this.selected = null;
    } else this.run = run;
  }

  pick(key, cx) {
    this.pinned = key; this.picking = false; this.selected = null; this.sig = null;
    this.refresh(cx, true); cx.notify();
  }

  // ---- drawing

  graphCell(row, node, colors, t, width) {
    const x = (lane) => PAD + lane * LANE + LANE / 2, y = (v) => v * ROW, paths = new Map();
    for (const [a, ya, b, yb, c, dashed] of row.segments) {
      const color = dashed ? t.dim : colors[c % colors.length], key = `${color}${dashed ? "-" : ""}`;
      let p = paths.get(key)?.p ?? (dashed ? PathBuilder.stroke(1.5).dash_array([3, 3]) : PathBuilder.stroke(1.5));
      p = p.move_to(x(a), y(ya));
      if (a === b) p = p.line_to(x(b), y(yb));
      else { const mid = (y(ya) + y(yb)) / 2; p = p.cubic_bezier_to(x(b), y(yb), x(a), mid, x(b), mid); }
      paths.set(key, { p, color });
    }
    const lane = colors[row.lane % colors.length];
    const big = node.kind !== "agent", r = big ? 5 : 4;
    let dot = div().absolute().left(x(row.lane) - r).top(ROW / 2 - r).size(r * 2).rounded(r);
    if (big) dot = dot.bg(t.background).border(2).border_color(node.kind === "phase" ? (node.pending ? t.dim : lane) : t.foreground);
    else {
      const s = node.agent.state;
      dot = dot.bg(s === "done" ? lane : stateColor(t, s));
      if (s === "running") dot = dot.loop("opacity", { from: 0.3, to: 1, period: 1100 });
    }
    return div().relative().flex_none().w(width).h(ROW).overflow_hidden()
      .children([...paths.values()].map(({ p, color }) => window.paint_path(p.build(), color).absolute().top(0).left(0).size_full()))
      .child(dot);
  }

  row(i, t, colors, width, mono) {
    const node = this.graph.nodes[i], row = this.graph.rows[i];
    const base = h_flex().id(`wf-${node.hash}`).w_full().h(ROW).flex_none().pr(10).gap(8).items_center().overflow_hidden()
      .when(this.selected === node.hash, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(this.graphCell(row, node, colors, t, width));
    const cell = (w, text, color) => div().w(w).flex_none().text_right().truncate().text_color(color ?? t.dim).font_family(mono).text_size(11).child(text);
    if (node.kind === "agent") {
      const a = node.agent, end = a.end ?? (a.state === "running" ? Date.now() : null);
      return base
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden()
          .when(Boolean(a.tag), (e) => e.child(div().flex_none().px(5).rounded(4).bg(colors[row.lane % colors.length] + "26").text_size(10.5).text_color(t.muted).child(a.tag)))
          .child(div().flex_1().min_w(0).truncate().text_color(a.state === "done" ? t.foreground : stateColor(t, a.state)).child(a.label)))
        .child(cell(54, a.stateText ?? (a.state === "done" ? "" : a.state), stateColor(t, a.state)))
        .child(cell(50, a.start && end ? dur(end - a.start) : ""))
        .child(cell(48, a.sub ?? ""));
    }
    if (node.kind === "phase") {
      const tag = node.pending ? "pending" : node.running ? `${node.done}/${node.count} · ${node.running} running` : `${node.count} agent${node.count === 1 ? "" : "s"}`;
      return base.child(div().flex_1().min_w(0).truncate().font_semibold().text_color(node.pending ? t.dim : t.foreground).child(node.title))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(tag));
    }
    const label = node.kind === "start" ? `▶ ${node.title}` : `■ ${node.title}`;
    return base.child(div().flex_1().min_w(0).truncate().text_color(t.muted).text_size(11.5).child(label));
  }

  header(t) {
    const run = this.run;
    const statusPill = run ? div().flex_none().px(6).rounded(4).text_size(10.5).text_color(stateColor(t, run.status === "completed" ? "done" : run.status))
      .bg(stateColor(t, run.status === "completed" ? "done" : run.status) + "22").child(run.status) : null;
    const ag = run?.agentList ?? [], done = ag.filter((a) => a.state === "done").length;
    const elapsed = run ? (run.durationMs ?? (run.start ? Date.now() - run.start : null)) : null;
    const stats = !run ? "" : run.source === "workflow"
      ? [`${done}/${ag.length} agents`, dur(elapsed), run.totalTokens ? `${kilo(run.totalTokens)} tok` : ""].filter(Boolean).join(" · ")
      : [run.stats, run.live ? dur(elapsed) : ""].filter(Boolean).join(" · ");
    return h_flex().h(34).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .when(Boolean(run), (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(SOURCE[run.source] ?? run.source)))
      .child(h_flex().id("wf-pick").min_w(0).gap(4).items_center().px(6).py(2).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.picking = !this.picking; cx.notify(); })
        .child(div().min_w(0).truncate().font_semibold().child(run?.name ?? "Workflow graph"))
        .child(div().text_color(t.dim).text_size(10).child(this.picking ? "▴" : "▾")))
      .when(Boolean(statusPill), (e) => e.child(statusPill))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(stats))
      .when(Boolean(this.pinned), (e) => e.child(div().id("wf-follow").px(6).rounded(4).text_size(11).text_color(t.accent).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(null, cx)).child("follow latest")))
      .child(div().id("wf-refresh").px(6).rounded(4).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.sig = null; this.refresh(cx, true); }).child(this.busy ? "…" : "↻"));
  }

  runList(t) {
    return v_flex().flex_none().max_h(260).overflow_y_scrollbar().border_b(1).border_color(t.border).bg(t.raised).py(4)
      .children(this.runs.map((r) => {
        const st = r.status === "completed" ? "done" : r.status;
        return h_flex().id(`wf-run-${r.key}`).px(12).py(3).gap(8).items_center().cursor_pointer()
          .when(r.key === this.run?.key, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pick(r.key, cx))
          .child(div().flex_none().size(7).rounded(4).bg(stateColor(t, st)))
          .child(div().flex_none().w(30).text_size(10).text_color(t.dim).child(SOURCE[r.source] ?? r.source))
          .child(div().flex_none().max_w(220).truncate().font_semibold().child(r.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${r.machine ? `${r.machine}:` : ""}~/${r.source === "workflow" ? r.project.replace(/^home\/[^/]+\/?/, "") : r.project}`))
          .child(div().flex_none().text_size(11).text_color(t.muted).child(`${r.agents ?? 0} · ${ago(r.mtime)}`));
      }));
  }

  details(t, mono) {
    const node = this.graph?.nodes.find((n) => n.hash === this.selected);
    if (!node || node.kind !== "agent") return null;
    const a = node.agent, end = a.end ?? (a.state === "running" ? Date.now() : null);
    const facts = [a.stateText ?? a.state, a.start && end ? dur(end - a.start) : null, ...(a.facts ?? [])].filter(Boolean).join(" · ");
    const block = (title, text) => !text ? null : v_flex().gap(2)
      .child(div().text_size(10.5).text_color(t.dim).child(title))
      .child(div().font_family(mono).text_size(11).text_color(t.muted).child(text));
    return v_flex().id("wf-details").h(DETAILS_H).flex_none().border_t(1).border_color(t.border).bg(t.raised).p(10).gap(6).overflow_y_scrollbar()
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(a.tag ? `${a.tag} · ${a.label}` : a.label))
        .child(div().id("wf-details-close").px(6).rounded(4).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.selected = null; cx.notify(); }).child("✕")))
      .child(div().text_size(11).text_color(stateColor(t, a.state)).child(facts))
      .children((a.blocks ?? []).map(([title, text]) => block(title, text)).filter(Boolean));
  }

  render(cx) {
    const t = theme(), mono = settings()?.font_family ?? "monospace";
    const root = v_flex().size_full().bg(t.surface).text_color(t.foreground).text_size(12.5).child(this.header(t));
    if (this.picking) root.child(this.runList(t));
    if (this.run?.current) root.child(div().flex_none().px(12).py(4).border_b(1).border_color(t.border).text_size(11).text_color(t.muted).truncate().child(this.run.current));
    if (this.error) root.child(div().px(12).py(6).text_size(11).text_color(t.blocked).child(this.error));
    if (!this.graph) {
      return root.child(div().flex_1().flex().items_center().justify_center().text_color(t.muted)
        .child(this.busy && !this.runs.length ? "Reading workflow runs…" : "No runs in this space · workflow, matt-auto, autocode"));
    }
    const colors = laneColors(t), width = PAD * 2 + this.graph.width * LANE, n = this.graph.nodes.length;
    root.child(div().flex_1().min_h(0).relative()
      .child(v_virtual_list(this.listId, n, ROW, (i) => this.graph.nodes[i].hash,
        (range) => Array.from({ length: range.end - range.start }, (_x, k) => this.row(range.start + k, t, colors, width, mono)))
        .on_item_click((key, cx) => { this.selected = this.selected === key ? null : key; cx.notify(); })
        .size_full())
      .child(Scrollbar.vertical(this.listId).viewport_from_layout().absolute().inset_0()));
    const d = this.details(t, mono);
    if (d) root.child(d);
    return root;
  }
}
