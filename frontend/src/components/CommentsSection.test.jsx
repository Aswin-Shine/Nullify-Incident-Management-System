import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommentsSection } from './CommentsSection'
import * as api from '../api/client'
import { httpError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), fetchComments: vi.fn(), addComment: vi.fn() }))

beforeEach(() => { vi.resetAllMocks() })

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

test('a failed post shows an error and keeps the text', async () => {
  api.fetchComments.mockResolvedValue([])
  api.addComment.mockRejectedValue(httpError(403, 'Nope'))
  render(<CommentsSection wiId="wi-1" />)
  await userEvent.type(await screen.findByRole('textbox'), 'hello')
  await userEvent.click(screen.getByRole('button', { name: 'Post' }))
  expect(await screen.findByText(/Nope/)).toBeTruthy()
  expect(screen.getByRole('textbox').value).toBe('hello')
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
