import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommentsSection } from './CommentsSection'
import { ToastProvider } from './Toaster'
import * as api from '../api/client'
import { httpError } from '../test/utils'
import { fmtStamp } from '../format'

vi.mock('../api/client', async (orig) => ({
  ...(await orig()), fetchComments: vi.fn(), addComment: vi.fn(), fetchHistory: vi.fn(),
}))

const render = (ui) => rtlRender(<ToastProvider>{ui}</ToastProvider>)
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
const event = (over) => ({ id: 'e', kind: 'status', from_value: null, to_value: null, actor_username: 'e2e_sre', created_at: ago(1), ...over })

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchHistory.mockResolvedValue([])
})

test('the author shows the real username (F-05)', async () => {
  api.fetchComments.mockResolvedValue([
    { id: 'c1', author_username: 'alice', body: 'restarting', created_at: new Date().toISOString() },
  ])
  render(<CommentsSection wiId="wi-1" />)
  expect(await screen.findByText('alice')).toBeTruthy()
})

test('the composer is a form with a labelled textarea (F-09, F-10)', async () => {
  api.fetchComments.mockResolvedValue([])
  const { container } = render(<CommentsSection wiId="wi-1" />)
  expect(await screen.findByLabelText(/comment/i)).toBeTruthy()
  expect(container.querySelector('form')).not.toBeNull()
})

test('a failed post shows an error toast and keeps the text', async () => {
  api.fetchComments.mockResolvedValue([])
  api.addComment.mockRejectedValue(httpError(403, 'Nope'))
  render(<CommentsSection wiId="wi-1" />)
  await userEvent.type(await screen.findByRole('textbox'), 'hello')
  await userEvent.click(screen.getByRole('button', { name: 'Post' }))
  expect((await screen.findByText(/Nope/)).closest('.toast').dataset.kind).toBe('error')
  expect(screen.getByRole('textbox').value).toBe('hello')
})

test('a posted comment shows a success toast and clears the box', async () => {
  api.fetchComments.mockResolvedValue([])
  api.addComment.mockResolvedValue({})
  render(<CommentsSection wiId="wi-1" />)
  await userEvent.type(await screen.findByRole('textbox'), 'hello')
  await userEvent.click(screen.getByRole('button', { name: 'Post' }))
  expect((await screen.findByText('Comment posted')).closest('.toast').dataset.kind).toBe('success')
  expect(screen.getByRole('textbox').value).toBe('')
})

test('Ctrl+Enter posts', async () => {
  api.fetchComments.mockResolvedValue([])
  api.addComment.mockResolvedValue({})
  render(<CommentsSection wiId="wi-1" />)
  await userEvent.type(await screen.findByRole('textbox'), 'hello{Control>}{Enter}{/Control}')
  expect(api.addComment).toHaveBeenCalledWith('wi-1', 'hello')
})

test('the comment textarea has a name', async () => {
  api.fetchComments.mockResolvedValue([])
  render(<CommentsSection wiId="wi-1" />)
  expect((await screen.findByLabelText(/comment/i)).getAttribute('name')).toBe('comment')
})

test('comments and history events are merged in time order', async () => {
  api.fetchComments.mockResolvedValue([
    { id: 'c1', author_username: 'alice', body: 'restarting now', created_at: ago(5) },
  ])
  api.fetchHistory.mockResolvedValue([
    event({ id: 'e1', kind: 'created', actor_username: null, to_value: 'P0', created_at: ago(10) }),
    event({ id: 'e2', kind: 'status', from_value: 'OPEN', to_value: 'INVESTIGATING', created_at: ago(2) }),
  ])
  const { container } = render(<CommentsSection wiId="wi-1" />)
  await screen.findByText('restarting now')
  await screen.findByText('System opened the incident (P0)')
  const order = [...container.querySelectorAll('.timeline-items > *')].map(n => n.textContent)
  expect(order).toHaveLength(3)
  expect(order[0]).toContain('System opened the incident (P0)')
  expect(order[1]).toContain('restarting now')
  expect(order[2]).toContain('e2e_sre changed status OPEN → INVESTIGATING')
})

