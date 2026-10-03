import { useState, useCallback, useRef } from 'react';

const KEY = 'nullify.split';
const DEFAULT = 560;
const MIN = 320;
const STEP = 16;

const DETAIL_MIN = 560;  // the detail pane never gets narrower than this
// Sidebar width per the CSS breakpoints (220px from 1280, a 56px icon rail from 900, a top bar below).
const sidebarWidth = () => (window.innerWidth >= 1280 ? 220 : window.innerWidth >= 900 ? 56 : 0);
const maxWidth = () => Math.max(MIN, window.innerWidth - sidebarWidth() - DETAIL_MIN);
const clamp = (n) => Math.min(maxWidth(), Math.max(MIN, n));
const read = () => {
  try { return Number(localStorage.getItem(KEY)) || DEFAULT; } catch { return DEFAULT; }
};

// Width of the incident list pane, draggable and keyboard-resizable, remembered across reloads.
export function useSplitWidth() {
  const [stored, setStored] = useState(read);
  const drag = useRef(null);
  const width = clamp(stored);  // re-clamped on every render, so a smaller window pulls it back in

  const set = useCallback((n) => {
    const w = clamp(n);
    setStored(w);
    try { localStorage.setItem(KEY, String(w)); } catch { /* storage blocked: the width lasts for this page only */ }
  }, []);

  const onKeyDown = (e) => {
    const next = { ArrowLeft: width - STEP, ArrowRight: width + STEP, Home: MIN, End: maxWidth() }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    set(next);
  };
  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, w: width };
  };
  const onPointerMove = (e) => { if (drag.current) set(drag.current.w + e.clientX - drag.current.x); };
  const onPointerUp = () => { drag.current = null; };
  const onDoubleClick = () => set(DEFAULT);

  return { width, min: MIN, max: maxWidth(), onKeyDown, onPointerDown, onPointerMove, onPointerUp, onDoubleClick };
}
