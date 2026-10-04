// Light/dark preference. HeroUI switches its tokens only on data-theme / .dark (never on prefers-color-scheme),
// so 'system' is resolved here to an explicit light or dark, and watchSystemTheme follows OS changes.
// main.jsx applies it before the first render (the CSP forbids an inline script in index.html).
const KEY = 'nullify.theme';
const ORDER = ['system', 'light', 'dark'];

export function getThemePref() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

const systemQuery = () => window.matchMedia?.('(prefers-color-scheme: dark)');

export function applyTheme(pref) {
  const mode = pref === 'light' || pref === 'dark' ? pref : systemQuery()?.matches ? 'dark' : 'light';
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.classList.toggle('dark', mode === 'dark');
}

// Re-applies 'system' when the OS switches. Returns the unsubscribe.
export function watchSystemTheme() {
  const query = systemQuery();
  if (!query) return () => {};
  const onChange = () => { if (getThemePref() === 'system') applyTheme('system'); };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function setThemePref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* storage blocked: the choice lasts for this page only */ }
  applyTheme(pref);
}

export const nextTheme = (pref) => ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
