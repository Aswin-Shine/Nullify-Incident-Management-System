import { render, screen, act, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import * as api from './api/client'
import { useWebSocket } from './hooks/useWebSocket'

vi.mock('./hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }))
const mockDetail = vi.hoisted(() => ({ status: 'OPEN' }))  // the state the mocked pane reports for the open incident
// The detail pane is covered in its own tests; here it only reports which incident it was given.
vi.mock('./components/IncidentDetail', async () => {
  const { useEffect } = await import('react')
  return {
    IncidentDetail: ({ id, onResolve, resolving, onOpened, onClose, askNote }) => {
      // The real pane reports the incident it loaded; here every id loads as an unowned incident named COMP_<id>, OPEN unless a test sets mockDetail.status.
      useEffect(() => { if (id) onOpened?.({ id, component: `COMP_${id}`, status: mockDetail.status, assignee_id: null }) }, [id, onOpened])
      return (
        <>
          <div data-testid="detail">{String(id)}</div>
          <button type="button" onClick={() => onResolve({ id, component: 'RDBMS_X' }, 'Failed over')}>mock resolve</button>
          {id && <button type="button" onClick={onClose}>mock deselect</button>}
          {resolving && <span>mock resolving</span>}
          {askNote?.id === id && <span>mock note asked</span>}
        </>
      )
    },
  }
})
vi.mock('./api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), fetchWorkItems: vi.fn(), fetchHealth: vi.fn(), listUsers: vi.fn(),
  fetchMTTR: vi.fn(), fetchSLA: vi.fn(), fetchTimeseries: vi.fn(), updateStatus: vi.fn(), assignWorkItem: vi.fn(), logout: vi.fn(),
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
  mockDetail.status = 'OPEN'
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
  await screen.findByRole('button', { name: /^Account menu/ })  // waits for the session restore, not a fixed delay
}

// Account, Theme, Inject (dev tools) and Log out live in the account menu.
async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: /^Account menu/ }))
  return screen.findByRole('menu')
}
async function pickMenu(name) {
  await openMenu()
  await userEvent.click(screen.getByRole('menuitem', { name }))
}
// The status pill's popover holds the API state, the queue and the live events.
async function openStatus() {
  await userEvent.click(screen.getByRole('button', { name: /System status/ }))
  return screen.findByRole('dialog', { name: 'System status' })
}

test('tabs are real buttons with names, and Log out is a named item in the account menu (F-08)', async () => {
  await open('sre')
  for (const name of ['Incidents', 'Analytics', /^Account menu: me SRE/]) {
    expect(screen.getByRole('button', { name }).tagName).toBe('BUTTON')
  }
  await openMenu()
  expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeTruthy()
})

