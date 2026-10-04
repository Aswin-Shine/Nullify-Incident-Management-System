import { useState, useEffect, useRef, useMemo } from 'react';
import { shortAge, breachAge, breachAgeWords, breachLevel, plural, rcaDue } from '../format';
import { sortIncidents } from '../sort';
import { fetchWorkItems, errorMessage } from '../api/client';
import { useQuery } from '../hooks/useQuery';
import { useNow } from '../hooks/useNow';
import { PriorityBadge, StatusBadge } from './Badges';
import { ErrorNote } from './ErrorNote';
import { Icon } from './Icon';

const FILTERS = ['ACTIVE', 'RESOLVED', 'CLOSED', 'ALL'];  // ACTIVE is OPEN or INVESTIGATING (the server knows it)
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const COLUMNS = [
  { key: 'priority', label: 'Priority', text: 'Pri' },
  { key: 'component', label: 'Component', text: 'Component' },
  { key: 'status', label: 'Status', text: 'Status' },
  { key: 'sla', label: 'SLA', text: 'SLA' },
  { key: 'assignee', label: 'Assignee', text: 'Assignee' },
  { key: 'age', label: 'Age', text: 'Age' },
];
const DEBOUNCE_MS = 300;
const PAGE = 100;
const MAX_LIMIT = 500;  // ponytail: past this, narrow with the status pills; API clients can walk next_cursor

// "Critical" means a P0 someone still has to act on.
const isCritical = i => i.priority === 'P0' && ['OPEN', 'INVESTIGATING'].includes(i.status);

