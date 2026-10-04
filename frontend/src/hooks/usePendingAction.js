import { useState, useRef, useCallback, useEffect } from 'react';

// Delay an action so it can be undone: start(key, run) runs `run` after `delayMs` unless cancel(key) comes first.
// `pending` is { [key]: true } for what is still waiting. Starting a key again replaces its action.
// The timers die with the component, so logging out (or closing the page) inside the window cancels the action;
// for a status change that is safe, the incident simply stays as it was.
export function usePendingAction(delayMs) {
  const [pending, setPending] = useState({});
  const timers = useRef(new Map());

  const settle = useCallback((key) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setPending(p => { const rest = { ...p }; delete rest[key]; return rest; });
  }, []);
  const start = useCallback((key, run) => {
    clearTimeout(timers.current.get(key));
    timers.current.set(key, setTimeout(() => { settle(key); run(); }, delayMs));
    setPending(p => ({ ...p, [key]: true }));
  }, [delayMs, settle]);
  useEffect(() => { const t = timers.current; return () => t.forEach(clearTimeout); }, []);

  return { pending, start, cancel: settle };
}
