import { screen, act, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IncidentDetail } from './IncidentDetail'
import * as api from '../api/client'
import { renderAs, deferred, workItem, httpError, networkError } from '../test/utils'
import { fmtStamp } from '../format'

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
// Signals, Activity (timeline and comments) and RCA are tabs; the default follows the state (active: Signals, finished: RCA).
const tab = (name) => screen.findByRole('tab', { name: new RegExp(`^${name}`) })
const openTab = async (name) => userEvent.click(await tab(name))

test('the header shows the component name (F-03)', async () => {
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect(await screen.findByRole('heading', { name: 'RDBMS_PRIMARY' })).toBeTruthy()
})

test('the Signals tab reveals message and relative time (F-04, F-08, F-25)', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED' }))  // resolved incidents open on the RCA tab
  api.fetchSignals.mockResolvedValue([
    { id: 's1', timestamp: new Date(Date.now() - 5 * 60_000).toISOString(), message: 'conn refused', severity: 'CRITICAL' },
  ])
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect((await tab('Signals')).getAttribute('aria-selected')).toBe('false')
  expect(container.querySelector('.signal-msg')).toBeNull()
  await openTab('Signals')
  expect((await tab('Signals')).getAttribute('aria-selected')).toBe('true')
  expect(container.querySelector('.signal-msg').textContent).toBe('conn refused')
  expect(screen.getByText(/minutes ago/)).toBeTruthy()
})

test('a viewer sees the assignee but no mutation controls and no user list call (F-11, F-29)', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ assignee_id: 'u2', assignee_username: 'alice' }))
  await renderAs('viewer', <IncidentDetail id="wi-1" />)
  expect(await screen.findByText('alice')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Start investigating/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Submit RCA' })).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(api.listUsers).not.toHaveBeenCalled()
})

test('a rejected transition shows an error toast with the server detail, not an inline note (F-11)', async () => {
  api.updateStatus.mockRejectedValue(httpError(409, 'Lost race'))
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: /Start investigating/ }))
  const toast = (await screen.findByText(/Lost race/)).closest('.toast')
  expect(toast).not.toBeNull()
  expect(toast.dataset.kind).toBe('error')
  expect(container.querySelector('.detail-card .error-note')).toBeNull()
})

test('a successful status change shows a success toast', async () => {
  api.updateStatus.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: /Start investigating/ }))
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
  await userEvent.click(await screen.findByRole('button', { name: /Start investigating/ }))
  expect(await screen.findByText('Investigating')).toBeTruthy()
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
  await screen.findByText('Root cause analysis')
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
  const a = workItem({ id: 'wi-a', status: 'INVESTIGATING', start_time: '2026-03-04T10:00:00.000Z', last_signal_at: '2026-03-04T10:30:00.000Z' })
  const b = workItem({ id: 'wi-b', status: 'INVESTIGATING', component: 'CACHE_B', start_time: '2026-03-05T08:00:00.000Z', last_signal_at: '2026-03-05T09:00:00.000Z' })
  api.fetchWorkItem.mockImplementation(async (id) => (id === 'wi-a' ? a : b))
  const { rerender } = await renderAs('sre', <IncidentDetail id="wi-a" />)
  await openTab('RCA')
  await userEvent.click(await screen.findByRole('button', { name: 'Write RCA' }))
  await userEvent.type(await screen.findByLabelText('Fix applied'), 'typed for A')
  expect(new Date(screen.getByLabelText('Impact start').value).toISOString()).toBe(a.start_time)
  rerender(<IncidentDetail id="wi-b" />)
  await screen.findByRole('heading', { name: 'CACHE_B' })
  await openTab('RCA')
  await userEvent.click(await screen.findByRole('button', { name: 'Write RCA' }))
  await waitFor(() => expect(screen.getByLabelText('Fix applied').value).toBe(''))
  expect(new Date(screen.getByLabelText('Impact start').value).toISOString()).toBe(b.start_time)
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

test('a comment draft does not follow you to the next incident (F-33)', async () => {
  api.fetchWorkItem.mockImplementation(async (id) => workItem({ id, component: id === 'wi-1' ? 'COMP_1' : 'COMP_2' }))
  const { rerender } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.type(await screen.findByLabelText('Add a comment'), 'half written')
  rerender(<IncidentDetail id="wi-2" />)
  await screen.findByRole('heading', { name: 'COMP_2' })
  expect(screen.getByLabelText('Add a comment').value).toBe('')
})

test('a chosen tab sticks for that incident only, the next one starts at its own default (F-33)', async () => {
  api.fetchWorkItem.mockImplementation(async (id) =>
    workItem({ id, status: 'INVESTIGATING', component: id === 'wi-1' ? 'COMP_1' : 'COMP_2' }))
  const { rerender } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await openTab('Activity')
  expect((await tab('Activity')).getAttribute('aria-selected')).toBe('true')
  rerender(<IncidentDetail id="wi-2" />)
  await screen.findByRole('heading', { name: 'COMP_2' })
  expect((await tab('Signals')).getAttribute('aria-selected')).toBe('true')
})

test('the signals header shows the incident\'s real count and says when the list is cut short (F-37)', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 500 }))
  api.fetchSignals.mockResolvedValue([
    { id: 's1', timestamp: new Date().toISOString(), message: 'one', severity: 'HIGH' },
    { id: 's2', timestamp: new Date().toISOString(), message: 'two', severity: 'HIGH' },
  ])
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await waitFor(async () => expect((await tab('Signals')).textContent).toBe('Signals 500'))
  expect(screen.getByText(/showing the latest 2/)).toBeTruthy()
})

test('a server error on the RCA fetch shows an error, not the empty form (F-38)', async () => {
  api.fetchRCA.mockRejectedValue(httpError(500, 'boom'))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect(await screen.findByText('Could not load the RCA')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Submit RCA' })).toBeNull()
})

test('the RCA and Timeline headings sit one level under the incident heading (F-42)', async () => {
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await openTab('RCA')
  expect(await screen.findByRole('heading', { level: 2, name: 'Root cause analysis' })).toBeTruthy()
  await openTab('Activity')
  expect(await screen.findByRole('heading', { level: 2, name: 'Timeline' })).toBeTruthy()
})

// ---- UX step 1: the pane follows the incident's state ----

const sig = (i, over = {}) => ({
  id: `s${i}`, timestamp: new Date(Date.now() - (10 - i) * 60_000).toISOString(), message: `msg ${i}`, severity: 'HIGH', ...over,
})
// The real API (list_signals) returns the latest 200 signals OLDEST first; keep this fixture in that order.
const sevenSignals = () => [1, 2, 3, 4, 5, 6, 7].map(i => sig(i))

const tabNames = () => screen.getAllByRole('tab').map(t => t.textContent.replace(/\s*[\d,]+$/, ''))

test('the sections are tabs in the order Signals, Activity, RCA, and an active incident opens on Signals', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 0 }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect((await tab('Signals')).getAttribute('aria-selected')).toBe('true')
  expect(tabNames()).toEqual(['Signals', 'Activity', 'RCA'])
  expect(screen.getByRole('tablist', { name: 'Incident sections' })).toBeTruthy()
})

