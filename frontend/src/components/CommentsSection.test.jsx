import { render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommentsSection } from './CommentsSection'
import { ToastProvider } from './Toaster'
import * as api from '../api/client'
import { httpError } from '../test/utils'

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
  expect(order[2]).toContain('e2e_sre changed status OPEN -> INVESTIGATING')
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
