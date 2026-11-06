// Turns a normalized run (workflow, matt-auto or autocode; see loops.py) into
// git-graph "commits" and lays them out on lanes.
//
// start ─▶ phase ─▶ items on lanes ─▶ next phase (merge) ─▶ … ─▶ end
//
// A phase's mode says how its items take lanes:
//   time        first lane whose previous item had ended when this one started
//               (lanes = real concurrency, not one lane per item)
//   parallel    every item forks from the phase on a lane of its own
//   sequential  items chain on one lane
// layoutLanes wants newest first; the table reads top-down in time, so the
// layout is built on the reversed list and flipped back.
import { layoutLanes } from "./lanes.js";

export function buildGraph(run) {
  const items = run.agentList ?? [];
  const phases = (run.phases ?? []).map((p) => (typeof p === "string" ? { title: p, mode: "time" } : p));
  for (const a of items) if (!phases.some((p) => p.title === a.phase)) phases.push({ title: a.phase, mode: "time" });
  const live = run.live ?? run.status === "running";

  const nodes = [{ hash: "start", parents: [], kind: "start", title: run.name }];
  let tails = ["start"];
  phases.forEach((phase, i) => {
    const list = items.filter((a) => a.phase === phase.title);
    // A planned phase not reached yet shows only while the run is going.
    if (!list.length && !live) return;
    const ph = `phase:${i}`;
    nodes.push({ hash: ph, parents: tails, kind: "phase", title: phase.title || "(no phase)", count: list.length, pending: !list.length,
      done: list.filter((a) => a.state === "done").length, running: list.filter((a) => a.state === "running").length });
    let slots = []; // { end, hash }
    for (const a of list) {
      let parent;
      if (phase.mode === "parallel") { parent = ph; slots.push({ hash: a.id }); }
      else if (phase.mode === "sequential") { parent = slots[0]?.hash ?? ph; slots = [{ hash: a.id }]; }
      else {
        const start = a.start ?? Infinity, end = a.end ?? Infinity;
        const s = slots.findIndex((x) => x.end <= start);
        parent = s < 0 ? ph : slots[s].hash;
        if (s < 0) slots.push({ end, hash: a.id }); else slots[s] = { end, hash: a.id };
      }
      nodes.push({ hash: a.id, parents: [parent], kind: "agent", agent: a, dashed: a.state === "running" || a.state === "queued" });
    }
    tails = slots.length ? slots.map((x) => x.hash) : [ph];
  });
  if (!live) nodes.push({ hash: "end", parents: tails, kind: "end", title: run.status });

  const { rows, width } = layoutLanes(nodes.slice().reverse());
  const flipped = rows.reverse().map((r) => ({ lane: r.lane,
    segments: r.segments.map(([a, ya, b, yb, c, d]) => [b, 1 - yb, a, 1 - ya, c, d]) }));
  return { nodes, rows: flipped, width };
}
