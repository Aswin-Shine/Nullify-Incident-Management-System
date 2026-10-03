import { useState, useEffect, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { avatarColor } from '../format';
import { fetchWorkItems, errorMessage } from '../api/client';
import { useQuery } from '../hooks/useQuery';
import { useNow } from '../hooks/useNow';
import { PriorityBadge, StatusBadge } from './Badges';
import { ErrorNote } from './ErrorNote';

const FILTERS = ['ALL', 'OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
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
  const incidents = data?.items ?? [];

  const p0Count = incidents.filter(isCritical).length;

  // j / k move through the rows, / jumps to search. Skipped while typing and when a modifier is held.
  const searchRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key !== 'j' && e.key !== 'k') return;
      const rows = data?.items ?? [];
      const at = rows.findIndex(i => i.id === selectedId);
      const next = rows[e.key === 'j' ? at + 1 : at - 1];
      if (!next) return;
      onSelect(next.id);
      document.querySelector(`[data-incident-id="${next.id}"]`)?.scrollIntoView?.({ block: 'nearest' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [data, selectedId, onSelect]);

  return (
    <div className="glass incident-list">
      <div className="list-head">
        <h2>Incidents</h2>
        <div className="list-head-right">
          {loading && <span className="spinner spinner-sm" />}
          {p0Count > 0 && <div className="critical-count">{p0Count} critical</div>}
        </div>
      </div>

      <div className="pills">
        {FILTERS.map(f => (
          <button type="button" key={f} className="pill" aria-pressed={filter === f} onClick={() => { setFilter(f); setLimit(PAGE); }}>
            {f}
          </button>
        ))}
        <button type="button" className="pill" aria-pressed={mine} onClick={() => { setMine(m => !m); setLimit(PAGE); }}>
          Assigned to me
        </button>
      </div>

      <div className="filter-row">
        <input ref={searchRef} type="search" name="q" aria-label="Search components" aria-keyshortcuts="/" placeholder="Search components" maxLength={64}
          value={search} onChange={e => setSearch(e.target.value)} />
        <select name="priority" aria-label="Priority" value={priority}
          onChange={e => { setPriority(e.target.value); setLimit(PAGE); }}>
          <option value="">All priorities</option>
          {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div className="muted-sm list-hint">j / k to move · / to search</div>

      <div className="list-body">
        {error && <ErrorNote>{errorMessage(error, 'Could not load incidents')}</ErrorNote>}
        {!loading && incidents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-mark">∅</div>
            <div className="empty-title">No incidents</div>
            <div className="empty-sub">{filtered ? 'No incidents match these filters.' : 'All quiet, systems nominal.'}</div>
          </div>
        ) : incidents.map(incident => (
          <button type="button" key={incident.id} className="btn-bare incident-row" data-incident-id={incident.id}
            data-selected={incident.id === selectedId}
            data-p0={isCritical(incident)}
            onClick={() => onSelect(incident.id)}>
            <span className="row-top">
              <span className="row-main">
                <PriorityBadge priority={incident.priority} />
                <span className="row-component">{incident.component}</span>
              </span>
              {incident.sla_deadline && !['RESOLVED', 'CLOSED'].includes(incident.status) && (
                <SlaTimer deadline={incident.sla_deadline} />
              )}
            </span>
            <span className="row-bottom">
              <span className="row-main">
                <StatusBadge status={incident.status} />
                <span className="row-title">{incident.title || '-'}</span>
              </span>
              <span className="row-assignee">
                {incident.assignee_username ? (
                  <>
                    <span className="avatar avatar-sm" style={{ background: avatarColor(incident.assignee_username) }} aria-hidden="true">
                      {incident.assignee_username[0].toUpperCase()}
                    </span>
                    {incident.assignee_username}
                  </>
                ) : 'Unassigned'}
              </span>
              <span className="row-age">
                {formatDistanceToNow(new Date(incident.created_at), { addSuffix: true })}
              </span>
            </span>
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
