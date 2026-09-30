import { useState, useEffect } from 'react';
import { fetchHealth } from '../api/client';

export function HealthBar({ liveEvents = [] }) {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    // Unreachable backend must read as DEGRADED, not keep the last good state.
    const load = () => fetchHealth().then(setHealth).catch(() => setHealth({ status: 'unreachable' }));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const isHealthy = health?.status === 'ok';
  const qDepth = health?.queue_depth ?? 0;
  const qCap   = health?.queue_capacity ?? 50000;
  const qPct   = Math.round((qDepth / qCap) * 100);

  return (
    <div className="health-bar">
      <div className="health-left">
        <div className="health-state" data-ok={isHealthy}>
          <div className="health-dot" />
          <span>{isHealthy ? 'HEALTHY' : 'DEGRADED'}</span>
        </div>
        <div className="health-sep" />
        <div className="health-queue">
          <span>Queue {qDepth.toLocaleString()} / {qCap.toLocaleString()}</span>
          <span className="queue-pct" data-hot={qPct > 80}>{qPct}%</span>
        </div>
      </div>

      <div className="health-feed">
        {liveEvents.length > 0 ? (
          <div className="feed-list">
            {liveEvents.map((e, i) => (
              <span key={i} className="feed-item" data-first={i === 0} style={{ opacity: 1 - i * 0.15 }}>{e}</span>
            ))}
          </div>
        ) : (
          <span className="feed-idle">Waiting for signals… ∅ Ingestion pipeline active</span>
        )}
      </div>

      <div className="health-right">
        {liveEvents.slice(0, 3).map((e, i) => (
          <div key={i} className="feed-chip" data-first={i === 0}>{e}</div>
        ))}
      </div>
    </div>
  );
}