test('a viewer gets no Inject item', async () => {
  await open('viewer')
  expect(screen.getByRole('button', { name: 'Analytics' })).toBeTruthy()
  await openMenu()
  expect(screen.getByRole('menuitem', { name: 'Account' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Inject' })).toBeNull()
})

test('an admin sees Users in the main nav and Account in the menu', async () => {
  await open('admin')
  expect(screen.getByRole('button', { name: 'Users' })).toBeTruthy()
  await openMenu()
  expect(screen.getByRole('menuitem', { name: 'Account' })).toBeTruthy()
})

test.each(['sre', 'viewer'])('a %s sees Account but not Users', async (role) => {
  await open(role)
  expect(screen.queryByRole('button', { name: 'Users' })).toBeNull()
  await openMenu()
  expect(screen.getByRole('menuitem', { name: 'Account' })).toBeTruthy()
})

test('the main nav is only the pages people work in, and the top status strip is gone', async () => {
  await open('sre')
  const nav = screen.getByRole('navigation', { name: 'Main' })
  const pages = [...nav.querySelectorAll('[aria-current], .nav-item')].filter(b => b.closest('.nav-items')).map(b => b.textContent)
  expect(pages).toEqual(['Incidents', 'Analytics'])
  expect(document.querySelector('.health-bar')).toBeNull()
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
  const status = await openStatus()
  expect(within(status).getByText('assignment changed')).toBeTruthy()
  expect(within(status).getByText('new P2 CACHE_7')).toBeTruthy()
  expect(screen.queryByText('work_item_assigned')).toBeNull()
})

test('the sidebar is a navigation landmark named Main', async () => {
  await open('sre')
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
})

test('the account menu sets the theme, marks the current one, and sets data-theme on the page', async () => {
  await open('sre')
  await openMenu()
  expect(screen.getByRole('menuitemradio', { name: 'System' }).getAttribute('aria-checked')).toBe('true')
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }))
  expect(document.documentElement.dataset.theme).toBe('light')
  await openMenu()
  expect(screen.getByRole('menuitemradio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
  await openMenu()
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'System' }))
  expect(document.documentElement.dataset.theme).toBe('light')  // system resolves; jsdom has no matchMedia, so light
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

test('the WebSocket reconnect callback refetches the incident list (F-35)', async () => {
  await open('sre')
  await screen.findByText('No incidents')
  const before = api.fetchWorkItems.mock.calls.length
  act(() => { useWebSocket.mock.calls.at(-1)[1]() })
  await waitFor(() => expect(api.fetchWorkItems.mock.calls.length).toBe(before + 1))
})

test('a keydown without a key (browser autofill) neither throws nor opens the palette (F-36)', async () => {
  await open('sre')
  const errors = []
  const onError = (e) => { errors.push(e.message); e.preventDefault() }
  window.addEventListener('error', onError)
  const event = new Event('keydown')
  Object.defineProperty(event, 'ctrlKey', { value: true })
  act(() => { document.dispatchEvent(event) })
  window.removeEventListener('error', onError)
  expect(errors).toEqual([])
  expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
})

// ---- UX step 2: auto-select the top P0 ----

const p0 = (over = {}) => ({ id: 'p0-1', component: 'RDBMS_P0', priority: 'P0', status: 'OPEN', title: 't', created_at: new Date().toISOString(), ...over })
const p2 = (over = {}) => p0({ id: 'p2-1', component: 'CACHE_P2', priority: 'P2', ...over })

test('with no ?incident= the top active P0 is opened on load, replacing the history entry', async () => {
  api.fetchWorkItems.mockResolvedValue({ items: [p0(), p2()], next_cursor: null })
  const push = vi.spyOn(window.history, 'pushState')
  const replace = vi.spyOn(window.history, 'replaceState')
  await open('sre')
  await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('p0-1'))
  expect(window.location.search).toBe('?incident=p0-1')
  expect(replace).toHaveBeenCalled()
  expect(push).not.toHaveBeenCalled()
  push.mockRestore(); replace.mockRestore()
})

test('a P0 that is already resolved is not auto-opened', async () => {
  api.fetchWorkItems.mockResolvedValue({ items: [p0({ status: 'RESOLVED' }), p2()], next_cursor: null })
  await open('sre')
  await screen.findByRole('button', { name: /CACHE_P2/ })
  expect(screen.getByTestId('detail').textContent).toBe('null')
})

test('an incident already named in the URL is left alone', async () => {
  window.history.replaceState(null, '', '/?incident=x')
  api.fetchWorkItems.mockResolvedValue({ items: [p0()], next_cursor: null })
  await open('sre')
  await screen.findByRole('button', { name: /RDBMS_P0/ })
  expect(screen.getByTestId('detail').textContent).toBe('x')
})

test('auto-select happens once per page load: after Back it does not reopen', async () => {
  api.fetchWorkItems.mockResolvedValue({ items: [p0()], next_cursor: null })
  await open('sre')
  await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('p0-1'))
  await userEvent.click(screen.getByRole('button', { name: 'Back to incidents' }))
  expect(screen.getByTestId('detail').textContent).toBe('null')
  await userEvent.click(screen.getByRole('button', { name: 'Analytics' }))
  await userEvent.click(screen.getByRole('button', { name: 'Incidents' }))
  await screen.findByRole('button', { name: /RDBMS_P0/ })
  expect(screen.getByTestId('detail').textContent).toBe('null')
})

test('on a phone-width window the list stays up and nothing is auto-opened', async () => {
  vi.stubGlobal('innerWidth', 390)
  api.fetchWorkItems.mockResolvedValue({ items: [p0()], next_cursor: null })
  await open('sre')
  await screen.findByRole('button', { name: /RDBMS_P0/ })
  expect(screen.getByTestId('detail').textContent).toBe('null')
})

// ---- UX step 3: persistent alerts, health label, resolve undo ----

test('a new P0 shows a "1 new P0" strip button that opens it and then goes away', async () => {
  await open('sre')
  expect(screen.queryByRole('button', { name: /new P0/ })).toBeNull()
  emit(created())
  await userEvent.click(await screen.findByRole('button', { name: '1 new P0' }))
  expect(screen.getByTestId('detail').textContent).toBe('new-1')
  expect(screen.queryByRole('button', { name: /new P0/ })).toBeNull()
})

