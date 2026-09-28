import { useEffect, useRef } from 'react';
import { getAccessToken, refreshSession } from '../api/client';

// Same-origin /ws (nginx in Docker, the Vite proxy in dev), so it works on any host and over https.
function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

const POLICY_VIOLATION = 1008; // server rejected our auth, usually an expired access token

export function useWebSocket(onMessage) {
  const onMessageRef = useRef(onMessage);
  useEffect(() => { onMessageRef.current = onMessage; });

  useEffect(() => {
    let ws;
    let retry;
    let stopped = false;

    const scheduleReconnect = () => { retry = setTimeout(connect, 3000); };

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
        if (data.event !== 'auth_ok') onMessageRef.current(data);
      };
      ws.onclose = (e) => {
        if (stopped) return; // unmounted: do not resurrect the socket
        if (e.code === POLICY_VIOLATION) refreshSession().then(scheduleReconnect, scheduleReconnect);
        else scheduleReconnect();
      };
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
}
