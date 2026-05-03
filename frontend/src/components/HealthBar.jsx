import { useState, useEffect } from 'react';
import { fetchHealth } from '../api/client';

export function HealthBar({ liveEvents }) {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    const load = () => fetchHealth().then(setHealth).catch(() => setHealth(null));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const ok = health?.status === 'ok';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: '6px 20px',
      background: 'var(--bg-1)', borderBottom: '1px solid var(--border)',
      fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)',
    }}>
      <span style={{ color: ok ? 'var(--p3)' : 'var(--p0)' }}>
        ● {ok ? 'HEALTHY' : 'DEGRADED'}
      </span>
      {health && (
        <>
          <span>Q: {health.queue_depth}/{health.queue_capacity}</span>
          <span style={{ color: health.queue_depth > 10000 ? 'var(--p1)' : 'inherit' }}>
            {Math.round(health.queue_depth / health.queue_capacity * 100)}% full
          </span>
        </>
      )}
      <span style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>
        {liveEvents.length > 0 && (
          <span style={{ color: 'var(--accent)' }}>⚡ {liveEvents[0]}</span>
        )}
      </span>
    </div>
  );
}