test('the strip opens the oldest unopened P0 first, and opening one from the toast clears it from the count', async () => {
  await open('sre')
  emit(created({ id: 'a', component: 'A_DB' }))
  emit(created({ id: 'b', component: 'B_DB' }))
  const strip = await screen.findByRole('button', { name: '2 new P0' })
  await userEvent.click(strip)
  expect(screen.getByTestId('detail').textContent).toBe('a')
  expect(screen.getByRole('button', { name: '1 new P0' })).toBeTruthy()
})

test('a P1 does not count as a new P0', async () => {
  await open('sre')
  emit(created({ priority: 'P1' }))
  expect(screen.queryByRole('button', { name: /new P0/ })).toBeNull()
})

test('an alert toast is still there after 15 seconds', async () => {
  await open('sre')
  vi.useFakeTimers()
  try {
    emit(created())
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(screen.getByRole('alert').textContent).toContain('New P0: RDBMS_X')
  } finally { vi.useRealTimers() }
})

test('with desktop alerts undecided and a P0 waiting the strip offers to enable them', async () => {
  const request = vi.fn().mockResolvedValue('granted')
  class FakeNotification { static permission = 'default'; static requestPermission = request }
  vi.stubGlobal('Notification', FakeNotification)
  await open('sre')
  expect(screen.queryByRole('button', { name: 'Enable desktop alerts' })).toBeNull()  // nothing waiting yet
  emit(created())
  await userEvent.click(await screen.findByRole('button', { name: 'Enable desktop alerts' }))
  expect(request).toHaveBeenCalledTimes(1)
})

test('once permission is decided the enable button is not shown', async () => {
  class FakeNotification { static permission = 'granted' }
  vi.stubGlobal('Notification', FakeNotification)
  await open('sre')
  emit(created())
  await screen.findByRole('button', { name: '1 new P0' })
  expect(screen.queryByRole('button', { name: 'Enable desktop alerts' })).toBeNull()
})

test('the status details read API OK when the API is fine', async () => {
  await open('sre')
  await waitFor(() => expect(api.fetchHealth).toHaveBeenCalled())
  expect(await openStatus()).toHaveProperty('textContent', expect.stringContaining('API OK'))
})

test.each([
  [{ status: 'degraded' }, 'API degraded'],
])('the pill reads %j as %s', async (health, label) => {
  api.fetchHealth.mockResolvedValue(health)
  await open('sre')
  expect(await screen.findByText(label)).toBeTruthy()
})

test('an unreachable health endpoint reads API unreachable on the pill', async () => {
  api.fetchHealth.mockRejectedValue(new Error('down'))
  await open('sre')
  expect(await screen.findByText('API unreachable')).toBeTruthy()
})

describe('Resolve with undo', () => {
  // The session restore needs real timers; the 5 s window is then driven by fake ones.
  const resolveNow = async () => {
    window.history.replaceState(null, '', '/?incident=abc')
    await open('sre')
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'mock resolve' }))
  }
  const wait = (ms) => act(async () => { vi.advanceTimersByTime(ms) })
  afterEach(() => { vi.useRealTimers() })

  test('nothing is sent until 5 seconds are up, then it is sent once', async () => {
    api.updateStatus.mockResolvedValue({ status: 'RESOLVED' })
    await resolveNow()
    expect(screen.getByText('Resolving RDBMS_X in 5 s')).toBeTruthy()
    expect(screen.getByText('mock resolving')).toBeTruthy()
    await wait(4900)
    expect(api.updateStatus).not.toHaveBeenCalled()
    await wait(200)
    expect(api.updateStatus).toHaveBeenCalledTimes(1)
    expect(api.updateStatus).toHaveBeenCalledWith('abc', 'RESOLVED', 'Failed over')
    expect(screen.getByText('Moved to RESOLVED')).toBeTruthy()
    expect(screen.queryByText('mock resolving')).toBeNull()
  })

  test('Undo before then means it is never sent', async () => {
    await resolveNow()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByText('Resolving RDBMS_X in 5 s')).toBeNull()
    expect(screen.queryByText('mock resolving')).toBeNull()
    await wait(10_000)
    expect(api.updateStatus).not.toHaveBeenCalled()
  })

  test('the pending resolve survives switching to another incident', async () => {
    api.updateStatus.mockResolvedValue({ status: 'RESOLVED' })
    await resolveNow()
    act(() => { window.history.pushState(null, '', '/?incident=other'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByTestId('detail').textContent).toBe('other')
    expect(screen.queryByText('mock resolving')).toBeNull()  // the flag belongs to abc, not to this incident
    await wait(5100)
    expect(api.updateStatus).toHaveBeenCalledWith('abc', 'RESOLVED', 'Failed over')
  })

  test('a failed resolve shows an error toast', async () => {
    api.updateStatus.mockRejectedValue({ response: { status: 409, data: { detail: 'Lost race' } } })
    await resolveNow()
    await wait(5100)
    expect(screen.getByText('Lost race').closest('.toast').dataset.kind).toBe('error')
  })

  test('logging out inside the window cancels it', async () => {
    api.logout.mockResolvedValue({})
    await resolveNow()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Account menu/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' })) })
    await wait(10_000)
    expect(api.updateStatus).not.toHaveBeenCalled()
  })
})

