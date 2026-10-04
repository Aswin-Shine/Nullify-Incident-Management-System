import { useState, useEffect } from 'react';
import { Button, Popover } from '@heroui/react';
import { fetchHealth } from '../api/client';

// What the WebSocket is doing: events only arrive while 'live'.
const FEED_LABEL = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…' };
const FEED_DETAIL = { live: 'Live feed', connecting: 'Connecting to the live feed…', reconnecting: 'Reconnecting · events may be missed' };
// What the API check says, not what the infrastructure behind it is doing. Only problems show on the pill.
const API_PROBLEM = { unreachable: 'API unreachable', degraded: 'API degraded' };

// The system status, as one pill in the sidebar (the old top strip). The pill shows the live-feed state, plus the API
// state only when something is wrong; its popover holds the API state, the queue and the latest events (newest first).
// Unopened new P0s get their own button above it, because they need action, not a look.
// `feed` is 'connecting' | 'live' | 'reconnecting'; `newP0` counts new P0s not yet opened; onOpenNewP0 opens the oldest.
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

  const apiProblem = health && health.status !== 'ok' ? (API_PROBLEM[health.status] ?? 'API degraded') : null;
  const qDepth = health?.queue_depth ?? 0;
  const qCap = health?.queue_capacity ?? 50000;
  const qPct = Math.round((qDepth / qCap) * 100);
  const label = FEED_LABEL[feed];
  const state = apiProblem ? 'problem' : feed;

  return (
    <div className="status-area">
      {newP0 > 0 && (
        <button type="button" className="new-p0" onClick={onOpenNewP0}>{newP0} new P0</button>
      )}
      {newP0 > 0 && permission === 'default' && (
        <button type="button" className="btn-link enable-alerts"
          onClick={() => Notification.requestPermission().then(setPermission, () => setPermission(Notification.permission))}>
          Enable desktop alerts
        </button>
      )}

      <Popover>
        <Button variant="ghost" className="status-pill" data-state={state} aria-label={`System status: ${label}${apiProblem ? `, ${apiProblem}` : ''}`}>
          <span className="status-dot" aria-hidden="true" />
          <span className="status-text" aria-hidden="true">{apiProblem ?? label}</span>
        </Button>
        <Popover.Content placement="right bottom" className="status-popover">
          <Popover.Dialog>
            <Popover.Heading className="status-heading">System status</Popover.Heading>
            <p className="status-row" data-ok={!apiProblem}><span className="status-dot" aria-hidden="true" />{apiProblem ?? 'API OK'}</p>
            <p className="status-row" data-state={feed}><span className="status-dot" aria-hidden="true" />{FEED_DETAIL[feed]}</p>
            <div className="status-queue" data-hot={qPct > 80}>
              <span>Queue {qDepth.toLocaleString()} / {qCap.toLocaleString()}</span>
              <span className="meter" aria-hidden="true"><span className="meter-fill" style={{ width: `${Math.min(100, qPct)}%` }} /></span>
            </div>
            <p className="status-sub">Recent events</p>
            {liveEvents.length > 0 ? (
              <ol className="status-events">{liveEvents.map((e, i) => <li key={i}>{e}</li>)}</ol>
            ) : (
              <p className="status-idle">{feed === 'live' ? 'No new signals' : 'Waiting for the live feed'}</p>
            )}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      {/* Announced on change; the pill itself is a button, whose children screen readers flatten. */}
      <span role="status" className="sr-only" data-state={feed}>{label}</span>
    </div>
  );
}