test('every event kind reads as one line', async () => {
  api.fetchComments.mockResolvedValue([])
  api.fetchHistory.mockResolvedValue([
    event({ id: 'a', kind: 'assigned', from_value: null, to_value: 'bob', created_at: ago(4) }),
    event({ id: 'b', kind: 'assigned', from_value: 'bob', to_value: null, created_at: ago(3) }),
    event({ id: 'c', kind: 'rca_submitted', created_at: ago(2) }),
  ])
  render(<CommentsSection wiId="wi-1" />)
  expect(await screen.findByText('e2e_sre assigned to bob')).toBeTruthy()
  expect(screen.getByText('e2e_sre unassigned')).toBeTruthy()
  expect(screen.getByText('e2e_sre submitted the RCA')).toBeTruthy()
})

test('the count chip counts comments and events together', async () => {
  api.fetchComments.mockResolvedValue([{ id: 'c1', author_username: 'alice', body: 'hi', created_at: ago(5) }])
  api.fetchHistory.mockResolvedValue([event({ id: 'e1', kind: 'rca_submitted' })])
  render(<CommentsSection wiId="wi-1" />)
  await screen.findByText('hi')
  expect(document.querySelector('.count-chip').textContent).toBe('2')
})

test('each entry shows an absolute stamp, with the relative time in the tooltip', async () => {
  const at = ago(125)
  api.fetchComments.mockResolvedValue([{ id: 'c1', author_username: 'alice', body: 'on it', created_at: at }])
  api.fetchHistory.mockResolvedValue([event({ id: 'e1', kind: 'rca_submitted', created_at: at })])
  const { container } = render(<CommentsSection wiId="wi-1" />)
  await screen.findByText('on it')
  const times = [...container.querySelectorAll('.comment-time')]
  expect(times).toHaveLength(2)
  for (const t of times) {
    expect(t.textContent).toBe(fmtStamp(at))
    expect(t.getAttribute('title')).toMatch(/2 hours ago/)
  }
})

test('an empty timeline says there is no activity, since history events count as activity', async () => {
  api.fetchComments.mockResolvedValue([])
  render(<CommentsSection wiId="wi-1" />)
  expect(await screen.findByText('No activity yet.')).toBeTruthy()
  expect(screen.queryByText('No comments yet.')).toBeNull()
})

test('the comment textarea stops at the backend limit and shows no counter for a short comment', async () => {
  api.fetchComments.mockResolvedValue([])
  const { container } = render(<CommentsSection wiId="wi-1" />)
  const box = await screen.findByLabelText(/comment/i)
  expect(box.maxLength).toBe(4000)
  fireEvent.change(box, { target: { value: 'x'.repeat(3500) } })
  expect(container.querySelector('.composer-count')).toBeNull()
})

test('past 3,500 characters a counter shows how close the comment is to the limit', async () => {
  api.fetchComments.mockResolvedValue([])
  const { container } = render(<CommentsSection wiId="wi-1" />)
  const box = await screen.findByLabelText(/comment/i)
  fireEvent.change(box, { target: { value: 'x'.repeat(3612) } })
  const counter = container.querySelector('.composer-count')
  expect(counter.textContent).toBe('3,612 / 4,000')
  expect(box.getAttribute('aria-describedby')).toBe(counter.id)
  fireEvent.change(box, { target: { value: 'short' } })
  expect(container.querySelector('.composer-count')).toBeNull()
  expect(box.getAttribute('aria-describedby')).toBeNull()
})

test('user text reads with dir=auto, so Arabic aligns right and emoji stay put', async () => {
  api.fetchComments.mockResolvedValue([{ id: 'c1', author_username: 'alice', body: 'مرحبا 🔥 restart', created_at: ago(5) }])
  render(<CommentsSection wiId="wi-1" />)
  expect((await screen.findByText('مرحبا 🔥 restart')).dir).toBe('auto')
})

test('a failed timeline load says why and Try again fetches both lists again', async () => {
  api.fetchComments.mockRejectedValueOnce(httpError(500, 'Internal Server Error')).mockResolvedValue([])
  render(<CommentsSection wiId="wi-1" />)
  expect(await screen.findByText(/The server hit an error/)).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('No activity yet.')).toBeTruthy()
  expect(api.fetchComments).toHaveBeenCalledTimes(2)
  expect(api.fetchHistory).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})
