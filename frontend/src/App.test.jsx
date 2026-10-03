import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import * as api from './api/client'
import { useWebSocket } from './hooks/useWebSocket'

vi.mock('./hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }))
// The detail pane is covered in its own tests; here it only reports which incident it was given.
vi.mock('./components/IncidentDetail', () => ({ IncidentDetail: ({ id }) => <div data-testid="detail">{String(id)}</div> }))
vi.mock('./api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), fetchWorkItems: vi.fn(), fetchHealth: vi.fn(), listUsers: vi.fn(),
  fetchMTTR: vi.fn(), fetchSLA: vi.fn(), fetchTimeseries: vi.fn(),
}))

afterEach(() => {
  delete document.documentElement.dataset.theme
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.resetAllMocks()
  document.title = 'Nullify'
  api.fetchWorkItems.mockResolvedValue({ items: [], next_cursor: null })
  api.fetchHealth.mockResolvedValue({ status: 'ok' })
  api.fetchMTTR.mockResolvedValue([])  // same for the Analytics tab: its 401 landed in the next test
  api.fetchSLA.mockResolvedValue({ total: 0, breached: 0, breach_rate_pct: 0, open_by_priority: {} })
  api.fetchTimeseries.mockResolvedValue([])
  api.listUsers.mockResolvedValue([])  // an unmocked call hit the network and its 401 signed the test user out
})

// App brings its own AuthProvider, so sign in through the mocked refresh and render it bare.
async function open(role) {
  api.refreshSession.mockResolvedValue({ user: { id: 'u1', username: 'me', role } })
  render(<App />)
  await screen.findByRole('button', { name: 'Log out' })  // waits for the session restore, not a fixed delay
}

test('tabs and logout are real buttons with names (F-08)', async () => {
  await open('sre')
  for (const name of ['Incidents', 'Analytics', 'Inject', 'Log out']) {
    expect(screen.getByRole('button', { name }).tagName).toBe('BUTTON')
  }
})

