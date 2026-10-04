import { getThemePref, setThemePref, applyTheme, nextTheme, watchSystemTheme } from './theme'

// A stand-in for window.matchMedia('(prefers-color-scheme: dark)') that the test can flip.
function fakeSystem(dark) {
  const listeners = new Set()
  const mql = { get matches() { return dark }, addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) }
  window.matchMedia = vi.fn(() => mql)
  return { flip(next) { dark = next; listeners.forEach(f => f()) }, listeners }
}

afterEach(() => {
  delete window.matchMedia
  delete document.documentElement.dataset.theme
  document.documentElement.classList.remove('dark')
  localStorage.clear()
  vi.restoreAllMocks()
})

test('getThemePref defaults to system when nothing is stored', () => {
  expect(getThemePref()).toBe('system')
})

test('getThemePref returns a stored light or dark choice, and system for anything else', () => {
  localStorage.setItem('nullify.theme', 'dark')
  expect(getThemePref()).toBe('dark')
  localStorage.setItem('nullify.theme', 'light')
  expect(getThemePref()).toBe('light')
  localStorage.setItem('nullify.theme', 'sepia')
  expect(getThemePref()).toBe('system')
})

test('getThemePref falls back to system when storage throws', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  expect(getThemePref()).toBe('system')
})

test('applyTheme sets data-theme and the dark class for an explicit choice', () => {
  applyTheme('dark')
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  applyTheme('light')
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.documentElement.classList.contains('dark')).toBe(false)
})

test('system resolves to the OS setting (HeroUI only switches on data-theme or .dark)', () => {
  fakeSystem(true)
  applyTheme('system')
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  fakeSystem(false)
  applyTheme('system')
  expect(document.documentElement.dataset.theme).toBe('light')
})

test('system is light where matchMedia does not exist', () => {
  applyTheme('system')
  expect(document.documentElement.dataset.theme).toBe('light')
})

test('watchSystemTheme follows an OS change while the preference is system, and stops when unsubscribed', () => {
  const os = fakeSystem(false)
  applyTheme('system')
  const stop = watchSystemTheme()
  os.flip(true)
  expect(document.documentElement.dataset.theme).toBe('dark')
  stop()
  expect(os.listeners.size).toBe(0)
})

test('watchSystemTheme ignores an OS change when the user picked light or dark', () => {
  const os = fakeSystem(false)
  setThemePref('light')
  watchSystemTheme()
  os.flip(true)
  expect(document.documentElement.dataset.theme).toBe('light')
})

test('nextTheme cycles system, light, dark, system', () => {
  expect(nextTheme('system')).toBe('light')
  expect(nextTheme('light')).toBe('dark')
  expect(nextTheme('dark')).toBe('system')
})

test('setThemePref persists the choice and applies it', () => {
  setThemePref('light')
  expect(localStorage.getItem('nullify.theme')).toBe('light')
  expect(document.documentElement.dataset.theme).toBe('light')
})

test('setThemePref still applies the theme when storage throws', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  setThemePref('dark')
  expect(document.documentElement.dataset.theme).toBe('dark')
})
