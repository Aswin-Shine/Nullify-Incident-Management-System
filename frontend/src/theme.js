// Light/dark preference. 'system' leaves data-theme off so the CSS follows prefers-color-scheme.
// main.jsx applies it before the first render (the CSP forbids an inline script in index.html).
const KEY = 'nullify.theme';
const ORDER = ['system', 'light', 'dark'];

export function getThemePref() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

export function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') root.dataset.theme = pref;
  else delete root.dataset.theme;
}

export function setThemePref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* storage blocked: the choice lasts for this page only */ }
  applyTheme(pref);
}

export const nextTheme = (pref) => ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
