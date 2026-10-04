import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HealthBar } from './HealthBar'
import * as api from '../api/client'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), fetchHealth: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchHealth.mockResolvedValue({ status: 'ok', queue_depth: 1200, queue_capacity: 50000 })
})

const renderPill = async (props) => {
  const view = render(<HealthBar {...props} />)
  await waitFor(() => expect(api.fetchHealth).toHaveBeenCalled())
  return view
}
// The details live in a popover behind the pill.
const openDetails = async () => {
  await userEvent.click(screen.getByRole('button', { name: /System status/ }))
  return screen.findByRole('dialog', { name: 'System status' })
}

test.each([
  ['live', 'Live'],
  ['connecting', 'Connecting…'],
  ['reconnecting', 'Reconnecting…'],
])('feed %s reads %s in the pill\'s status region', async (feed, text) => {
  await renderPill({ feed })
  expect(screen.getByRole('status').textContent).toBe(text)
})

test('the feed defaults to connecting', async () => {
  await renderPill({})
  expect(screen.getByRole('status').textContent).toBe('Connecting…')
})

test('the status region carries the state so only a lost feed is styled as a problem', async () => {
  const { rerender } = await renderPill({ feed: 'live' })
  expect(screen.getByRole('status').dataset.state).toBe('live')
  rerender(<HealthBar feed="reconnecting" />)
  expect(screen.getByRole('status').dataset.state).toBe('reconnecting')
})

test('the pill names an API problem without opening anything, and says nothing extra when the API is fine', async () => {
  const { unmount } = await renderPill({ feed: 'live' })
  expect(screen.queryByText(/API (unreachable|degraded)/)).toBeNull()
  unmount()
  api.fetchHealth.mockRejectedValue(new Error('down'))
  await renderPill({ feed: 'live' })
  expect(await screen.findByText('API unreachable')).toBeTruthy()
})

test('the details show the API state, the queue and the feed, with the reconnect warning', async () => {
  await renderPill({ feed: 'reconnecting' })
  const details = await openDetails()
  expect(details.textContent).toContain('API OK')
  expect(details.textContent).toContain('1,200 / 50,000')
  expect(details.textContent).toContain('Reconnecting · events may be missed')
})

test('the idle line says the feed is live, and only when it is', async () => {
  const { unmount } = await renderPill({ feed: 'live' })
  expect((await openDetails()).textContent).toContain('No new signals')
  unmount()
  await renderPill({ feed: 'connecting' })
  expect((await openDetails()).textContent).not.toContain('No new signals')
})

test('with events the details list them, newest first, and have no idle line', async () => {
  await renderPill({ feed: 'live', liveEvents: ['signal → CACHE_1', 'status → RESOLVED'] })
  const items = [...(await openDetails()).querySelectorAll('li')].map(li => li.textContent)
  expect(items).toEqual(['signal → CACHE_1', 'status → RESOLVED'])
  expect(screen.queryByText('No new signals')).toBeNull()
})
