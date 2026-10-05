import { useEffect, useRef } from 'react';
import { getAccessToken, refreshSession } from '../api/client';

// Same-origin /ws (nginx in Docker, the Vite proxy in dev), so it works on any host and over https.
function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

const POLICY_VIOLATION = 1008; // server rejected our auth, usually an expired access token

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

    const scheduleReconnect = () => { if (!stopped) retry = setTimeout(connect, 3000); };  // a refresh can settle after unmount

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
