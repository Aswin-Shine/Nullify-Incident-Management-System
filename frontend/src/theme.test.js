import { getThemePref, setThemePref, applyTheme, nextTheme } from './theme'

afterEach(() => {
  delete document.documentElement.dataset.theme
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

test('applyTheme sets data-theme for dark and light and removes it for system', () => {
  applyTheme('dark')
  expect(document.documentElement.dataset.theme).toBe('dark')
  applyTheme('light')
  expect(document.documentElement.dataset.theme).toBe('light')
  applyTheme('system')
  expect(document.documentElement.dataset.theme).toBeUndefined()
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
