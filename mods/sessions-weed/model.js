export function visibleSessions(rows, { archived = false, query = "", agent = "all" } = {}) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return rows.filter(row => Boolean(row.archived_at) === archived && (agent === "all" || row.agent === agent)
    && terms.every(term => [row.title, row.cwd, row.session, row.agent, row.host || "This PC"].join(" ").toLowerCase().includes(term)));
}

export function pageRows(rows, page, size = 40) {
  const count = Math.max(1, Math.ceil(rows.length / size));
  const index = Math.min(Math.max(0, page), count - 1);
  return { rows: rows.slice(index * size, (index + 1) * size), page: index, count };
}

const localId = id => id?.split('/').at(-1);
const pathKey = path => (path || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
const within = (path, root) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

// Recorded membership is authoritative. Older imported conversations fall back to
// the closest folder on the same machine, so a home space doesn't absorb a project.
export function sessionsInSpace(rows, space, allSpaces = [], allPanes = []) {
  if (!space) return [];
  const host = space.machine || '';
  const roots = candidate => {
    const tabs = new Set((candidate.tabs || []).map(tab => tab.id));
    return [...new Set([candidate.folder, ...allPanes.filter(pane => tabs.has(pane.tab)).map(pane => pane.cwd)]
      .filter(Boolean).map(pathKey))];
  };
  const candidates = allSpaces.filter(candidate => (candidate.machine || '') === host)
    .map(candidate => ({ id: candidate.id, roots: roots(candidate) }));
  if (!candidates.some(candidate => candidate.id === space.id)) candidates.push({ id: space.id, roots: roots(space) });
  const liveTabs = new Set((space.tabs || []).map(tab => tab.id));
  const liveTerminals = new Set(allPanes.filter(pane => liveTabs.has(pane.tab)).map(pane => pane.terminal).filter(Boolean));
  return rows.filter(row => {
    if ((row.host || '') !== host) return false;
    if (row.live_terminal && liveTerminals.has(row.live_terminal)) return true;
    if (row.space_ids?.length) return row.space_ids.includes(localId(space.id));
    const cwd = pathKey(row.cwd);
    if (!row.cwd) return false;
    const matching = candidates.flatMap(candidate => candidate.roots.filter(root => within(cwd, root))
      .map(root => ({ id: candidate.id, length: root.length })));
    const longest = Math.max(-1, ...matching.map(match => match.length));
    return matching.some(match => match.id === space.id && match.length === longest);
  });
}