// ---- UX step 4: phone push view ----

test('with an incident open there is a "Back to incidents" button that clears the selection', async () => {
  window.history.replaceState(null, '', '/?incident=abc')
  await open('sre')
  expect(document.querySelector('.split').dataset.selected).toBe('true')
  await userEvent.click(screen.getByRole('button', { name: 'Back to incidents' }))
  expect(screen.getByTestId('detail').textContent).toBe('null')
  expect(window.location.search).toBe('')
  expect(document.querySelector('.split').dataset.selected).toBe('false')
  expect(screen.queryByRole('button', { name: 'Back to incidents' })).toBeNull()
})

test('Back returns focus to the row that was open', async () => {
  window.history.replaceState(null, '', '/?incident=p2-1')
  api.fetchWorkItems.mockResolvedValue({ items: [p2()], next_cursor: null })
  await open('sre')
  const row = await screen.findByRole('button', { name: /CACHE_P2/ })
  await userEvent.click(screen.getByRole('button', { name: 'Back to incidents' }))
  expect(document.activeElement).toBe(row)
})

// ---- UX step 5: Inject is a dev tool (now in the account menu) ----

test('Inject opens from the account menu', async () => {
  await open('sre')
  await pickMenu('Inject')
  expect(screen.getByRole('heading', { name: 'Signal injector' })).toBeTruthy()
})

