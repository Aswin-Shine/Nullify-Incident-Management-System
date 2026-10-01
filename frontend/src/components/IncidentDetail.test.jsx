import { screen, act, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IncidentDetail } from './IncidentDetail'
import * as api from '../api/client'
import { renderAs, deferred, workItem, httpError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), fetchWorkItem: vi.fn(), fetchSignals: vi.fn(), fetchRCA: vi.fn(),
  updateStatus: vi.fn(), assignWorkItem: vi.fn(), listUsers: vi.fn(), fetchComments: vi.fn(),
  addComment: vi.fn(), submitRCA: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchWorkItem.mockResolvedValue(workItem())
  api.fetchSignals.mockResolvedValue([])
  api.fetchRCA.mockResolvedValue(null)
  api.fetchComments.mockResolvedValue([])
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

test('a rejected transition shows the error (F-11)', async () => {
  api.updateStatus.mockRejectedValue(httpError(409, 'Lost race'))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: /Start Investigating/ }))
  expect(await screen.findByText(/Lost race/)).toBeTruthy()
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
