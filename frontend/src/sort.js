// Client-side sort over the loaded incident rows. A pure, stable sort on a copy.
// ponytail: server-side sort only if lists outgrow the 500-row cap (the keyset cursor is tied to priority/created_at).
const RANK = {
  priority: { P0: 0, P1: 1, P2: 2, P3: 3 },
  status: { OPEN: 0, INVESTIGATING: 1, RESOLVED: 2, CLOSED: 3 },
};
const FINISHED = ['RESOLVED', 'CLOSED'];

// The list's view state. App owns it (IncidentList unmounts on a tab switch), so filters and sort survive.
export const DEFAULT_VIEW = { status: 'ACTIVE', priority: '', mine: false, search: '', sort: { key: 'priority', dir: 'asc' } };

// Each key returns a comparable value, or null to mean "always last" (in both directions).
const KEYS = {
  priority: i => RANK.priority[i.priority] ?? 9,
  component: i => i.component,
  status: i => RANK.status[i.status] ?? 9,
  sla: i => (i.sla_deadline && !FINISHED.includes(i.status) ? new Date(i.sla_deadline).getTime() : null),
  assignee: i => i.assignee_username || null,
  age: i => -new Date(i.created_at).getTime(),  // newest first when ascending
};

// Within a priority the earliest deadline (the most overdue) comes first, in either direction; rows with no
// deadline or already finished go after them, then keep their order.
// ponytail: the server page order is priority then newest, and the list is capped at 500 rows, so this only
// orders the loaded rows (the same ceiling as the rest of the client sort).
const TIEBREAK = { priority: KEYS.sla };

export function sortIncidents(items, key, dir = 'asc') {
  const val = KEYS[key], tie = TIEBREAK[key];
  const sign = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === null || y === null) return (x === null) - (y === null);
    const c = (typeof x === 'string' ? x.localeCompare(y) : x - y) * sign;
    if (c || !tie) return c;
    const p = tie(a), q = tie(b);
    return p === null || q === null ? (p === null) - (q === null) : p - q;
  });
}
