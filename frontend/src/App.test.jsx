import { render, screen, act } from '@testing-library/react'
import App from './App'
import * as api from './api/client'

vi.mock('./hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }))
vi.mock('./api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), fetchWorkItems: vi.fn(), fetchHealth: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchWorkItems.mockResolvedValue([])
  api.fetchHealth.mockResolvedValue({ status: 'ok' })
})

// App brings its own AuthProvider, so sign in through the mocked refresh and render it bare.
async function open(role) {
  api.refreshSession.mockResolvedValue({ user: { id: 'u1', username: 'me', role } })
  render(<App />)
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
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