test.each(['RESOLVED', 'CLOSED'])('a %s incident opens on the RCA tab', async (status) => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status, signal_count: 0 }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect((await tab('RCA')).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tabpanel').textContent).toContain('Root cause analysis')
})

test('INVESTIGATING without an RCA offers "Write RCA", which expands the form in place', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await openTab('RCA')
  const write = await screen.findByRole('button', { name: 'Write RCA' })
  expect(screen.queryByRole('button', { name: 'Submit RCA' })).toBeNull()
  await userEvent.click(write)
  expect(screen.getByRole('button', { name: 'Submit RCA' })).toBeTruthy()
  expect(screen.getByText('Needed to close the incident once it is resolved.')).toBeTruthy()
})

test('RESOLVED without an RCA shows the form straight away, with no "Write RCA" step', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED' }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect(await screen.findByRole('button', { name: 'Submit RCA' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Write RCA' })).toBeNull()
})

test('OPEN has no RCA form and no "Write RCA", only the line that says why', async () => {
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await openTab('RCA')
  expect(await screen.findByText('Start investigating to write the RCA.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Submit RCA' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Write RCA' })).toBeNull()
})

test('a viewer on INVESTIGATING gets no "Write RCA", just the read-only text', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
  await renderAs('viewer', <IncidentDetail id="wi-1" />)
  await openTab('RCA')
  expect(await screen.findByText('No RCA has been submitted yet.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Write RCA' })).toBeNull()
})

test('INVESTIGATING opens the signals without a click and shows the 5 newest, newest first', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 7 }))
  api.fetchSignals.mockResolvedValue(sevenSignals())
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect((await tab('Signals')).getAttribute('aria-selected')).toBe('true')
  await waitFor(() => expect(container.querySelectorAll('.signal-msg')).toHaveLength(5))
  expect(container.querySelector('.signal-msg').textContent).toBe('msg 7')
  expect(screen.queryByText('msg 2')).toBeNull()
})

test('"Show all 7" reveals every loaded signal', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 7 }))
  api.fetchSignals.mockResolvedValue(sevenSignals())
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Show all 7 groups' }))
  expect(container.querySelectorAll('.signal-msg')).toHaveLength(7)
  expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
})

test('RESOLVED keeps the signals behind their tab', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED', signal_count: 7 }))
  api.fetchSignals.mockResolvedValue(sevenSignals())
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect((await tab('Signals')).getAttribute('aria-selected')).toBe('false')
  expect(container.querySelector('.signal-msg')).toBeNull()
})

test('the summary shows first signal, last signal, the count and the newest message', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({
    status: 'INVESTIGATING', signal_count: 7,
    start_time: new Date(Date.now() - 3600_000).toISOString(),
    last_signal_at: new Date(Date.now() - 2 * 60_000).toISOString(),
  }))
  api.fetchSignals.mockResolvedValue(sevenSignals())
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  const summary = await waitFor(() => {
    const el = container.querySelector('.detail-summary')
    expect(el).not.toBeNull()
    return el
  })
  const dl = within(summary)
  for (const label of ['First signal', 'Last signal', 'Signals']) expect(dl.getByText(label)).toBeTruthy()
  expect(dl.getByText('Signals').nextElementSibling.textContent).toBe('7')
  expect(dl.getByText('Last signal').nextElementSibling.textContent).toMatch(/2 minutes ago/)
  expect(dl.getByText('First signal').nextElementSibling.textContent).not.toBe('-')
  await waitFor(() => expect(within(container.querySelector('.detail-card')).getByText('Latest')).toBeTruthy())
  const latest = within(container.querySelector('.detail-card')).getByText('msg 7')
  expect(latest.getAttribute('title')).toBe('msg 7')
})

test('with no signals the summary has no Latest row', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 0 }))
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await tab('Signals')
  await settle()
  expect(within(container.querySelector('.detail-card')).queryByText('Latest')).toBeNull()
})

test('the open RCA form never says "approved"', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await openTab('RCA')
  await userEvent.click(await screen.findByRole('button', { name: 'Write RCA' }))
  expect(container.querySelector('.detail').textContent).not.toMatch(/approved/i)
})

// ---- UX step 3: harden ----

const RCA_DONE = {
  incident_start: '2026-01-01T10:00:00Z', incident_end: '2026-01-01T12:00:00Z',
  root_cause_category: 'Infrastructure Failure', fix_applied: 'Restarted', prevention_steps: 'Failover',
  submitted_at: '2026-01-01T12:30:00Z',
}
const resolvedWithRca = () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED', mttr_seconds: 7200 }))
  api.fetchRCA.mockResolvedValue(RCA_DONE)
}