test('a viewer gets no Inject tab', async () => {
  await open('viewer')
  expect(screen.getByRole('button', { name: 'Analytics' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Inject' })).toBeNull()
})

test('an admin sees the Account and Users tabs', async () => {
  await open('admin')
  expect(screen.getByRole('button', { name: 'Account' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Users' })).toBeTruthy()
})

test.each(['sre', 'viewer'])('a %s sees Account but not Users', async (role) => {
  await open(role)
  expect(screen.getByRole('button', { name: 'Account' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Users' })).toBeNull()
})

// The latest onMessage handler App handed to the (mocked) WebSocket hook.
const emit = (msg) => act(() => { useWebSocket.mock.calls.at(-1)[0](msg) })
const created = (over = {}) => ({ event: 'work_item_created', id: 'new-1', component: 'RDBMS_X', priority: 'P0', ...over })

test('loading with ?incident=abc opens the Incidents tab with that incident selected', async () => {
  window.history.replaceState(null, '', '/?incident=abc')
  await open('sre')
  expect(screen.getByTestId('detail').textContent).toBe('abc')
  expect(screen.getByRole('button', { name: 'Incidents' }).getAttribute('aria-current')).toBe('page')
})

test('selecting an incident puts its id in the URL', async () => {
  api.fetchWorkItems.mockResolvedValue({ items: [{
    id: 'wi-9', component: 'CACHE_9', priority: 'P2', status: 'OPEN', title: 't', created_at: new Date().toISOString(),
  }], next_cursor: null })
  await open('sre')
  await userEvent.click(await screen.findByRole('button', { name: /CACHE_9/ }))
  expect(window.location.search).toBe('?incident=wi-9')
  expect(screen.getByTestId('detail').textContent).toBe('wi-9')
})

test('a new P0 shows an alert toast whose Open button selects that incident', async () => {
  await open('sre')
  emit(created())
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('New P0: RDBMS_X')
  await userEvent.click(screen.getByRole('button', { name: 'Open' }))
  expect(screen.getByTestId('detail').textContent).toBe('new-1')
  expect(window.location.search).toBe('?incident=new-1')
})

test('a new P1 shows no alert', async () => {
  await open('sre')
  emit(created({ priority: 'P1' }))
  expect(screen.queryByRole('alert')).toBeNull()
})

test('while the tab is hidden a P0 prefixes the title with (1), and returning clears it', async () => {
  await open('sre')
  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  emit(created())
  expect(document.title).toBe('(1) Nullify')
  emit(created({ id: 'new-2' }))
  expect(document.title).toBe('(2) Nullify')
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(document.title).toBe('Nullify')
})

test('a visible tab leaves the title alone', async () => {
  await open('sre')
  emit(created())
  expect(document.title).toBe('Nullify')
})

test('with permission granted and the tab hidden a P0 also raises a desktop notification', async () => {
  const made = []
  class FakeNotification {
    static permission = 'granted'
    constructor(title, opts) { this.title = title; this.opts = opts; made.push(this) }
  }
  vi.stubGlobal('Notification', FakeNotification)
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
  await open('sre')
  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  emit(created())
  expect(made).toHaveLength(1)
  expect(made[0].title).toBe('New P0: RDBMS_X')
  act(() => { made[0].onclick() })
  expect(focus).toHaveBeenCalled()
  expect(screen.getByTestId('detail').textContent).toBe('new-1')
  focus.mockRestore()
})

test('without permission no desktop notification is made', async () => {
  const made = []
  class FakeNotification { static permission = 'default'; constructor() { made.push(this) } }
  vi.stubGlobal('Notification', FakeNotification)
  await open('sre')
  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  emit(created())
  expect(made).toHaveLength(0)
})

test('the live feed labels assignment and creation events readably', async () => {
  await open('sre')
  emit({ event: 'work_item_assigned', id: 'wi-1' })
  emit(created({ priority: 'P2', component: 'CACHE_7' }))
  expect((await screen.findAllByText('assignment changed')).length).toBeGreaterThan(0)
  expect(screen.getAllByText('new P2 CACHE_7').length).toBeGreaterThan(0)
  expect(screen.queryByText('work_item_assigned')).toBeNull()
})

test('the sidebar is a navigation landmark named Main', async () => {
  await open('sre')
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
})

test('the theme toggle cycles System to Light and sets data-theme on the page', async () => {
  await open('sre')
  await userEvent.click(screen.getByRole('button', { name: 'Theme: System' }))
  expect(screen.getByRole('button', { name: 'Theme: Light' })).toBeTruthy()
  expect(document.documentElement.dataset.theme).toBe('light')
  await userEvent.click(screen.getByRole('button', { name: 'Theme: Light' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
  await userEvent.click(screen.getByRole('button', { name: 'Theme: Dark' }))
  expect(document.documentElement.dataset.theme).toBeUndefined()
})

test('the split handle starts at 560 on a wide window', async () => {
  vi.stubGlobal('innerWidth', 1440)
  await open('sre')
  expect(screen.getByRole('separator', { name: 'Resize incident list' }).getAttribute('aria-valuenow')).toBe('560')
})

test('the split handle is on Incidents and gone on Analytics', async () => {
  await open('sre')
  const sep = screen.getByRole('separator', { name: 'Resize incident list' })
  expect(sep.getAttribute('aria-orientation')).toBe('vertical')
  expect(sep.getAttribute('aria-valuenow')).toBe('408')  // jsdom is 1024px wide: 1024 - 56 - 560 leaves 408
  await userEvent.click(screen.getByRole('button', { name: 'Analytics' }))
  expect(screen.queryByRole('separator', { name: 'Resize incident list' })).toBeNull()
})

test('the sidebar Search button opens the command palette', async () => {
  await open('sre')
  expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Search' }))
  expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
})

test.each([['Control', '{Control>}k{/Control}'], ['Meta', '{Meta>}k{/Meta}']])('%s+K opens the palette and a second press closes it', async (_, combo) => {
  await open('sre')
  await userEvent.keyboard(combo)
  expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
  await userEvent.keyboard(combo)
  expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
})

test('Escape closes the palette and focus returns to the Search button', async () => {
  await open('sre')
  const trigger = screen.getByRole('button', { name: 'Search' })
  await userEvent.click(trigger)
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test('"Go to Analytics" from the palette switches the tab', async () => {
  await open('sre')
  await userEvent.keyboard('{Control>}k{/Control}')
  await userEvent.type(screen.getByRole('combobox', { name: 'Search commands and incidents' }), 'ana')
  await userEvent.keyboard('{Enter}')
  expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Analytics' }).getAttribute('aria-current')).toBe('page')
})

test('opening an incident from the palette selects it on the Incidents tab', async () => {
  api.fetchWorkItems.mockResolvedValue({
    items: [{ id: 'wi-5', component: 'CACHE_5', priority: 'P2', status: 'OPEN', title: 't', created_at: new Date().toISOString() }], next_cursor: null,
  })
  await open('sre')
  await userEvent.click(screen.getByRole('button', { name: 'Analytics' }))
  await userEvent.keyboard('{Control>}k{/Control}')
  await userEvent.type(screen.getByRole('combobox', { name: 'Search commands and incidents' }), 'cache')
  await userEvent.click(await screen.findByRole('option', { name: /Open CACHE_5/ }, { timeout: 2000 }))
  expect(window.location.search).toBe('?incident=wi-5')
  expect(screen.getByRole('button', { name: 'Incidents' }).getAttribute('aria-current')).toBe('page')
})
