// jsdom has no CSS.escape; React Aria's menus call it. Enough for the ids and keys the tests use.
if (!globalThis.CSS?.escape) {
  globalThis.CSS = { ...globalThis.CSS, escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) }
}

// jsdom has no ResizeObserver; HeroUI's tab list watches its size for overflow chevrons. Layout is not tested here.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}

// jsdom has no Web Animations; React Aria waits on getAnimations() when the tab indicator moves.
if (typeof Element !== 'undefined' && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}