test('Close incident… asks first: nothing is sent, the confirm names the MTTR and says the RCA locks', async () => {
  resolvedWithRca()
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Close incident…' }))
  expect(api.updateStatus).not.toHaveBeenCalled()
  expect(screen.getByText('Close RDBMS_PRIMARY? MTTR 2.0h · Infrastructure Failure. The RCA locks once closed.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Close incident…' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
})

test('Cancel puts the Close button back and returns focus to it', async () => {
  resolvedWithRca()
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Close incident…' }))
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  const close = screen.getByRole('button', { name: 'Close incident…' })
  expect(screen.queryByText(/The RCA locks/)).toBeNull()
  expect(document.activeElement).toBe(close)
  expect(api.updateStatus).not.toHaveBeenCalled()
})

test('Escape in the confirm cancels it', async () => {
  resolvedWithRca()
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Close incident…' }))
  await userEvent.keyboard('{Escape}')
  expect(screen.getByRole('button', { name: 'Close incident…' })).toBeTruthy()
  expect(api.updateStatus).not.toHaveBeenCalled()
})

test('confirming closes once, and the toast carries the MTTR', async () => {
  resolvedWithRca()
  api.updateStatus.mockResolvedValue(workItem({ status: 'CLOSED', mttr_seconds: 7200 }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Close incident…' }))
  await userEvent.click(screen.getByRole('button', { name: 'Close incident' }))
  expect(api.updateStatus).toHaveBeenCalledTimes(1)
  expect(api.updateStatus).toHaveBeenCalledWith('wi-1', 'CLOSED')
  expect((await screen.findByText('Closed RDBMS_PRIMARY · MTTR 2.0h')).closest('.toast').dataset.kind).toBe('success')
})

test('a pending confirm does not follow you to another incident', async () => {
  api.fetchWorkItem.mockImplementation(async (id) => workItem({ id, status: 'RESOLVED', component: id === 'wi-1' ? 'COMP_1' : 'COMP_2' }))
  api.fetchRCA.mockResolvedValue(RCA_DONE)
  const { rerender } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Close incident…' }))
  rerender(<IncidentDetail id="wi-2" />)
  await screen.findByRole('heading', { name: 'COMP_2' })
  expect(screen.queryByText(/The RCA locks/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Close incident…' })).toBeTruthy()
})

test('Mark resolved hands the incident to onResolve and sends nothing itself', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
  const onResolve = vi.fn()
  await renderAs('sre', <IncidentDetail id="wi-1" onResolve={onResolve} />)
  await userEvent.click(await screen.findByRole('button', { name: 'Mark resolved' }))
  expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'wi-1', component: 'RDBMS_PRIMARY' }))
  expect(api.updateStatus).not.toHaveBeenCalled()
})

test('while a resolve is pending the button reads Resolving and is disabled', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
  await renderAs('sre', <IncidentDetail id="wi-1" resolving />)
  const btn = await screen.findByRole('button', { name: 'Resolving…' })
  expect(btn.disabled).toBe(true)
})

test('a blocked Close says why in visible text', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED' }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect(await screen.findByText('Submit the RCA to close.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Close incident…' }).disabled).toBe(true)
})

test('a blocked Close says so when the RCA could not be checked', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED' }))
  api.fetchRCA.mockRejectedValue(httpError(500, 'boom'))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  expect(await screen.findByText('Could not check the RCA.')).toBeTruthy()
})

test('an unblocked Close shows no reason line', async () => {
  resolvedWithRca()
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await screen.findByRole('button', { name: 'Close incident…' })
  expect(screen.queryByText('Submit the RCA to close.')).toBeNull()
})

test('a CLOSED incident summarises who resolved and closed it and the signals, has no Latest row and no assign select', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'CLOSED', mttr_seconds: 7200, signal_count: 1 }))
  api.fetchRCA.mockResolvedValue(RCA_DONE)
  api.fetchSignals.mockResolvedValue([{ id: 's1', timestamp: new Date().toISOString(), message: 'conn refused', severity: 'HIGH' }])
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  const summary = within(await waitFor(() => {
    const el = container.querySelector('.detail-summary')
    expect(el).not.toBeNull()
    return el
  }))
  await waitFor(() => expect(summary.getByText('Closed by')).toBeTruthy())
  expect(summary.queryByText('Root cause')).toBeNull()  // the category is in the RCA below
  expect(summary.queryByText('MTTR')).toBeNull()  // MTTR is in the completion line, once
  expect(summary.queryByText('Owner')).toBeNull()
  expect(summary.getByText('Resolved by').nextElementSibling.textContent).toBe('-')  // no history events: an incident from before 0004
  expect(summary.getByText('Closed by').nextElementSibling.textContent).toBe('-')
  expect(within(container.querySelector('.detail-card')).queryByText('Latest')).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'Assign to' })).toBeNull()
})

test('a CLOSED incident has no Owner fact, no assignee line and no action bar', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'CLOSED', assignee_id: 'u2', assignee_username: 'bob' }))
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await waitFor(() => expect(container.querySelector('.detail-summary')).not.toBeNull())
  expect(within(container.querySelector('.detail-summary')).queryByText('Owner')).toBeNull()
  expect(screen.queryByText(/Assigned to/)).toBeNull()
  expect(container.querySelector('.assignee-text')).toBeNull()
  expect(container.querySelector('.action-bar')).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'Assign to' })).toBeNull()
})

test('an incident that is not closed has no Owner fact (the action bar shows the owner)', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', assignee_id: 'u2', assignee_username: 'bob' }))
  const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await screen.findByRole('combobox', { name: 'Assign to' })
  expect(within(container.querySelector('.detail-summary')).queryByText('Owner')).toBeNull()
})

// ---- UX step 6: polish ----

test('the header shows a short id in mono with the full id in the tooltip', async () => {
  const full = '16729250-aaaa-bbbb-cccc-1234567890ab'
  api.fetchWorkItem.mockResolvedValue(workItem({ id: full }))
  await renderAs('sre', <IncidentDetail id={full} />)
  const short = await screen.findByText('#16729250')
  expect(short.title).toBe(full)
  expect(screen.queryByText(full)).toBeNull()
})

test('switching incidents scrolls the detail back to the top', async () => {
  api.fetchWorkItem.mockImplementation(async (id) => workItem({ id, component: id === 'wi-1' ? 'COMP_1' : 'COMP_2' }))
  const { container, rerender } = await renderAs('sre', <IncidentDetail id="wi-1" />)
  await screen.findByRole('heading', { name: 'COMP_1' })
  container.querySelector('.detail').scrollTop = 300
  rerender(<IncidentDetail id="wi-2" />)
  await screen.findByRole('heading', { name: 'COMP_2' })
  expect(container.querySelector('.detail').scrollTop).toBe(0)
})

