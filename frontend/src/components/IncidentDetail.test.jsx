import { screen, act, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IncidentDetail } from './IncidentDetail'
import * as api from '../api/client'
import { renderAs, deferred, workItem, httpError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), fetchWorkItem: vi.fn(), fetchSignals: vi.fn(), fetchRCA: vi.fn(),
  updateStatus: vi.fn(), assignWorkItem: vi.fn(), listUsers: vi.fn(), fetchComments: vi.fn(),
  addComment: vi.fn(), submitRCA: vi.fn(), fetchHistory: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchWorkItem.mockResolvedValue(workItem())
  api.fetchSignals.mockResolvedValue([])
  api.fetchRCA.mockResolvedValue(null)
  api.fetchComments.mockResolvedValue([])
  api.fetchHistory.mockResolvedValue([])
  api.listUsers.mockResolvedValue([{ id: 'u2', username: 'bob', role: 'sre' }])
})

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })

test('the header shows the component name (F-03)', async () => {
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect(await screen.findByRole('heading', { name: 'RDBMS_PRIMARY' })).toBeTruthy()
})

test('the signals toggle is a button that reveals message and relative time (F-04, F-08, F-25)', async () => {
  api.fetchSignals.mockResolvedValue([
    { id: 's1', timestamp: new Date(Date.now() - 5 * 60_000).toISOString(), message: 'conn refused', severity: 'CRITICAL' },
  ])
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  const toggle = await screen.findByRole('button', { name: /Signals/ })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await userEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('conn refused')).toBeTruthy()
  expect(screen.getByText(/minutes ago/)).toBeTruthy()
})

test('a viewer sees the assignee but no mutation controls and no user list call (F-11, F-29)', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ assignee_id: 'u2', assignee_username: 'alice' }))
  await renderAs('viewer', <IncidentDetail id="wi-1" />)
  expect(await screen.findByText('alice')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Start Investigating/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Submit RCA' })).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(api.listUsers).not.toHaveBeenCalled()
})

test('a rejected transition shows an error toast with the server detail, not an inline note (F-11)', async () => {
  api.updateStatus.mockRejectedValue(httpError(409, 'Lost race'))
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: /Start Investigating/ }))
  const toast = (await screen.findByText(/Lost race/)).closest('.toast')
  expect(toast).not.toBeNull()
  expect(toast.dataset.kind).toBe('error')
  expect(container.querySelector('.detail-card .error-note')).toBeNull()
})

test('a successful status change shows a success toast', async () => {
  api.updateStatus.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: /Start Investigating/ }))
  const toast = (await screen.findByText('Moved to INVESTIGATING')).closest('.toast')
  expect(toast.dataset.kind).toBe('success')
})

test('assigning and unassigning show toasts', async () => {
  api.assignWorkItem.mockResolvedValueOnce(workItem({ assignee_id: 'u2', assignee_username: 'bob' }))
    .mockResolvedValueOnce(workItem())
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  const select = await screen.findByRole('combobox', { name: 'Assign to' })
  await waitFor(() => expect(within(select).getByText(/bob/)).toBeTruthy())
  await userEvent.selectOptions(select, 'u2')
  expect(await screen.findByText('Assigned to bob')).toBeTruthy()
  await userEvent.selectOptions(select, '')
  expect(await screen.findByText('Incident unassigned')).toBeTruthy()
})

test('a failed assignment shows an error toast', async () => {
  api.assignWorkItem.mockRejectedValue(httpError(422, 'Assignee not found'))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  const select = await screen.findByRole('combobox', { name: 'Assign to' })
  await waitFor(() => expect(within(select).getByText(/bob/)).toBeTruthy())
  await userEvent.selectOptions(select, 'u2')
  expect((await screen.findByText('Assignee not found')).closest('.toast').dataset.kind).toBe('error')
})

test('a successful transition renders the response without refetching (F-17)', async () => {
  api.updateStatus.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: /Start Investigating/ }))
  expect(await screen.findByText('INVESTIGATING')).toBeTruthy()
  expect(api.fetchWorkItem).toHaveBeenCalledTimes(1)
})

