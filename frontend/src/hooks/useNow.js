import { useSyncExternalStore } from 'react';

// One 1 s clock for every countdown on screen; it only ticks while something is subscribed.
let now = Date.now();
let timer = null;
const listeners = new Set();

function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(() => { now = Date.now(); listeners.forEach(l => l()); }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { clearInterval(timer); timer = null; }
  };
}

export const useNow = () => useSyncExternalStore(subscribe, () => now);
