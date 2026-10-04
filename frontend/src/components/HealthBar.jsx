import { useState, useEffect } from 'react';
import { fetchHealth } from '../api/client';

// What the API check says, not what the infrastructure behind it is doing.
const API_LABEL = { ok: 'API OK', unreachable: 'API UNREACHABLE' };

// What the WebSocket is doing: events only arrive while 'live'. The hint rides in its own span so a phone can drop it.
const FEED_LABEL = { live: 'LIVE', connecting: 'CONNECTING…', reconnecting: 'RECONNECTING' };

// A 32px status strip: API state, live-feed state, queue depth, unopened new P0s, then the event feed (newest first, older ones fade).
// `feed` is 'connecting' | 'live' | 'reconnecting'; `newP0` is how many new P0s have not been opened yet; onOpenNewP0 opens the oldest.
export function HealthBar({ feed = 'connecting', liveEvents = [], newP0 = 0, onOpenNewP0 }) {
  const [health, setHealth] = useState(null);
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  useEffect(() => {
    // An unreachable backend must not keep the last good state.
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
        <span>{API_LABEL[health?.status] ?? 'API DEGRADED'}</span>
      </div>

      <div className="health-feed-state" role="status" data-state={feed}>
        <span className="health-dot" />
        <span>{FEED_LABEL[feed]}{feed === 'reconnecting' && <span className="feed-hint"> · events may be missed</span>}</span>
      </div>

      <div className="health-queue" data-hot={qPct > 80}>
        <span>Queue {qDepth.toLocaleString()} / {qCap.toLocaleString()}</span>
        <span className="meter" aria-hidden="true">
          <span className="meter-fill" style={{ width: `${Math.min(100, qPct)}%` }} />
        </span>
      </div>

      {newP0 > 0 && (
        <button type="button" className="strip-btn strip-alert" onClick={onOpenNewP0}>{newP0} new P0</button>
      )}
      {newP0 > 0 && permission === 'default' && (
        <button type="button" className="strip-btn"
          onClick={() => Notification.requestPermission().then(setPermission, () => setPermission(Notification.permission))}>
          Enable desktop alerts
        </button>
      )}

      <div className="health-feed">
        {liveEvents.length > 0 ? (
          liveEvents.map((e, i) => (
            <span key={i} className="feed-item" data-first={i === 0} style={{ opacity: 1 - i * 0.18 }}>{e}</span>
          ))
        ) : feed === 'live' && (
          <span className="feed-idle">Live · no new signals</span>
        )}
      </div>
    </div>
  );
}