describe('second critique: ownership', () => {
  test('Assign to me assigns the signed-in user, and is gone once you are the assignee', async () => {
    api.assignWorkItem.mockResolvedValue(workItem({ assignee_id: 'u1', assignee_username: 'me' }))
    await renderAs('sre', <IncidentDetail id="wi-1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Assign to me' }))
    expect(api.assignWorkItem).toHaveBeenCalledWith('wi-1', 'u1')
    expect(await screen.findByText('Assigned to me')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull())
  })

  test('Assign to me is not offered to a viewer, on a CLOSED incident, or when you already own it', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ assignee_id: 'u1', assignee_username: 'me' }))
    const { unmount } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await screen.findByRole('combobox', { name: 'Assign to' })
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull()
    unmount()
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'CLOSED' }))
    const closed = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await screen.findByText('Closed by')  // the closed card has loaded; it has no action bar at all
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull()
    closed.unmount()
    api.fetchWorkItem.mockResolvedValue(workItem())
    await renderAs('viewer', <IncidentDetail id="wi-1" />)
    await screen.findByText('Unassigned')
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull()
  })

  test('Start investigating on an unowned incident says it was assigned to you when the response says so', async () => {
    api.updateStatus.mockResolvedValue(workItem({ status: 'INVESTIGATING', assignee_id: 'u1', assignee_username: 'me' }))
    await renderAs('sre', <IncidentDetail id="wi-1" />)
    await userEvent.click(await screen.findByRole('button', { name: /Start investigating/ }))
    expect(await screen.findByText('Investigating · assigned to you')).toBeTruthy()
  })

  test('an incident someone else already owns gets the plain toast', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ assignee_id: 'u2', assignee_username: 'bob' }))
    api.updateStatus.mockResolvedValue(workItem({ status: 'INVESTIGATING', assignee_id: 'u2', assignee_username: 'bob' }))
    await renderAs('sre', <IncidentDetail id="wi-1" />)
    await userEvent.click(await screen.findByRole('button', { name: /Start investigating/ }))
    expect(await screen.findByText('Moved to INVESTIGATING')).toBeTruthy()
  })

  test('the pane reports the incident it opened, so the list and the tab title can name it', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'CLOSED' }))
    const onOpened = vi.fn()
    await renderAs('sre', <IncidentDetail id="wi-1" onOpened={onOpened} />)
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith({ id: 'wi-1', component: 'RDBMS_PRIMARY', status: 'CLOSED', assignee_id: null }))
  })

  test('the opened incident carries its assignee id, for the palette\'s Assign to me', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', assignee_id: 'u2', assignee_username: 'bob' }))
    const onOpened = vi.fn()
    await renderAs('sre', <IncidentDetail id="wi-1" onOpened={onOpened} />)
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith({ id: 'wi-1', component: 'RDBMS_PRIMARY', status: 'INVESTIGATING', assignee_id: 'u2' }))
  })
})

describe('second critique: grouped signals', () => {
  // The API sends the latest signals OLDEST first.
  const storm = () => [
    ...[1, 2, 3, 4, 5, 6, 7].map(i => sig(i, { id: `a${i}`, message: 'conn refused', severity: 'CRITICAL' })),
    ...[8, 9].map(i => sig(i, { id: `b${i}`, message: 'slow query', severity: 'HIGH' })),
  ]

  test('identical messages collapse into one row with a count, newest group first', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 9 }))
    api.fetchSignals.mockResolvedValue(storm())
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await waitFor(() => expect(container.querySelectorAll('.signal')).toHaveLength(2))
    const rows = [...container.querySelectorAll('.signal')]
    expect(rows[0].querySelector('.signal-msg').textContent).toBe('slow query')
    expect(rows[0].querySelector('.signal-count').textContent).toBe('×2')
    expect(rows[1].querySelector('.signal-msg').textContent).toBe('conn refused')
    expect(rows[1].querySelector('.signal-count').textContent).toBe('×7')
    expect((await tab('Signals')).textContent).toBe('Signals 9')  // the tab keeps the incident's real count
  })

  test('a group with 2 or more shows when it started and a rate, one signal shows neither', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 10 }))
    // nine 'burst' signals over 8 minutes (about 1 per minute), then one 'once'
    api.fetchSignals.mockResolvedValue([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => sig(i, { id: `x${i}`, message: 'burst' })), sig(10, { id: 'y', message: 'once' }),
    ])
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await waitFor(() => expect(container.querySelectorAll('.signal')).toHaveLength(2))
    const meta = (msg) => [...container.querySelectorAll('.signal')].find(r => r.textContent.includes(msg)).querySelector('.signal-meta').textContent
    expect(meta('burst')).toMatch(/since .* · ≈ 1\/min/)
    expect(meta('once')).not.toMatch(/since|≈/)
    expect(meta('once')).toMatch(/last .* ago/)
  })

  test('the same message at another severity is its own group', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 2 }))
    api.fetchSignals.mockResolvedValue([sig(1, { id: 'h', message: 'same', severity: 'HIGH' }), sig(2, { id: 'c', message: 'same', severity: 'CRITICAL' })])
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await waitFor(() => expect(container.querySelectorAll('.signal')).toHaveLength(2))
  })

  test('only the 5 newest groups show, and Show all reveals the rest', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 7 }))
    api.fetchSignals.mockResolvedValue(sevenSignals())
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await waitFor(() => expect(container.querySelectorAll('.signal')).toHaveLength(5))
    await userEvent.click(screen.getByRole('button', { name: 'Show all 7 groups' }))
    expect(container.querySelectorAll('.signal')).toHaveLength(7)
  })

  test('the severity dot is coloured only for CRITICAL', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 2 }))
    api.fetchSignals.mockResolvedValue([sig(1, { id: 'h', message: 'high one', severity: 'HIGH' }), sig(2, { id: 'c', message: 'critical one', severity: 'CRITICAL' })])
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await waitFor(() => expect(container.querySelectorAll('.signal-dot')).toHaveLength(2))
    const dot = (msg) => [...container.querySelectorAll('.signal')].find(r => r.textContent.includes(msg)).querySelector('.signal-dot')
    expect(dot('critical one').dataset.level).toBe('p0')
    expect(dot('high one').dataset.level).toBeUndefined()
  })
})

