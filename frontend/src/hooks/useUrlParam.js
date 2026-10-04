import { useState, useEffect, useCallback } from 'react';

const read = (name) => new URLSearchParams(window.location.search).get(name);

// One query-string param as state: setting it pushes a history entry (so Back and Forward walk
// through selections) and a popstate restores it. `{ replace: true }` rewrites the current entry
// instead (for a selection the app made on the user's behalf). Stays a hook, not a router, on purpose.
export function useUrlParam(name) {
  const [value, setValue] = useState(() => read(name));

  useEffect(() => {
    const onPop = () => setValue(read(name));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [name]);

  const set = useCallback((next, { replace = false } = {}) => {
    const url = new URL(window.location.href);
    if (next == null) url.searchParams.delete(name);
    else url.searchParams.set(name, next);
    if (url.href !== window.location.href) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    setValue(next ?? null);
  }, [name]);

  return [value, set];
}
