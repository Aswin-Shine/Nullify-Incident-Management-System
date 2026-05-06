import React, { useState, useEffect } from 'react';
import { fetchHealth } from '../api/client';

export function HealthBar({ liveEvents = [] }) {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    const load = () => fetchHealth().then(setHealth).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const isHealthy = health?.status === 'ok';
  const qDepth = health?.queue_depth ?? 0;
  const qCap   = health?.queue_capacity ?? 50000;
  const qPct   = Math.round((qDepth / qCap) * 100);

  return (
    <div style={{ height: 32, background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', padding: '0 24px', justifyContent: 'space-between', position: 'relative', zIndex: 50, flexShrink: 0 }}>

      {/* Left: status + queue */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: isHealthy ? 'var(--success)' : 'var(--error)', boxShadow: `0 0 10px ${isHealthy ? 'var(--success)' : 'var(--error)'}`, animation: 'pulse 2s infinite' }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: isHealthy ? 'var(--success)' : 'var(--error)', letterSpacing: '0.04em' }}>
            {isHealthy ? 'HEALTHY' : 'DEGRADED'}
          </span>
        </div>
        <div style={{ height: 12, width: 1, background: 'var(--border-subtle)' }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>Queue {qDepth.toLocaleString()} / {qCap.toLocaleString()}</span>
          <span style={{ fontSize: 10, color: qPct > 80 ? 'var(--warning)' : 'var(--text-tertiary)', fontWeight: qPct > 80 ? 600 : 400 }}>{qPct}%</span>
        </div>
      </div>

      {/* Middle: live event pills scrolling */}
      <div style={{ flex: 1, overflow: 'hidden', margin: '0 40px' }}>
        {liveEvents.length > 0 ? (
          <div style={{ display: 'flex', gap: 12, whiteSpace: 'nowrap' }}>
            {liveEvents.map((e, i) => (
              <span key={i} style={{ fontSize: 10, color: 'var(--text-tertiary)', background: 'var(--bg-raised)', padding: '1px 8px', borderRadius: 4, border: '1px solid var(--border-subtle)', opacity: 1 - i * 0.15, animation: i === 0 ? 'slideInLeft 0.3s' : 'none' }}>
                {e}
              </span>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>Waiting for signals… ∅ Ingestion pipeline active</span>
        )}
      </div>

      {/* Right: last 3 event type chips */}
      <div style={{ display: 'flex', gap: 6 }}>
        {liveEvents.slice(0, 3).map((e, i) => (
          <div key={i} style={{ padding: '2px 8px', background: 'var(--bg-raised)', borderRadius: 4, fontSize: 10, color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', animation: i === 0 ? 'slideInLeft 0.3s' : 'none' }}>
            {e}
          </div>
        ))}
      </div>
    </div>
  );
}