describe('second critique: calm finished incidents', () => {
  test('CLOSED leads with a completion line, a muted priority chip, and shows MTTR once', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'CLOSED', mttr_seconds: 7200 }))
    api.fetchRCA.mockResolvedValue(RCA_DONE)
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    const card = container.querySelector('.detail-card')
    await waitFor(() => expect(within(card).getByText('Closed · MTTR 2.0h')).toBeTruthy())
    expect(card.firstElementChild.classList.contains('completion')).toBe(true)
    expect(card.querySelector('.chip').dataset.muted).toBe('true')
    expect(card.querySelector('.mttr-chip')).toBeNull()
    expect(card.textContent.match(/MTTR/g)).toHaveLength(1)
  })

  test('with the completion line shown the header has no status badge, the line says it', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'CLOSED', mttr_seconds: 7200 }))
    api.fetchRCA.mockResolvedValue(RCA_DONE)
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await waitFor(() => expect(within(container.querySelector('.detail-card')).getByText('Closed · MTTR 2.0h')).toBeTruthy())
    expect(container.querySelector('.detail-badges .status')).toBeNull()
  })

  test('a RESOLVED incident with no MTTR has no completion line, so it keeps its status badge', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED', mttr_seconds: null }))
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await screen.findByRole('heading', { name: 'RDBMS_PRIMARY' })
    expect(container.querySelector('.completion')).toBeNull()
    expect(container.querySelector('.detail-badges .status').dataset.status).toBe('RESOLVED')
  })

  test('RESOLVED with an MTTR says Resolved, and its chip is muted too', async () => {
    resolvedWithRca()
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await waitFor(() => expect(within(container.querySelector('.detail-card')).getByText('Resolved · MTTR 2.0h')).toBeTruthy())
    expect(container.querySelector('.detail-card .chip').dataset.muted).toBe('true')
  })

  test('an active incident has no completion line and a loud priority chip', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await screen.findByRole('heading', { name: 'RDBMS_PRIMARY' })
    expect(container.querySelector('.completion')).toBeNull()
    expect(container.querySelector('.detail-card .chip').dataset.muted).toBeUndefined()
    expect(container.querySelector('.detail-badges .status').dataset.status).toBe('INVESTIGATING')
  })
})

describe('third critique: signal rate only while live', () => {
  const MIN = 60_000
  // `n` identical signals ending `endAgoMin` minutes ago, one a minute apart. Oldest first, like the API (list_signals).
  const burst = (n, endAgoMin) => Array.from({ length: n }, (_, i) => ({
    id: `r${i}`, message: 'conn refused', severity: 'CRITICAL',
    timestamp: new Date(Date.now() - (endAgoMin + (n - 1 - i)) * MIN).toISOString(),
  }))
  const metaOf = async (signals) => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: signals.length }))
    api.fetchSignals.mockResolvedValue(signals)
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    return (await waitFor(() => {
      const el = container.querySelector('.signal-meta')
      expect(el).not.toBeNull()
      return el
    })).textContent
  }

  test('a group whose last signal is 2 hours old shows when it ran but no rate', async () => {
    const meta = await metaOf(burst(6, 120))
    expect(meta).toMatch(/last .* ago · since /)
    expect(meta).not.toMatch(/\/min|\/h|≈/)
  })

  test('a group whose last signal is 5 minutes old still shows its rate', async () => {
    expect(await metaOf(burst(6, 5))).toMatch(/since .* · ≈ 1\/min/)
  })

  test('a group whose last signal is 14 minutes old is still live', async () => {
    expect(await metaOf(burst(6, 14))).toMatch(/≈ 1\/min/)
  })
})

describe('fourth critique: a closed record that agrees with itself', () => {
  // The real /history shape and order (list_history): oldest first, actor_username null for system events.
  const ev = (id, kind, from_value, to_value, actor_username, minutesAgo) => ({
    id, kind, from_value, to_value, actor_username, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  })
  const HISTORY = [
    ev('e1', 'created', null, 'P0', null, 300),
    ev('e2', 'status', 'OPEN', 'INVESTIGATING', 'carol', 200),
    ev('e3', 'status', 'INVESTIGATING', 'RESOLVED', 'alice', 100),
    ev('e4', 'rca_submitted', null, null, 'alice', 90),
    ev('e5', 'status', 'RESOLVED', 'CLOSED', 'bob', 10),
  ]
  const fact = (container, label) => within(container.querySelector('.detail-summary')).getByText(label).nextElementSibling.textContent
  const closedWithHistory = async (history, status = 'CLOSED') => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status, mttr_seconds: 7200 }))
    api.fetchRCA.mockResolvedValue(RCA_DONE)
    api.fetchHistory.mockResolvedValue(history)
    return renderAs('sre', <IncidentDetail id="wi-1" />)
  }

  test('CLOSED shows who resolved and who closed it, from the status events', async () => {
    const { container } = await closedWithHistory(HISTORY)
    await waitFor(() => expect(fact(container, 'Resolved by')).toBe('alice'))
    expect(fact(container, 'Closed by')).toBe('bob')
    expect(within(container.querySelector('.detail-summary')).queryByText('Owner')).toBeNull()
  })

  test('CLOSED with no events shows a dash for both', async () => {
    const { container } = await closedWithHistory([])
    await waitFor(() => expect(api.fetchHistory).toHaveBeenCalled())
    await waitFor(() => expect(fact(container, 'Resolved by')).toBe('-'))
    expect(fact(container, 'Closed by')).toBe('-')
  })

  test('a status event with no actor (the system) is a dash, not the word "System"', async () => {
    const { container } = await closedWithHistory([ev('e3', 'status', 'INVESTIGATING', 'RESOLVED', null, 100), ev('e5', 'status', 'RESOLVED', 'CLOSED', 'bob', 10)])
    await waitFor(() => expect(fact(container, 'Closed by')).toBe('bob'))
    expect(fact(container, 'Resolved by')).toBe('-')
  })

  test('only the resolve and close events count: an INVESTIGATING or assignment event is not "Resolved by"', async () => {
    const { container } = await closedWithHistory([ev('e2', 'status', 'OPEN', 'INVESTIGATING', 'carol', 200), ev('e3', 'assigned', null, 'dave', 'carol', 190)])
    await waitFor(() => expect(api.fetchHistory).toHaveBeenCalled())
    await waitFor(() => expect(fact(container, 'Resolved by')).toBe('-'))
    expect(fact(container, 'Closed by')).toBe('-')
  })

  test('RESOLVED shows Resolved by but no Closed by', async () => {
    const { container } = await closedWithHistory(HISTORY.slice(0, 4), 'RESOLVED')
    await waitFor(() => expect(fact(container, 'Resolved by')).toBe('alice'))
    expect(within(container.querySelector('.detail-summary')).queryByText('Closed by')).toBeNull()
  })

  test('an active incident shows neither fact', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
    api.fetchHistory.mockResolvedValue(HISTORY.slice(0, 2))
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await screen.findByText('carol changed status OPEN → INVESTIGATING')
    expect(container.textContent).not.toMatch(/Resolved by|Closed by/)
  })

  test('a history that cannot be loaded leaves dashes, not a crash', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'CLOSED', mttr_seconds: 7200 }))
    api.fetchRCA.mockResolvedValue(RCA_DONE)
    api.fetchHistory.mockRejectedValue(httpError(500, 'boom'))
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await waitFor(() => expect(fact(container, 'Resolved by')).toBe('-'))
    expect(fact(container, 'Closed by')).toBe('-')
  })

  test('the completion line explains MTTR in a tooltip and for screen readers, without a second MTTR in the text', async () => {
    const { container } = await closedWithHistory(HISTORY)
    const line = await waitFor(() => {
      const el = container.querySelector('.completion')
      expect(el).not.toBeNull()
      return el
    })
    expect(line.title).toBe('Time from the first signal to the RCA')
    expect(line.querySelector('.sr-only').textContent).toBe(', time from the first signal to the RCA')
    expect(line.querySelector('span:not(.sr-only)').textContent).toBe('Closed · MTTR 2.0h')
    expect(line.textContent.match(/MTTR/g)).toHaveLength(1)
  })

  test('with no MTTR the completion line has no explanation to give', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'CLOSED', mttr_seconds: null }))
    api.fetchRCA.mockResolvedValue(RCA_DONE)
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    const line = await waitFor(() => {
      const el = container.querySelector('.completion')
      expect(el).not.toBeNull()
      return el
    })
    expect(line.textContent).toBe('Closed')
    expect(line.title).toBe('')
  })

  describe('the read view checks the impact window against the first signal', () => {
    const START = '2026-01-01T10:00:30Z'  // the first signal, with seconds: the form pre-fills it cut to the minute
    const withRca = async (rca) => {
      api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED', mttr_seconds: 7200, start_time: START }))
      api.fetchRCA.mockResolvedValue({ ...RCA_DONE, ...rca })
      const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
      await screen.findByText('Impact start')
      return container
    }

    test('an RCA that starts before the first signal says so, with the first-signal time', async () => {
      await withRca({ incident_start: '2026-01-01T09:00:00Z' })
      expect(screen.getByText(`This impact window starts before the first signal (${fmtStamp(START)}).`)).toBeTruthy()
    })

    test('an RCA that ends before the first signal says so too', async () => {
      await withRca({ incident_start: '2026-01-01T08:00:00Z', incident_end: '2026-01-01T09:00:00Z' })
      expect(screen.getByText(`This impact window ends before the first signal (${fmtStamp(START)}).`)).toBeTruthy()
    })

    test('the untouched pre-filled start (the first signal cut to the minute) is not a warning', async () => {
      const container = await withRca({ incident_start: '2026-01-01T10:00:00Z' })
      expect(container.textContent).not.toMatch(/before the first signal/)
    })

    test('a window after the first signal is quiet', async () => {
      const container = await withRca({})
      expect(container.textContent).not.toMatch(/before the first signal/)
    })
  })

  test('a filled RCA has no Submitted chip, and Export Markdown stays', async () => {
    const { container } = await closedWithHistory(HISTORY)
    await screen.findByRole('button', { name: 'Export Markdown' })
    expect(container.querySelector('.chip.submitted')).toBeNull()
    expect(screen.queryByText('Submitted')).toBeNull()
  })
})

