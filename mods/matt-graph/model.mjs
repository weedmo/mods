export function graph(data) {
  const tickets = data.tickets || [];
  if (!Array.isArray(tickets)) throw new Error('tickets must be an array');
  const byId = new Map();
  for (const ticket of tickets) {
    if (!ticket.id || byId.has(ticket.id)) throw new Error('Missing or duplicate ticket id');
    byId.set(ticket.id, ticket);
  }
  const levels = new Map(), visiting = new Set();
  function level(id) {
    if (!byId.has(id)) throw new Error(`Unknown dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`Dependency cycle: ${id}`);
    if (levels.has(id)) return levels.get(id);
    visiting.add(id);
    const deps = byId.get(id).blockedBy || [];
    if (!Array.isArray(deps)) throw new Error(`Invalid blockedBy: ${id}`);
    const n = deps.length ? Math.max(...deps.map(level)) + 1 : 0;
    visiting.delete(id); levels.set(id, n); return n;
  }
  const columns = new Map();
  const nodes = tickets.map(t => {
    const row = level(t.id), col = columns.get(row) || 0;
    columns.set(row, col + 1);
    return {...t, x: 24 + col * 300, y: 24 + row * 180};
  });
  const positions = new Map(nodes.map(n => [n.id, n]));
  return {nodes, edges: nodes.flatMap(n => (n.blockedBy || []).map(id => ({from: positions.get(id), to:n}))),
    width: Math.max(600, ...nodes.map(n => n.x + 270)), height: Math.max(200, ...nodes.map(n => n.y + 130))};
}
