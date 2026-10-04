import { render, screen } from '@testing-library/react'
import { HealthBar } from './HealthBar'
import * as api from '../api/client'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), fetchHealth: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchHealth.mockResolvedValue({ status: 'ok', queue_depth: 0, queue_capacity: 50000 })
})

const renderBar = async (props) => {
  const view = render(<HealthBar {...props} />)
  await screen.findByText('API OK')
  return view
}

test.each([
  ['live', 'LIVE'],
  ['connecting', 'CONNECTING…'],
  ['reconnecting', 'RECONNECTING · events may be missed'],
])('feed %s reads %s in a status region', async (feed, text) => {
  await renderBar({ feed })
  expect(screen.getByRole('status').textContent).toBe(text)
})

test('the feed defaults to connecting', async () => {
  await renderBar({})
  expect(screen.getByRole('status').textContent).toBe('CONNECTING…')
})

test('the status region carries the state so only a lost feed is styled as a problem', async () => {
  const { rerender } = await renderBar({ feed: 'live' })
  expect(screen.getByRole('status').dataset.state).toBe('live')
  rerender(<HealthBar feed="reconnecting" />)
  expect(screen.getByRole('status').dataset.state).toBe('reconnecting')
})

test('the idle line says the feed is live, and only when it is', async () => {
  const { rerender } = await renderBar({ feed: 'live' })
  expect(screen.getByText('Live · no new signals')).toBeTruthy()
  expect(screen.queryByText('Waiting for signals')).toBeNull()
  for (const feed of ['connecting', 'reconnecting']) {
    rerender(<HealthBar feed={feed} />)
    expect(screen.queryByText('Live · no new signals')).toBeNull()
    expect(screen.queryByText('Waiting for signals')).toBeNull()
  }
})

test('with events the feed lists them and has no idle line, even while reconnecting', async () => {
  await renderBar({ feed: 'reconnecting', liveEvents: ['signal → CACHE_1', 'status → RESOLVED'] })
  expect(screen.getByText('signal → CACHE_1')).toBeTruthy()
  expect(screen.queryByText('Live · no new signals')).toBeNull()
})