describe('fifth critique: claim first, state line, closing payoff', () => {
  const HOUR = 3600_000
  const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()
  const line = (container) => container.querySelector('.state-line')
  const load = async (over, role = 'sre') => {
    api.fetchWorkItem.mockResolvedValue(workItem(over))
    const view = await renderAs(role, <IncidentDetail id="wi-1" />)
    await screen.findByRole('heading', { name: 'RDBMS_PRIMARY' })
    return view
  }

  describe('claim first on an unowned incident', () => {
    test('unowned INVESTIGATING: Assign to me is the primary button and Mark resolved is secondary', async () => {
      await load({ status: 'INVESTIGATING' })
      const assign = await screen.findByRole('button', { name: 'Assign to me' })
      expect(assign.classList.contains('btn-primary')).toBe(true)
      expect(assign.classList.contains('btn-link')).toBe(false)
      const resolve = screen.getByRole('button', { name: 'Mark resolved' })
      expect(resolve.classList.contains('btn-secondary')).toBe(true)
      expect(resolve.classList.contains('btn-primary')).toBe(false)
    })

    test('the primary Assign to me assigns the signed-in user', async () => {
      api.assignWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', assignee_id: 'u1', assignee_username: 'me' }))
      await load({ status: 'INVESTIGATING' })
      await userEvent.click(await screen.findByRole('button', { name: 'Assign to me' }))
      expect(api.assignWorkItem).toHaveBeenCalledWith('wi-1', 'u1')
      // once owned the claim is done: no Assign to me, and Mark resolved is primary again
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull())
      expect(screen.getByRole('button', { name: 'Mark resolved' }).classList.contains('btn-primary')).toBe(true)
    })

    test('owned INVESTIGATING: Mark resolved is primary, and Assign to me stays a text link when someone else owns it', async () => {
      await load({ status: 'INVESTIGATING', assignee_id: 'u2', assignee_username: 'bob' })
      const resolve = await screen.findByRole('button', { name: 'Mark resolved' })
      expect(resolve.classList.contains('btn-primary')).toBe(true)
      expect(resolve.classList.contains('btn-secondary')).toBe(false)
      expect(screen.getByRole('button', { name: 'Assign to me' }).classList.contains('btn-link')).toBe(true)
    })

    test('OPEN is unchanged: Start investigating is primary and Assign to me is a text link', async () => {
      await load({ status: 'OPEN' })
      expect((await screen.findByRole('button', { name: 'Start investigating' })).classList.contains('btn-primary')).toBe(true)
      expect(screen.getByRole('button', { name: 'Assign to me' }).classList.contains('btn-link')).toBe(true)
    })

    test('a viewer gets neither button on an unowned INVESTIGATING incident', async () => {
      await load({ status: 'INVESTIGATING' }, 'viewer')
      expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Mark resolved' })).toBeNull()
    })
  })

  describe('the state line', () => {
    test('a breached unowned P0 reads priority, breach age and no owner, with no SLA chip', async () => {
      const { container } = await load({ status: 'INVESTIGATING', priority: 'P0', sla_deadline: iso(-(5 * 24 + 5) * HOUR - 60_000) })
      expect(line(container).textContent).toBe('P0 · SLA breached 5d 5h ago · no owner')
      expect(container.querySelector('.sla-chip')).toBeNull()
      expect(container.querySelector('.detail-badges-right')).toBeNull()
    })

    test('an owned P2 that has not breached reads the countdown and the owner', async () => {
      const { container } = await load({ status: 'INVESTIGATING', priority: 'P2', sla_deadline: iso(12 * 60_000 + 30_000), assignee_id: 'u2', assignee_username: 'alice' })
      expect(line(container).textContent).toMatch(/^P2 · SLA due in 12m \d+s · owned by alice$/)
    })

    test('a countdown over an hour drops the seconds', async () => {
      const { container } = await load({ status: 'OPEN', priority: 'P3', sla_deadline: iso(2 * HOUR + 5 * 60_000 + 30_000) })
      expect(line(container).textContent).toBe('P3 · SLA due in 2h 5m · no owner')
    })

    test('no SLA deadline leaves that part out', async () => {
      const { container } = await load({ status: 'OPEN', priority: 'P1', sla_deadline: null, assignee_id: 'u2', assignee_username: 'bob' })
      expect(line(container).textContent).toBe('P1 · owned by bob')
    })

    test('red marks only a breach under an hour old and no owner on a P0', async () => {
      const fresh = await load({ status: 'OPEN', priority: 'P0', sla_deadline: iso(-10 * 60_000) })
      expect(line(fresh.container).textContent).toMatch(/^P0 · SLA breached 10m ago · no owner$/)
      expect(line(fresh.container).querySelector('.state-sla').dataset.level).toBe('p0')
      expect(line(fresh.container).querySelector('.state-owner').dataset.level).toBe('p0')
      fresh.unmount()
      const old = await load({ status: 'OPEN', priority: 'P0', sla_deadline: iso(-3 * HOUR) })
      expect(line(old.container).querySelector('.state-sla').dataset.level).toBeUndefined()
      expect(line(old.container).querySelector('.state-owner').dataset.level).toBe('p0')
      old.unmount()
      const p2 = await load({ status: 'OPEN', priority: 'P2', sla_deadline: iso(HOUR) })
      expect(line(p2.container).querySelector('.state-owner').dataset.level).toBeUndefined()
      expect(line(p2.container).querySelector('.state-sla').dataset.level).toBeUndefined()
    })

    test('a viewer reads the same line', async () => {
      const { container } = await load({ status: 'OPEN', priority: 'P2', sla_deadline: null }, 'viewer')
      expect(line(container).textContent).toBe('P2 · no owner')
    })

    test('finished incidents have no state line, the completion line stands in', async () => {
      const { container } = await load({ status: 'RESOLVED', mttr_seconds: 7200 })
      expect(line(container)).toBeNull()
      expect(container.querySelector('.completion')).not.toBeNull()
    })

    test('the line sits directly under the title', async () => {
      const { container } = await load({ status: 'OPEN' })
      expect(container.querySelector('h1').nextElementSibling).toBe(line(container))
    })
  })

  describe('the closing payoff', () => {
    test('a CLOSED completion line has a check icon and the text', async () => {
      api.fetchRCA.mockResolvedValue(RCA_DONE)
      const { container } = await load({ status: 'CLOSED', mttr_seconds: 7200 })
      const el = await waitFor(() => { const e = container.querySelector('.completion'); expect(e).not.toBeNull(); return e })
      expect(el.querySelector('svg.icon')).not.toBeNull()
      expect(el.textContent).toMatch(/^Closed · MTTR 2\.0h/)
      expect(el.classList.contains('micro')).toBe(false)
    })

    test('a RESOLVED completion line has the check too, and a CLOSED one with no MTTR is just Closed', async () => {
      api.fetchRCA.mockResolvedValue(RCA_DONE)
      const resolved = await load({ status: 'RESOLVED', mttr_seconds: 7200 })
      expect(resolved.container.querySelector('.completion svg.icon')).not.toBeNull()
      resolved.unmount()
      const closed = await load({ status: 'CLOSED', mttr_seconds: null })
      const el = await waitFor(() => { const e = closed.container.querySelector('.completion'); expect(e).not.toBeNull(); return e })
      expect(el.querySelector('svg.icon')).not.toBeNull()
      expect(el.textContent).toBe('Closed')
    })

    test('the CLOSED summary has no Fix applied fact, but keeps the others', async () => {
      api.fetchRCA.mockResolvedValue(RCA_DONE)
      const { container } = await load({ status: 'CLOSED', mttr_seconds: 7200, signal_count: 3 })
      const summary = within(await waitFor(() => { const e = container.querySelector('.detail-summary'); expect(e).not.toBeNull(); return e }))
      for (const label of ['First signal', 'Last signal', 'Signals', 'Resolved by', 'Closed by']) expect(summary.getByText(label)).toBeTruthy()
      expect(summary.queryByText('Fix applied')).toBeNull()
      expect(screen.getByText('Fix applied')).toBeTruthy()  // it lives in the RCA card below
    })

    test('the impact-window warning shows on RESOLVED but not on CLOSED', async () => {
      const START = '2026-01-01T10:00:30Z'
      const early = { ...RCA_DONE, incident_start: '2026-01-01T09:00:00Z' }
      api.fetchRCA.mockResolvedValue(early)
      const resolved = await load({ status: 'RESOLVED', mttr_seconds: 7200, start_time: START })
      expect(await screen.findByText(/This impact window starts before the first signal/)).toBeTruthy()
      resolved.unmount()
      const closed = await load({ status: 'CLOSED', mttr_seconds: 7200, start_time: START })
      await screen.findByText('Impact start')
      expect(closed.container.textContent).not.toMatch(/before the first signal/)
    })

    test('Created is hidden when it equals the first signal to the minute, kept otherwise', async () => {
      const at = '2026-01-01T10:00:10Z'
      const same = await load({ status: 'OPEN', created_at: at, start_time: '2026-01-01T10:00:50Z' })
      expect(same.container.querySelector('.detail-meta').textContent).not.toMatch(/Created/)
      same.unmount()
      const later = await load({ status: 'OPEN', created_at: at, start_time: '2026-01-01T09:00:00Z' })
      expect(later.container.querySelector('.detail-meta').textContent).toMatch(/Created/)
      later.unmount()
      const none = await load({ status: 'OPEN', created_at: at, start_time: null })
      expect(none.container.querySelector('.detail-meta').textContent).toMatch(/Created/)
    })
  })
})