test('switching incidents never shows the previous incident (F-12)', async () => {
  const a = deferred()
  api.fetchWorkItem.mockImplementation((id) =>
    id === 'A' ? a.promise : Promise.resolve(workItem({ id: 'B', component: 'COMP_B' })))
  const { rerender } = await renderAs('sre', <IncidentDetail id="A" />)
  rerender(<IncidentDetail id="B" />)
  expect(await screen.findByRole('heading', { name: 'COMP_B' })).toBeTruthy()
  await act(async () => { a.resolve(workItem({ id: 'A', component: 'COMP_A' })) })
  expect(screen.queryByText('COMP_A')).toBeNull()
})

test('a new refreshTick refetches the incident (F-28)', async () => {
  const { rerender } = await renderAs('sre', <IncidentDetail id="wi-1" refreshTick={0} />)
  await screen.findByRole('heading', { name: 'RDBMS_PRIMARY' })
  expect(api.fetchWorkItem).toHaveBeenCalledTimes(1)
  rerender(<IncidentDetail id="wi-1" refreshTick={1} />)
  await waitFor(() => expect(api.fetchWorkItem).toHaveBeenCalledTimes(2))
})

test('the RCA is fetched once per incident (F-30)', async () => {
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await screen.findByText('Root Cause Analysis')
  await settle()
  expect(api.fetchRCA).toHaveBeenCalledTimes(1)
})

test('the assignee select has a name so browsers and password managers can identify it', async () => {
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect(await screen.findByRole('combobox', { name: 'Assign to' })).toHaveProperty('name', 'assignee')
})

test('an SRE sees the select preselected to the current assignee, and can unassign', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ assignee_id: 'u2', assignee_username: 'bob' }))
  api.assignWorkItem.mockResolvedValue(workItem())
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  const select = await screen.findByRole('combobox', { name: 'Assign to' })
  await waitFor(() => expect(select.value).toBe('u2'))
  await userEvent.selectOptions(select, 'Unassigned')
  expect(api.assignWorkItem).toHaveBeenCalledWith('wi-1', null)
})

test('viewer-role users are not offered as assignees', async () => {
  api.listUsers.mockResolvedValue([
    { id: 'u2', username: 'bob', role: 'sre' },
    { id: 'u3', username: 'carol', role: 'viewer' },
    { id: 'u4', username: 'root', role: 'admin' },
  ])
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  const select = await screen.findByRole('combobox', { name: 'Assign to' })
  await waitFor(() => expect(within(select).getByText(/bob/)).toBeTruthy())
  expect(within(select).queryByText(/carol/)).toBeNull()
  expect(within(select).getByText(/root/)).toBeTruthy()
})

test('a viewer still sees the assignee as text, not a select', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ assignee_id: 'u2', assignee_username: 'bob' }))
  await renderAs('viewer', <IncidentDetail id="wi-1" />)
  expect(await screen.findByText('bob')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Assign to' })).toBeNull()
})

test('switching incidents gives a fresh RCA form with that incident\'s own times (no carried-over text)', async () => {
  const a = workItem({ id: 'wi-a', start_time: '2026-03-04T10:00:00.000Z', last_signal_at: '2026-03-04T10:30:00.000Z' })
  const b = workItem({ id: 'wi-b', component: 'CACHE_B', start_time: '2026-03-05T08:00:00.000Z', last_signal_at: '2026-03-05T09:00:00.000Z' })
  api.fetchWorkItem.mockImplementation(async (id) => (id === 'wi-a' ? a : b))
  const { rerender } = await renderAs('sre', <IncidentDetail id="wi-a" />)
  await userEvent.type(await screen.findByLabelText('Fix Applied'), 'typed for A')
  expect(new Date(screen.getByLabelText('Impact Start').value).toISOString()).toBe(a.start_time)
  rerender(<IncidentDetail id="wi-b" />)
  await screen.findByRole('heading', { name: 'CACHE_B' })
  await waitFor(() => expect(screen.getByLabelText('Fix Applied').value).toBe(''))
  expect(new Date(screen.getByLabelText('Impact Start').value).toISOString()).toBe(b.start_time)
})

test('Copy link writes the incident URL to the clipboard and toasts', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  await renderAs('viewer', <IncidentDetail id="wi-1" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
  expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?incident=wi-1`)
  expect(await screen.findByText('Link copied')).toBeTruthy()
})

test('a clipboard that refuses the write shows an error toast', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('denied'))
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  await renderAs('viewer', <IncidentDetail id="wi-1" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
  const toast = (await screen.findByText('Could not copy the link')).closest('.toast')
  expect(toast.dataset.kind).toBe('error')
})
