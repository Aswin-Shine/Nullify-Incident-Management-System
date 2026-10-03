import { useState, useEffect, useRef, useMemo } from 'react';
import { shortAge } from '../format';
import { sortIncidents } from '../sort';
import { fetchWorkItems, errorMessage } from '../api/client';
import { useQuery } from '../hooks/useQuery';
import { useNow } from '../hooks/useNow';
import { PriorityBadge, StatusBadge } from './Badges';
import { ErrorNote } from './ErrorNote';
import { Icon } from './Icon';

const FILTERS = ['ALL', 'OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const COLUMNS = [
  { key: 'priority', label: 'Priority', text: 'Pri' },
  { key: 'component', label: 'Component', text: 'Component' },
  { key: 'status', label: 'Status', text: 'Status' },
  { key: 'sla', label: 'SLA', text: 'SLA' },
  { key: 'assignee', label: 'Assignee', text: 'Assignee' },
  { key: 'age', label: 'Age', text: 'Age' },
];
const DEFAULT_SORT = { key: 'priority', dir: 'asc' };  // equals the server order
const DEBOUNCE_MS = 300;
const PAGE = 100;
const MAX_LIMIT = 500;  // ponytail: past this, narrow with the status pills; API clients can walk next_cursor

// "Critical" means a P0 someone still has to act on.
const isCritical = i => i.priority === 'P0' && ['OPEN', 'INVESTIGATING'].includes(i.status);

export function IncidentList({ onSelect, selectedId, refreshTick }) {
  const [filter, setFilter] = useState('ALL');
  const [limit, setLimit] = useState(PAGE);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');  // the debounced search that actually queries
  const [priority, setPriority] = useState('');
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState(DEFAULT_SORT);

  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setLimit(PAGE); }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Keyed by the filters only, so asking for more rows keeps the current ones on screen while it loads.
  const { data, error, loading } = useQuery(
    `${filter}|${q}|${priority}|${mine}`,
    () => fetchWorkItems({
      status: filter === 'ALL' ? undefined : filter, limit,
      q: q || undefined, priority: priority || undefined, assignee: mine ? 'me' : undefined,
    }),
    `${refreshTick}:${limit}`);
  const filtered = filter !== 'ALL' || q || priority || mine;
  // Sorting is client-side over the loaded rows, and j/k follow what is on screen.
  const incidents = useMemo(() => sortIncidents(data?.items ?? [], sort.key, sort.dir), [data, sort]);
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const clickSort = (key) => setSort(s => s.key !== key ? { key, dir: 'asc' } : { key, dir: s.dir === 'asc' ? 'desc' : 'asc' });

  const p0Count = incidents.filter(isCritical).length;

  // j / k move through the rows, / jumps to search. Skipped while typing and when a modifier is held.
  const searchRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key !== 'j' && e.key !== 'k') return;
      const rows = incidents;
      const at = rows.findIndex(i => i.id === selectedId);
      const next = rows[e.key === 'j' ? at + 1 : at - 1];
      if (!next) return;
      onSelect(next.id);
      document.querySelector(`[data-incident-id="${next.id}"]`)?.scrollIntoView?.({ block: 'nearest' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [incidents, selectedId, onSelect]);

  return (
    <div className="panel incident-list">
      <div className="list-head">
        <h2>Incidents</h2>
        <div className="list-head-right">
          {loading && <span className="spinner spinner-sm" />}
          {p0Count > 0 && <div className="critical-count">{p0Count} critical</div>}
        </div>
      </div>

      <div className="list-toolbar">
        <div className="pills">
          <div className="seg">
            {FILTERS.map(f => (
              <button type="button" key={f} className="pill" aria-pressed={filter === f} onClick={() => { setFilter(f); setLimit(PAGE); }}>
                {f}
              </button>
            ))}
          </div>
          <button type="button" className="pill" aria-pressed={mine} onClick={() => { setMine(m => !m); setLimit(PAGE); }}>
            Assigned to me
          </button>
        </div>

        <div className="filter-row">
          <span className="search">
            <Icon name="search" />
            <input ref={searchRef} type="search" name="q" aria-label="Search components" aria-keyshortcuts="/" placeholder="Search components" maxLength={64}
              value={search} onChange={e => setSearch(e.target.value)} />
            <kbd className="kbd" aria-hidden="true">/</kbd>
          </span>
          <select name="priority" aria-label="Priority" value={priority}
            onChange={e => { setPriority(e.target.value); setLimit(PAGE); }}>
            <option value="">All priorities</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      <div className="row-grid sort-head" role="group" aria-label="Sort incidents">
        {COLUMNS.map(c => {
          const active = sort.key === c.key;
          return (
            // aria-description is valid ARIA 1.3 on any role; the lint plugin's table predates it
            // eslint-disable-next-line jsx-a11y/role-supports-aria-props
            <button type="button" key={c.key} className="sort-btn" data-col={c.key} aria-label={`Sort by ${c.label}`}
              aria-pressed={active}
              aria-description={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              onClick={() => clickSort(c.key)}>
              {c.text}
              {active && <Icon name={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} />}
            </button>
          );
        })}
      </div>
      {data?.next_cursor && !isDefaultSort && (
        <div className="list-hint">Sorted within the {incidents.length} loaded incidents</div>
      )}

      <div className="list-body">
        {error && <ErrorNote>{errorMessage(error, 'Could not load incidents')}</ErrorNote>}
        {!loading && incidents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-mark"><Icon name="null" size={32} /></div>
            <div className="empty-title">No incidents</div>
            <div className="empty-sub">{filtered ? 'No incidents match these filters.' : 'All quiet, systems nominal.'}</div>
          </div>
        ) : incidents.map(incident => (
          <button type="button" key={incident.id} className="btn-bare incident-row row-grid" data-incident-id={incident.id}
            data-selected={incident.id === selectedId}
            data-p0={isCritical(incident)}
            onClick={() => onSelect(incident.id)}>
            <span className="cell" data-col="priority"><PriorityBadge priority={incident.priority} short /></span>
            <span className="cell cell-comp" data-col="component">
              <span className="row-component">{incident.component}</span>
              <span className="row-title">{incident.title || '-'}</span>
            </span>
            <span className="cell" data-col="status"><StatusBadge status={incident.status} /></span>
            <span className="cell" data-col="sla">
              {incident.sla_deadline && !['RESOLVED', 'CLOSED'].includes(incident.status) && (
                <SlaTimer deadline={incident.sla_deadline} />
              )}
            </span>
            <span className="cell row-assignee" data-col="assignee">
              {incident.assignee_username ? (
                <>
                  <span className="avatar avatar-sm" aria-hidden="true">{incident.assignee_username[0].toUpperCase()}</span>
                  <span className="row-assignee-name">{incident.assignee_username}</span>
                </>
              ) : 'Unassigned'}
            </span>
            <span className="cell row-age" data-col="age">{shortAge(incident.created_at)}</span>
          </button>
        ))}
        {data?.next_cursor && limit < MAX_LIMIT && (
          <button type="button" className="pill load-more" onClick={() => setLimit(l => Math.min(l + PAGE, MAX_LIMIT))}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

function SlaTimer({ deadline }) {
  const now = useNow();
  const diff = new Date(deadline) - now;
  if (diff <= 0) return <span className="sla-timer breached" data-level="p0">BREACHED</span>;
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
  const level = diff < 300000 ? 'p0' : diff < 1800000 ? 'p2' : 'p3';
  return <span className="sla-timer" data-level={level}>{h > 0 ? `${h}h ` : ''}{m}m {s}s</span>;
}