// The filters, search text and sort live in `view` (owned by App, so they survive a tab switch); `setView` is a
// state setter. `selectedInfo` ({ id, component, status }) names the open incident for the "not in this view" bar.
// onLoaded(ids) reports the critical incident ids of each successful load, in the order the rows show them ([] when none).
export function IncidentList({ view, setView, onSelect, selectedId, selectedInfo, refreshTick, onLoaded }) {
  const { status: filter, priority, mine, search, sort } = view;
  const patch = (p) => setView(v => ({ ...v, ...p }));
  const [limit, setLimit] = useState(PAGE);
  const [q, setQ] = useState(search.trim());  // the debounced search that actually queries

  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setLimit(PAGE); }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Keyed by the filters only, so asking for more rows keeps the current ones on screen while it loads.
  const { data, error, loading, reload } = useQuery(
    `${filter}|${q}|${priority}|${mine}`,
    () => fetchWorkItems({
      status: filter === 'ALL' ? undefined : filter, limit,
      q: q || undefined, priority: priority || undefined, assignee: mine ? 'me' : undefined,
    }),
    `${refreshTick}:${limit}`);
  const filtered = filter !== 'ACTIVE' || q || priority || mine;
  // Sorting is client-side over the loaded rows, and j/k follow what is on screen.
  const incidents = useMemo(() => sortIncidents(data?.items ?? [], sort.key, sort.dir), [data, sort]);
  const clickSort = (key) => patch({ sort: sort.key !== key ? { key, dir: 'asc' } : { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } });

  const critical = incidents.filter(isCritical);
  const p0Count = critical.length;
  const unowned = critical.filter(i => !i.assignee_id).length;  // a P0 nobody owns is the root-cause risk worth flagging
  // The sorted rows, so the incident that opens by itself is the one on top of the list (the most overdue P0).
  useEffect(() => { if (data) onLoaded?.(incidents.filter(isCritical).map(i => i.id)); }, [data, incidents, onLoaded]);

  // The open incident can be missing from the rows (a status filter that excludes it, or it moved on after an
  // action). Say so, once the list has loaded, and offer the way back. Nothing to offer when nothing is filtered.
  const narrowed = filter !== 'ALL' || q || priority || mine;
  const missing = selectedInfo?.id === selectedId && selectedId != null && data && !loading && !error && narrowed
    && !incidents.some(i => i.id === selectedId);

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
        {/* "100 of 152" while another page exists, else just the total; nothing from an API that sends no total */}
        {data?.total != null && (
          <span className="micro list-count">{data.next_cursor ? `${incidents.length.toLocaleString()} of ${data.total.toLocaleString()}` : data.total.toLocaleString()}</span>
        )}
        <div className="list-head-right">
          {loading && <span className="spinner spinner-sm" />}
          {p0Count > 0 && (
            <button type="button" className="critical-count" aria-label={`Show ${p0Count} critical ${plural(p0Count, 'incident')}${unowned ? `, ${unowned} unowned` : ''}`}
              onClick={() => { patch({ priority: 'P0', status: 'ACTIVE' }); setLimit(PAGE); }}>
              <span className="critical-dot" aria-hidden="true" />
              {p0Count} critical{unowned > 0 && ` · ${unowned} unowned`}
            </button>
          )}
        </div>
      </div>

      <div className="list-toolbar">
        <div className="pills">
          <div className="seg">
            {FILTERS.map(f => (
              <button type="button" key={f} className="pill" aria-pressed={filter === f} onClick={() => { patch({ status: f }); setLimit(PAGE); }}>
                {f[0] + f.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          <button type="button" className="pill" aria-pressed={mine} onClick={() => { patch({ mine: !mine }); setLimit(PAGE); }}>
            Assigned to me
          </button>
        </div>

        <div className="filter-row">
          <span className="search">
            <Icon name="search" />
            <input ref={searchRef} type="search" name="q" aria-label="Search components" aria-keyshortcuts="/" placeholder="Search components" maxLength={64}
              value={search} onChange={e => patch({ search: e.target.value })} />
            <kbd className="kbd" aria-hidden="true">/</kbd>
          </span>
          <select name="priority" aria-label="Priority" value={priority}
            onChange={e => { patch({ priority: e.target.value }); setLimit(PAGE); }}>
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
      {data?.next_cursor && (
        <div className="list-hint">Sorted within the {incidents.length} loaded</div>
      )}

      <div className="list-body">
        {missing && (
          <div className="list-note">
            <span>{selectedInfo.component} ({selectedInfo.status}) is not in this view.</span>
            <button type="button" className="btn-link" onClick={() => { patch({ status: 'ALL', priority: '', mine: false, search: '' }); setLimit(PAGE); }}>Show all</button>
          </div>
        )}
        {error && <ErrorNote onRetry={reload}>{errorMessage(error, 'Could not load incidents')}</ErrorNote>}
        {!loading && !error && incidents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-mark"><Icon name="null" size={32} /></div>
            <div className="empty-title">No incidents</div>
            <div className="empty-sub">{filtered ? 'No incidents match these filters.' : 'All quiet, systems nominal.'}</div>
          </div>
        ) : incidents.map(incident => (
          <button type="button" key={incident.id} className="btn-bare incident-row row-grid" data-incident-id={incident.id}
            data-selected={incident.id === selectedId} aria-current={incident.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(incident.id)}>
            <span className="cell" data-col="priority"><PriorityBadge priority={incident.priority} short /></span>
            <span className="cell cell-comp" data-col="component">
              <span className="row-component" title={incident.component}>{incident.component}</span>
            </span>
            <span className="cell" data-col="status"><StatusBadge status={incident.status} /></span>
            <span className="cell" data-col="sla">
              {incident.sla_deadline && !['RESOLVED', 'CLOSED'].includes(incident.status) && (
                <SlaTimer deadline={incident.sla_deadline} />
              )}
              {incident.status === 'RESOLVED' && <RcaMarker incident={incident} />}
            </span>
            <span className="cell row-assignee" data-col="assignee" data-unowned={isCritical(incident) && !incident.assignee_id ? 'true' : undefined}>
              {incident.assignee_username ? (
                <>
                  <span className="avatar avatar-sm" aria-hidden="true">{incident.assignee_username[0].toUpperCase()}</span>
                  <span className="row-assignee-name">{incident.assignee_username}</span>
                </>
              ) : (
                <>
                  {isCritical(incident) && <span className="unowned-ring" aria-hidden="true" />}
                  Unassigned
                </>
              )}
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

// A resolved incident still owes its RCA: "RCA in 1d" while due, "RCA +1d" with the quiet breach dot once overdue.
function RcaMarker({ incident }) {
  const due = rcaDue(incident, useNow());
  if (!due) return null;
  return (
    <span className="sla-timer rca-due" data-level={due.overdue ? 'muted' : undefined}>
      <span className="sr-only">{due.overdue ? `RCA overdue by ${due.words}` : `RCA due in ${due.words}`}</span>
      <span aria-hidden="true">{due.overdue ? `RCA +${due.short}` : `RCA in ${due.short}`}</span>
    </span>
  );
}

function SlaTimer({ deadline }) {
  const now = useNow();
  const diff = new Date(deadline) - now;
  if (diff <= 0) return (
    <span className="sla-timer breached" data-level={breachLevel(deadline, now)}>
      <span className="sr-only">SLA breached {breachAgeWords(deadline, now)} ago</span>
      <span aria-hidden="true">{breachAge(deadline, now)}</span>
    </span>
  );
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
  const level = diff < 300000 ? 'p0' : diff < 1800000 ? 'p2' : 'p3';
  return <span className="sla-timer" data-level={level}>{h > 0 ? `${h}h ` : ''}{m}m {s}s</span>;
}
