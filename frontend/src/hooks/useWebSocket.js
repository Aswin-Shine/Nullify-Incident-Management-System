import { useEffect, useRef } from 'react';
import { getAccessToken, refreshSession } from '../api/client';

// Same-origin /ws (nginx in Docker, the Vite proxy in dev), so it works on any host and over https.
function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

const POLICY_VIOLATION = 1008; // server rejected our auth, usually an expired access token

// 1 s, 2 s, 4 s ... up to 30 s, each drawn between half and all of it, so after a deploy the clients spread out
// instead of all reconnecting (and refetching) at the same moment.
export function reconnectDelay(attempt) {
  return Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
}

// `onReconnect` fires when the socket is authenticated again after a drop: events sent meanwhile are gone.
// `onStatus` hears 'connecting' (before the first auth_ok), 'live' (after any auth_ok) and 'reconnecting' (after a close, until the next auth_ok).
export function useWebSocket(onMessage, onReconnect, onStatus) {
  const onMessageRef = useRef(onMessage);
  const onReconnectRef = useRef(onReconnect);
  const onStatusRef = useRef(onStatus);
  useEffect(() => { onMessageRef.current = onMessage; onReconnectRef.current = onReconnect; onStatusRef.current = onStatus; });

  useEffect(() => {
    let ws;
    let retry;
    let stopped = false;
    let dropped = false;
    let attempt = 0;  // failed tries since the last auth_ok

    const scheduleReconnect = () => { if (!stopped) retry = setTimeout(connect, reconnectDelay(attempt++)); };  // a refresh can settle after unmount

    function connect() {
      ws = new WebSocket(wsUrl());
      // Auth is the first message, never the URL, so the token stays out of proxy logs.
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: getAccessToken() }));
      ws.onmessage = (e) => {
        let data;
        try {
          data = JSON.parse(e.data);
        } catch {
          console.warn('Ignoring malformed WebSocket message', e.data);
          return;
        }
        if (data.event !== 'auth_ok') { onMessageRef.current(data); return; }
        attempt = 0;
        onStatusRef.current?.('live');
        if (dropped) { dropped = false; onReconnectRef.current?.(); }
      };
      ws.onclose = (e) => {
        if (stopped) return; // unmounted: do not resurrect the socket
        dropped = true;
        onStatusRef.current?.('reconnecting');
        if (e.code === POLICY_VIOLATION) refreshSession().then(scheduleReconnect, scheduleReconnect);
        else scheduleReconnect();
      };
    }

    onStatusRef.current?.('connecting');
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
}
