import { render, screen } from '@testing-library/react'
import App from './App'
import * as api from './api/client'

vi.mock('./hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }))
vi.mock('./api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), fetchWorkItems: vi.fn(), fetchHealth: vi.fn(), listUsers: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchWorkItems.mockResolvedValue({ items: [], next_cursor: null })
  api.fetchHealth.mockResolvedValue({ status: 'ok' })
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
