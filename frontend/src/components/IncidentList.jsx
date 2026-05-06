import React, { useState, useEffect, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { fetchWorkItems } from '../api/client';
import { PriorityBadge, StatusBadge } from './Badges';

const FILTERS = ['ALL', 'OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'];

export function IncidentList({ onSelect, selectedId, refreshTick }) {
  const [incidents, setIncidents] = useState([]);
  const [filter, setFilter]       = useState('ALL');
  const [loading, setLoading]     = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // fetchWorkItems uses /api/work-items — correct URL
      const data = await fetchWorkItems(filter === 'ALL' ? undefined : filter);
      setIncidents(data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load, refreshTick]);

  const p0Count = incidents.filter(i => i.priority === 'P0' && i.status !== 'CLOSED').length;

  return (
    <div className="glass" style={{ width: 340, height: '100%', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-subtle)', zIndex: 10, borderRadius: 0 }}>

      {/* Header */}
      <div style={{ padding: '20px 20px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>Incidents</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {loading && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />}
            {p0Count > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 12, background: 'var(--p0-bg)', color: 'var(--p0-color)', fontSize: 11, fontWeight: 600, border: '1px solid rgba(248,113,113,0.25)' }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', animation: 'pulseDot 1.5s infinite' }} />
                {p0Count} critical
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 4, overflowX: 'auto', padding: '12px 20px', scrollbarWidth: 'none' }}>
        {FILTERS.map(f => (
          <div key={f} onClick={() => setFilter(f)} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.18s', background: filter === f ? 'var(--accent-dim)' : 'var(--bg-raised)', color: filter === f ? 'var(--accent-light)' : 'var(--text-secondary)', border: filter === f ? '1px solid rgba(124,106,247,0.3)' : '1px solid transparent' }}>
            {f}
          </div>
        ))}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {incidents.length === 0 ? (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
            <div style={{ fontSize: 48, marginBottom: 8, opacity: 0.2 }}>∅</div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>No incidents</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>{filter === 'ALL' ? 'All quiet — systems nominal.' : `No ${filter.toLowerCase()} incidents.`}</div>
          </div>
        ) : incidents.map(incident => {
          const isSelected = incident.id === selectedId;
          const isP0 = incident.priority === 'P0' && incident.status !== 'CLOSED';
          return (
            <div key={incident.id} onClick={() => onSelect(incident.id)} style={{ padding: '14px 20px', cursor: 'pointer', transition: 'all 0.18s', borderBottom: '1px solid var(--border-subtle)', background: isSelected ? 'var(--accent-dim)' : 'transparent', borderLeft: isSelected ? '3px solid var(--accent)' : isP0 ? '2px solid var(--p0-color)' : '3px solid transparent', animation: 'slideInLeft 0.3s ease-out' }}
              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-raised)'; }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', flex: 1 }}>
                  <PriorityBadge priority={incident.priority} />
                  {/* FIX: backend returns component_id, not component */}
                  <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {incident.component_id}
                  </span>
                </div>
                {/* SLA countdown — real field is sla_deadline */}
                {incident.sla_deadline && !['RESOLVED','CLOSED'].includes(incident.status) && (
                  <SlaTimer deadline={incident.sla_deadline} />
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', flex: 1 }}>
                  <StatusBadge status={incident.status} />
                  {/* FIX: backend returns title, not summary */}
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {incident.title || '—'}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {formatDistanceToNow(new Date(incident.created_at), { addSuffix: true })}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SlaTimer({ deadline }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const diff = new Date(deadline) - now;
  if (diff <= 0) return <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--p0-color)', animation: 'pulse 1.5s infinite' }}>BREACHED</span>;
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
  const col = diff < 300000 ? 'var(--p0-color)' : diff < 1800000 ? 'var(--p2-color)' : 'var(--p3-color)';
  return <span style={{ fontSize: 10, fontWeight: 600, color: col, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{h > 0 ? `${h}h ` : ''}{m}m {s}s</span>;
}
