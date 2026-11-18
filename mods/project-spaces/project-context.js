// A space owns the navigation. Project catalogs only annotate it.
export function contextForSpace(space, paneList, catalogs) {
  if (!space) return null;
  const normalize = p => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const machine = space.machine ?? null;
  const id = machine ? space.id.slice(machine.length + 1) : space.id;
  const tabs = new Set((space.tabs ?? []).map(t => t.id));
  const pane = paneList.find(p => p.terminal && tabs.has(p.tab) && p.cwd);
  const cwd = normalize(pane?.cwd || space.folder);
  const entries = Object.values(catalogs ?? {}).filter(c => (c.machine ?? null) === machine);
  const contexts = [];
  for (const catalog of entries) {
    const works = catalog.works ?? [];
    for (const location of catalog.locations ?? []) {
      const owned = works.filter(w => w.locationId === location.id);
      const bound = owned.filter(w => w.spaceId === id);
      if (bound.length > 1) return null;
      const trees = [...(location.checkouts ?? []), { path: location.path }];
      const matches = trees.filter(c => {
        const path = normalize(c.path);
        return path && cwd && (cwd === path || cwd.startsWith(path + "/"));
      }).sort((a, b) => normalize(b.path).length - normalize(a.path).length);
      const tree = matches[0];
      if (!bound.length && !tree) continue;
      const work = bound[0] ?? owned.find(w => normalize(w.path) === normalize(tree?.path));
      contexts.push({ projectId: location.projectId, name: location.name, location, work, machine,
        branch: pane?.branch ?? space.branch ?? tree?.branch ?? work?.branch ?? null,
        bound: bound.length === 1, depth: normalize(tree?.path).length });
    }
  }
  const bound = contexts.filter(c => c.bound);
  if (bound.length) return bound.length === 1 ? bound[0] : null;
  contexts.sort((a, b) => b.depth - a.depth);
  return contexts.length > 1 && contexts[0].depth === contexts[1].depth ? null : contexts[0] ?? null;
}
