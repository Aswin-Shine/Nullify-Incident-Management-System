import { useState, useEffect, useCallback } from 'react';
import { fetchWorkItems } from '../api/client';
import { PriorityBadge, StatusBadge } from './Badges';
import { formatDistanceToNow } from 'date-fns';

const FILTERS = ['ALL', 'OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'];

export function IncidentList({ onSelect, selectedId, refreshTick }) {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('ALL');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchWorkItems(filter === 'ALL' ? undefined : filter);
      setItems(data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load, refreshTick]);

  const p0Count = items.filter(i => i.priority === 'P0' && i.status !== 'CLOSED').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', letterSpacing: '0.1em' }}>INCIDENTS</span>
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-1)' }}>{items.length}</span>
        {p0Count > 0 && (
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--p0)', animation: 'pulse 1.5s infinite' }}>
            ● {p0Count} CRITICAL
          </span>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{
              fontSize: 10, fontFamily: 'var(--mono)', padding: '3px 10px',
              borderRadius: 3, letterSpacing: '0.08em',
              background: filter === f ? 'var(--accent-bg)' : 'transparent',
              color: filter === f ? 'var(--accent-hover)' : 'var(--text-2)',
              border: filter === f ? '1px solid var(--accent)' : '1px solid transparent',
            }}>{f}</button>
        ))}
        <button onClick={load} style={{
          marginLeft: 'auto', fontSize: 10, fontFamily: 'var(--mono)', padding: '3px 10px',
          borderRadius: 3, background: 'transparent', color: 'var(--text-2)',
          border: '1px solid var(--border)',
        }}>↺</button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ padding: 20, color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 12 }}>loading...</div>}
        {!loading && items.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 12 }}>
            no incidents
          </div>
        )}
        {items.map(item => (
          <div key={item.id} onClick={() => onSelect(item.id)}
            style={{
              padding: '12px 16px', cursor: 'pointer',
              borderBottom: '1px solid var(--border)',
              background: selectedId === item.id ? 'var(--bg-2)' : 'transparent',
              borderLeft: selectedId === item.id ? '3px solid var(--accent)' : '3px solid transparent',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => { if (selectedId !== item.id) e.currentTarget.style.background = 'var(--bg-1)'; }}
            onMouseLeave={e => { if (selectedId !== item.id) e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5, flexWrap: 'wrap' }}>
              <PriorityBadge priority={item.priority} />
              <StatusBadge status={item.status} />
            </div>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 3, color: 'var(--text-0)' }}>
              {item.title}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)', background: 'var(--accent-bg)', padding: '1px 6px', borderRadius: 2 }}>
                {item.component}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)' }}>
                {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
              </span>
            </div>
            {item.mttr_seconds && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--p3)', marginTop: 3 }}>
                MTTR: {Math.round(item.mttr_seconds / 60)}m
              </div>
            )}
          </div>
        ))}
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  );
}