describe('second critique: App', () => {
  test('the list filters survive a tab switch', async () => {
    await open('sre')
    await userEvent.click(screen.getByRole('button', { name: 'Closed' }))
    expect(screen.getByRole('button', { name: 'Closed' }).getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'Analytics' }))
    await userEvent.click(screen.getByRole('button', { name: 'Incidents' }))
    expect(screen.getByRole('button', { name: 'Closed' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe('false')
  })

  test('the tab title names the open incident, and keeps the unseen-P0 count in front', async () => {
    window.history.replaceState(null, '', '/?incident=abc')
    await open('sre')
    await waitFor(() => expect(document.title).toBe('COMP_abc · Nullify'))
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    emit(created())
    await waitFor(() => expect(document.title).toBe('(1) COMP_abc · Nullify'))
  })

  test('the title goes back to the app name on another tab', async () => {
    window.history.replaceState(null, '', '/?incident=abc')
    await open('sre')
    await waitFor(() => expect(document.title).toBe('COMP_abc · Nullify'))
    await userEvent.click(screen.getByRole('button', { name: 'Analytics' }))
    expect(document.title).toBe('Nullify')
  })

  test.each([['Analytics', 'Analytics'], ['Account', 'Account'], ['Inject', 'Signal injector']])('the %s page has a level-1 title', async (tab, title) => {
    await open('sre')
    if (tab === 'Analytics') await userEvent.click(screen.getByRole('button', { name: tab }))
    else await pickMenu(tab)
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy()
  })
})

describe('third critique: palette actions', () => {
  const openPalette = async () => {
    await userEvent.keyboard('{Control>}k{/Control}')
    return screen.findByRole('dialog', { name: 'Command palette' })
  }
  const choose = (name) => userEvent.click(screen.getByRole('option', { name }))
  const atIncident = async (status = 'OPEN') => {
    mockDetail.status = status
    window.history.replaceState(null, '', '/?incident=abc')
    await open('sre')
    await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('abc'))
    await openPalette()
  }

  test('Start investigating calls updateStatus and toasts that it was assigned to you', async () => {
    api.updateStatus.mockResolvedValue({ id: 'abc', status: 'INVESTIGATING', assignee_id: 'u1' })
    await atIncident('OPEN')
    await choose('Start investigating COMP_abc')
    expect(api.updateStatus).toHaveBeenCalledWith('abc', 'INVESTIGATING')
    expect(await screen.findByText('Investigating · assigned to you')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
  })

  test('Start investigating on an incident that stays unowned gets the plain toast, and a failure toasts the error', async () => {
    api.updateStatus.mockResolvedValueOnce({ id: 'abc', status: 'INVESTIGATING', assignee_id: null })
    await atIncident('OPEN')
    await choose('Start investigating COMP_abc')
    expect(await screen.findByText('Moved to INVESTIGATING')).toBeTruthy()
  })

  test('a failed Start investigating shows an error toast', async () => {
    api.updateStatus.mockRejectedValue({ response: { status: 409, data: { detail: 'Lost race' } } })
    await atIncident('OPEN')
    await choose('Start investigating COMP_abc')
    expect((await screen.findByText('Lost race')).closest('.toast').dataset.kind).toBe('error')
  })

  test('Assign to me assigns the signed-in user and toasts', async () => {
    api.assignWorkItem.mockResolvedValue({ id: 'abc', assignee_id: 'u1', assignee_username: 'me' })
    await atIncident('INVESTIGATING')
    await choose('Assign COMP_abc to me')
    expect(api.assignWorkItem).toHaveBeenCalledWith('abc', 'u1')
    expect(await screen.findByText('Assigned to you')).toBeTruthy()
  })

  test('Mark resolved asks the open pane for a resolution note, and nothing is sent yet', async () => {
    await atIncident('INVESTIGATING')
    await choose('Mark resolved COMP_abc')
    expect(screen.getByText('mock note asked')).toBeTruthy()
    expect(screen.queryByText('Resolving COMP_abc in 5 s')).toBeNull()
    expect(api.updateStatus).not.toHaveBeenCalled()
  })

  test('Copy link writes the incident URL and toasts', async () => {
    const writeText = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await atIncident('CLOSED')
    await choose('Copy link to COMP_abc')
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?incident=abc`)
    expect(await screen.findByText('Link copied')).toBeTruthy()
  })

  test('no incident actions on another tab, even with an incident in the URL', async () => {
    window.history.replaceState(null, '', '/?incident=abc')
    await open('sre')
    await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('abc'))
    await userEvent.click(screen.getByRole('button', { name: 'Analytics' }))
    await openPalette()
    expect(screen.queryByRole('group', { name: 'This incident' })).toBeNull()
  })

  describe('Open next critical', () => {
    // sla_deadline decides the order: the most overdue P0 comes first, so the list reads a, b, c
    const crit = (id, hoursLate) => p0({ id, component: `P0_${id}`, sla_deadline: new Date(Date.now() - hoursLate * 3_600_000).toISOString() })
    const current = () => new URLSearchParams(window.location.search).get('incident')

    test('goes down the critical incidents in list order and wraps to the first after the last', async () => {
      api.fetchWorkItems.mockResolvedValue({ items: [crit('c', 1), crit('a', 3), crit('b', 2)], next_cursor: null })
      await open('sre')
      await waitFor(() => expect(current()).toBe('a'))  // auto-select still opens the top one
      for (const expected of ['b', 'c', 'a']) {
        await openPalette()
        await choose('Open next critical')
        await waitFor(() => expect(current()).toBe(expected))
      }
    })

    test('is hidden when there is no other critical incident', async () => {
      api.fetchWorkItems.mockResolvedValue({ items: [crit('a', 1), p2()], next_cursor: null })
      await open('sre')
      await waitFor(() => expect(current()).toBe('a'))
      await openPalette()
      expect(screen.queryByRole('option', { name: 'Open next critical' })).toBeNull()
    })

    test('from a non-critical incident it opens the first critical one', async () => {
      window.history.replaceState(null, '', '/?incident=p2-1')
      api.fetchWorkItems.mockResolvedValue({ items: [crit('a', 3), crit('b', 2), p2()], next_cursor: null })
      await open('sre')
      await screen.findByRole('button', { name: /P0_a/ })
      await openPalette()
      await choose('Open next critical')
      await waitFor(() => expect(current()).toBe('a'))
    })
  })
})

describe('fourth critique: live feed status', () => {
  const stripState = () => within(document.querySelector('.status-area')).getByRole('status')
  const report = (status) => act(() => useWebSocket.mock.calls.at(-1)[2](status))

  test('the status pill says Connecting before the socket has authenticated, then Live after auth_ok', async () => {
    await open('sre')
    expect(stripState().textContent).toBe('Connecting…')
    report('live')
    expect(stripState().textContent).toBe('Live')
  })

  test('a dropped socket reads Reconnecting until it is live again, and the details warn events may be missed', async () => {
    await open('sre')
    report('live')
    report('reconnecting')
    expect(stripState().textContent).toBe('Reconnecting…')
    expect((await openStatus()).textContent).toContain('Reconnecting · events may be missed')
    await userEvent.keyboard('{Escape}')  // an open popover hides the page behind it from the accessibility tree
    report('live')
    expect(stripState().textContent).toBe('Live')
  })
})

describe('fourth critique: Analytics tiles navigate', () => {
  const openAnalytics = async (open_by_priority) => {
    api.fetchSLA.mockResolvedValue({ total: 9, breached: 1, breach_rate_pct: 11, open_by_priority })
    await open('sre')
    await userEvent.click(screen.getByRole('button', { name: 'Closed' }))  // the list is somewhere else than the tile will send us
    await userEvent.click(screen.getByRole('button', { name: 'Analytics' }))
  }

  test('"Show N open incidents" lands on Incidents with ACTIVE pressed and no priority', async () => {
    await openAnalytics({ P0: 2, P1: 1, P2: 0, P3: 0 })
    await userEvent.click(await screen.findByRole('button', { name: 'Show 3 open incidents' }))
    expect(screen.getByRole('button', { name: 'Incidents' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy()  // no priority (or anything else) filtered
  })

  test('"Show N open P0 incidents" lands on ACTIVE with the P0 priority', async () => {
    await openAnalytics({ P0: 2, P1: 1, P2: 0, P3: 0 })
    await userEvent.click(await screen.findByRole('button', { name: 'Show 2 open P0 incidents' }))
    expect(screen.getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Filters: P0' })).toBeTruthy()
  })

  test('leftover search and Assigned to me do not hide what the tile counted', async () => {
    api.fetchSLA.mockResolvedValue({ total: 9, breached: 1, breach_rate_pct: 11, open_by_priority: { P0: 1, P1: 0, P2: 0, P3: 0 } })
    await open('sre')
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search components' }), 'zzz')
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Assigned to me' }))
    await userEvent.keyboard('{Escape}')  // a checkbox item keeps the menu open
    expect(screen.getByRole('button', { name: 'Filters: assigned to me' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Analytics' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show 1 open incident' }))
    expect(screen.getByRole('searchbox', { name: 'Search components' }).value).toBe('')
    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy()
  })
})

describe('deselecting the open incident', () => {
  const p2Row = () => ({ items: [{ id: 'p2-1', component: 'CACHE_P2', priority: 'P2', status: 'OPEN', title: 't', created_at: new Date().toISOString() }], next_cursor: null })

  test('Escape clears the open incident and puts focus back on its row', async () => {
    window.history.replaceState(null, '', '/?incident=p2-1')
    api.fetchWorkItems.mockResolvedValue(p2Row())
    await open('sre')
    const row = await screen.findByRole('button', { name: /CACHE_P2/ })
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('detail').textContent).toBe('null')
    expect(window.location.search).toBe('')
    expect(document.activeElement).toBe(row)
  })

  test('Escape while typing in a field leaves the incident open', async () => {
    window.history.replaceState(null, '', '/?incident=abc')
    await open('sre')
    await userEvent.click(screen.getByRole('searchbox', { name: 'Search components' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('detail').textContent).toBe('abc')
  })

  test('Escape in the command palette closes the palette only', async () => {
    window.history.replaceState(null, '', '/?incident=abc')
    await open('sre')
    await userEvent.keyboard('{Control>}k{/Control}')
    await screen.findByRole('dialog', { name: 'Command palette' })
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    expect(screen.getByTestId('detail').textContent).toBe('abc')
  })

  test("the pane's deselect control clears the selection", async () => {
    window.history.replaceState(null, '', '/?incident=abc')
    await open('sre')
    await userEvent.click(screen.getByRole('button', { name: 'mock deselect' }))
    expect(screen.getByTestId('detail').textContent).toBe('null')
  })
})