describe('harden', () => {
  test('a failed detail load says why, and Try again loads it', async () => {
    api.fetchWorkItem.mockRejectedValueOnce(networkError()).mockResolvedValue(workItem())
    await renderAs('sre', <IncidentDetail id="wi-1" />)
    expect(await screen.findByText(/Can't reach the server/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'RDBMS_PRIMARY' })).toBeTruthy()
    expect(api.fetchWorkItem).toHaveBeenCalledTimes(2)
  })

  test('while an assignment is in flight the select and Assign to me are disabled, and a second change is ignored', async () => {
    const pending = deferred()
    api.assignWorkItem.mockReturnValue(pending.promise)
    await renderAs('sre', <IncidentDetail id="wi-1" />)
    const select = await screen.findByRole('combobox', { name: 'Assign to' })
    await waitFor(() => expect(within(select).getByText(/bob/)).toBeTruthy())
    await userEvent.selectOptions(select, 'u2')
    expect(select.disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Assign to me' }).disabled).toBe(true)
    fireEvent.change(select, { target: { value: '' } })
    expect(api.assignWorkItem).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(workItem({ assignee_id: 'u2', assignee_username: 'bob' })) })
    expect(screen.getByRole('combobox', { name: 'Assign to' }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Assign to me' }).disabled).toBe(false)
  })

  test('a failed assignment re-enables the controls', async () => {
    api.assignWorkItem.mockRejectedValue(httpError(422, 'Assignee must be an active SRE or admin'))
    await renderAs('sre', <IncidentDetail id="wi-1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Assign to me' }))
    expect(await screen.findByText(/active SRE or admin/)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Assign to' }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Assign to me' }).disabled).toBe(false)
  })

  test('a signal message and the Latest line read with dir=auto', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 1 }))
    api.fetchSignals.mockResolvedValue([{ id: 's1', timestamp: new Date().toISOString(), message: 'فشل الاتصال بقاعدة البيانات', severity: 'HIGH' }])
    await renderAs('sre', <IncidentDetail id="wi-1" />)
    const hits = await screen.findAllByText('فشل الاتصال بقاعدة البيانات')
    expect(hits).toHaveLength(2)  // the signal row and the Latest line
    for (const h of hits) expect(h.dir).toBe('auto')
  })

  test('the signal count and the group count use thousands separators', async () => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING', signal_count: 12345 }))
    const now = Date.now()
    // the API sends the latest signals oldest first
    api.fetchSignals.mockResolvedValue(Array.from({ length: 1200 }, (_, i) => ({
      id: `s${i}`, timestamp: new Date(now - (1200 - i) * 1000).toISOString(), message: 'conn refused', severity: 'HIGH',
    })))
    const { container } = await renderAs('sre', <IncidentDetail id="wi-1" />)
    expect((await tab('Signals')).textContent).toBe('Signals 12,345')
    expect(container.querySelector('.detail-summary').textContent).toContain('12,345')
    expect(container.querySelector('.signal-count').textContent).toBe('×1,200')
  })
})

