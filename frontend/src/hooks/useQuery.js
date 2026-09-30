import { useState, useEffect, useRef, useCallback } from 'react';

// Fetch `fetcher()` whenever `key` (a string, or null to skip) or `refreshKey` changes.
// A response that arrives after the key has moved on is dropped, so switching between items
// can never show the previous item's data. Data is kept while the same key reloads.
export function useQuery(key, fetcher, refreshKey) {
  const [res, setRes] = useState({ key: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; });

  useEffect(() => {
    if (key == null) return undefined;
    let live = true;
    fetcherRef.current().then(
      data => { if (live) setRes({ key, data, error: null }); },
      error => { if (live) setRes(r => ({ key, data: r.key === key ? r.data : null, error })); },
    );
    return () => { live = false; };
  }, [key, refreshKey, tick]);

  const current = res.key === key;
  const reload = useCallback(() => setTick(t => t + 1), []);
  // Render a mutation's response directly instead of refetching.
  const setData = useCallback(data => setRes({ key, data, error: null }), [key]);
  return {
    data: current ? res.data : null,
    error: current ? res.error : null,
    loading: key != null && !current,
    reload,
    setData,
  };
}
