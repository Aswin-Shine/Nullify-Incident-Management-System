import { useState, useEffect } from 'react';
import { fetchHealth } from '../api/client';

// A 32px status strip: service state, queue depth, then the live event feed (newest first, older ones fade).
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
      <div className="health-state" data-ok={isHealthy}>
        <span className="health-dot" />
        <span>{isHealthy ? 'HEALTHY' : 'DEGRADED'}</span>
      </div>

      <div className="health-queue" data-hot={qPct > 80}>
        <span>Queue {qDepth.toLocaleString()} / {qCap.toLocaleString()}</span>
        <span className="meter" aria-hidden="true">
          <span className="meter-fill" style={{ width: `${Math.min(100, qPct)}%` }} />
        </span>
      </div>

      <div className="health-feed">
        {liveEvents.length > 0 ? (
          liveEvents.map((e, i) => (
            <span key={i} className="feed-item" data-first={i === 0} style={{ opacity: 1 - i * 0.18 }}>{e}</span>
          ))
        ) : (
          <span className="feed-idle">Waiting for signals</span>
        )}
      </div>
    </div>
  );
}