describe('RCA due on a resolved incident', () => {
  const HOUR = 3600_000
  const ago = (ms) => new Date(Date.now() - ms).toISOString()
  const load = async (over) => {
    api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED', end_time: null, ...over }))
    const view = await renderAs('sre', <IncidentDetail id="wi-1" />)
    await screen.findByRole('heading', { name: 'RDBMS_PRIMARY' })
    return view.container
  }

  test('within 48 hours the state line says when the RCA is due', async () => {
    const c = await load({ resolved_at: ago(HOUR - 60_000) })
    expect(c.querySelector('.state-line').textContent).toBe('Resolved 59m ago · RCA due in 1d 23h')
  })

  test('after 48 hours it says how overdue the RCA is', async () => {
    const c = await load({ resolved_at: ago(75 * HOUR + 60_000) })
    expect(c.querySelector('.state-line').textContent).toBe('Resolved 3d ago · RCA overdue by 1d 3h')
  })

  test('no state line once the RCA is submitted', async () => {
    const c = await load({ resolved_at: ago(75 * HOUR), end_time: ago(HOUR), mttr_seconds: 3600 })
    expect(c.querySelector('.state-line')).toBeNull()
  })
})

test('an unsent comment survives a switch to another tab and back', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'INVESTIGATING' }))
  await renderAs('sre', <IncidentDetail id="wi-1" />)
  await openTab('Activity')
  await userEvent.type(await screen.findByRole('textbox', { name: 'Add a comment' }), 'half written')
  await openTab('Signals')
  expect(screen.queryByRole('textbox', { name: 'Add a comment' })).toBeNull()  // hidden while another tab is open
  await openTab('Activity')
  expect(screen.getByRole('textbox', { name: 'Add a comment' }).value).toBe('half written')
})

test('the card has a deselect button that calls onClose, and none without onClose', async () => {
  const onClose = vi.fn()
  const { rerender } = await renderAs('sre', <IncidentDetail id="wi-1" onClose={onClose} />)
  const btn = await screen.findByRole('button', { name: 'Deselect incident' })
  expect(btn.getAttribute('title')).toBe('Deselect (Esc)')
  await userEvent.click(btn)
  expect(onClose).toHaveBeenCalled()
  rerender(<IncidentDetail id="wi-1" />)
  expect(screen.queryByRole('button', { name: 'Deselect incident' })).toBeNull()
})

test('Escape inside the Close confirm dismisses the confirm and does not reach the page', async () => {
  api.fetchWorkItem.mockResolvedValue(workItem({ status: 'RESOLVED', mttr_seconds: 3600 }))
  api.fetchRCA.mockResolvedValue({ incident_start: '2026-01-01T10:00:00Z', incident_end: '2026-01-01T12:00:00Z', root_cause_category: 'Infrastructure Failure', fix_applied: 'x', prevention_steps: 'y', submitted_at: '2026-01-01T12:30:00Z' })
  const outside = vi.fn()
  document.addEventListener('keydown', outside)
  try {
    await renderAs('sre', <IncidentDetail id="wi-1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Close incident…' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Close incident…' })).toBeTruthy()
    expect(outside.mock.calls.some(([e]) => e.key === 'Escape')).toBe(false)
  } finally { document.removeEventListener('keydown', outside) }
})
