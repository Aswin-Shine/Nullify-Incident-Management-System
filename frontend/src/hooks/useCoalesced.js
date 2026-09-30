import { useRef, useEffect, useCallback } from 'react';

// Returns a trigger that runs `fn` at most once per `ms`, trailing. Pending work dies with the component.
export function useCoalesced(fn, ms) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(() => {
    timer.current ??= setTimeout(() => { timer.current = null; fnRef.current(); }, ms);
  }, [ms]);
}
