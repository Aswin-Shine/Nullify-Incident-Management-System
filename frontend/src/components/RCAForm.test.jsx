import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RCAForm } from './RCAForm'
import * as api from '../api/client'
import { workItem, httpError } from '../test/utils'
import { fmtStamp } from '../format'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), fetchRCA: vi.fn(), submitRCA: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchRCA.mockResolvedValue(null)
})

const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

async function fillValid(start = '2026-01-01T10:00', end = '2026-01-01T12:00') {
  change('Impact Start', start)
  change('Impact End', end)
  await userEvent.selectOptions(screen.getByLabelText('Root Cause Category'), 'Code Defect')
  await userEvent.type(screen.getByLabelText('Fix Applied'), 'Restarted')
  await userEvent.type(screen.getByLabelText('Prevention Steps'), 'Failover')
}

test('every input has a label (F-09)', () => {
  render(<RCAForm workItem={workItem()} rca={null} />)
  for (const l of ['Impact Start', 'Impact End', 'Root Cause Category', 'Fix Applied', 'Prevention Steps']) {
    expect(screen.getByLabelText(l)).toBeTruthy()
  }
})

test('empty fields block the submit (F-06, F-10)', async () => {
  render(<RCAForm workItem={workItem()} rca={null} />)
  await userEvent.click(screen.getByRole('button', { name: 'Submit RCA' }))
  expect(api.submitRCA).not.toHaveBeenCalled()
})

test('an end before the start shows an error and does not submit (F-06)', async () => {
  render(<RCAForm workItem={workItem()} rca={null} />)
  await fillValid('2026-01-01T12:00', '2026-01-01T10:00')
  await userEvent.click(screen.getByRole('button', { name: 'Submit RCA' }))
  expect(await screen.findByText(/must not be before/i)).toBeTruthy()
  expect(api.submitRCA).not.toHaveBeenCalled()
})

test('a valid submit sends ISO strings with an offset and reports success (F-06)', async () => {
  const created = { id: 'r1' }
  api.submitRCA.mockResolvedValue(created)
  const onSuccess = vi.fn()
  render(<RCAForm workItem={workItem()} rca={null} onSuccess={onSuccess} />)
  await fillValid()
  await userEvent.click(screen.getByRole('button', { name: 'Submit RCA' }))
  expect(api.submitRCA).toHaveBeenCalledWith('wi-1', expect.objectContaining({
    incident_start: new Date('2026-01-01T10:00').toISOString(),
    incident_end: new Date('2026-01-01T12:00').toISOString(),
    fix_applied: 'Restarted',
  }))
  expect(onSuccess).toHaveBeenCalledWith(created)
})

test('an array detail from a 422 renders as text', async () => {
  api.submitRCA.mockRejectedValue(httpError(422, [{ msg: 'bad time' }]))
  render(<RCAForm workItem={workItem()} rca={null} />)
  await fillValid()
  await userEvent.click(screen.getByRole('button', { name: 'Submit RCA' }))
  expect(await screen.findByText(/bad time/)).toBeTruthy()
})

test('a submitted RCA is shown read-only', () => {
  const rca = { incident_start: 'S', incident_end: 'E', root_cause_category: 'Code Defect', fix_applied: 'fixed it', prevention_steps: 'tests' }
  render(<RCAForm workItem={workItem()} rca={rca} />)
  expect(screen.getByText('fixed it')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Submit RCA' })).toBeNull()
})

const START = '2026-03-04T10:15:00.000Z'
const LAST = '2026-03-04T11:45:00.000Z'
const inputIso = (label) => new Date(screen.getByLabelText(label).value).toISOString()

test('with no RCA the impact window is pre-filled from the first and last signal', () => {
  render(<RCAForm workItem={workItem({ start_time: START, last_signal_at: LAST })} rca={null} />)
  expect(inputIso('Impact Start')).toBe(START)
  expect(inputIso('Impact End')).toBe(LAST)
})

test('the impact end falls back to the start when there is no last signal', () => {
  render(<RCAForm workItem={workItem({ start_time: START, last_signal_at: null })} rca={null} />)
  expect(inputIso('Impact End')).toBe(START)
})

test('submitting without touching the times sends the pre-filled instants', async () => {
  api.submitRCA.mockResolvedValue({ id: 'r1' })
  render(<RCAForm workItem={workItem({ start_time: START, last_signal_at: LAST })} rca={null} />)
  await userEvent.selectOptions(screen.getByLabelText('Root Cause Category'), 'Code Defect')
  await userEvent.type(screen.getByLabelText('Fix Applied'), 'Restarted')
  await userEvent.type(screen.getByLabelText('Prevention Steps'), 'Failover')
  await userEvent.click(screen.getByRole('button', { name: 'Submit RCA' }))
  expect(api.submitRCA).toHaveBeenCalledWith('wi-1', expect.objectContaining({ incident_start: START, incident_end: LAST }))
})

describe('Markdown export', () => {
  const rca = { incident_start: START, incident_end: LAST, root_cause_category: 'Code Defect',
    fix_applied: 'fixed it', prevention_steps: 'tests', submitted_at: LAST }
  let created, clicked
  beforeEach(() => {
    created = []; clicked = []
    URL.createObjectURL = vi.fn(blob => { created.push(blob); return 'blob:x' })
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicked.push(this) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  test('an RCA can be exported as a Markdown file named after the component and date', async () => {
    render(<RCAForm workItem={workItem({ start_time: START })} rca={rca} />)
    await userEvent.click(screen.getByRole('button', { name: 'Export Markdown' }))
    expect(created).toHaveLength(1)
    expect(created[0].type).toMatch(/^text\/markdown/)
    expect(clicked).toHaveLength(1)
    expect(clicked[0].download).toMatch(/^rca-RDBMS_PRIMARY-\d{4}-\d{2}-\d{2}\.md$/)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })

  test('there is no export button before an RCA exists', () => {
    render(<RCAForm workItem={workItem()} rca={null} />)
    expect(screen.queryByRole('button', { name: 'Export Markdown' })).toBeNull()
  })
})

test('the submitted RCA shows short local stamps, not raw ISO strings (F-39)', () => {
  const rca = { incident_start: '2026-10-04T10:00:00Z', incident_end: '2026-10-04T11:30:00Z', root_cause_category: 'Code Defect',
    fix_applied: 'f', prevention_steps: 'p' }
  render(<RCAForm workItem={workItem()} rca={rca} />)
  expect(screen.queryByText('2026-10-04T10:00:00Z')).toBeNull()
  expect(screen.getByText(fmtStamp(rca.incident_start))).toBeTruthy()
  expect(screen.getByText(fmtStamp(rca.incident_end))).toBeTruthy()
})

test('with defaultOpen false the form hides behind "Write RCA" until clicked', async () => {
  render(<RCAForm workItem={workItem()} rca={null} defaultOpen={false} />)
  expect(screen.queryByRole('button', { name: 'Submit RCA' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Write RCA' }))
  expect(screen.getByRole('button', { name: 'Submit RCA' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Write RCA' })).toBeNull()
})

test('a collapsed form that becomes default-open (RESOLVED) expands without losing typed text', async () => {
  const { rerender } = render(<RCAForm workItem={workItem()} rca={null} defaultOpen={false} />)
  await userEvent.click(screen.getByRole('button', { name: 'Write RCA' }))
  await userEvent.type(screen.getByLabelText('Fix Applied'), 'draft')
  rerender(<RCAForm workItem={workItem()} rca={null} defaultOpen />)
  expect(screen.getByLabelText('Fix Applied').value).toBe('draft')
})

describe('second critique: RCA form', () => {
  test('the category starts on a disabled placeholder and the form cannot be submitted without one', async () => {
    render(<RCAForm workItem={workItem({ start_time: START, last_signal_at: LAST })} rca={null} />)
    const select = screen.getByLabelText('Root Cause Category')
    expect(select.value).toBe('')
    expect(select.required).toBe(true)
    const placeholder = screen.getByRole('option', { name: 'Choose a category' })
    expect(placeholder.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText('Fix Applied'), 'Restarted')
    await userEvent.type(screen.getByLabelText('Prevention Steps'), 'Failover')
    await userEvent.click(screen.getByRole('button', { name: 'Submit RCA' }))
    expect(api.submitRCA).not.toHaveBeenCalled()
  })

  test('Cancel collapses a form the user opened and keeps what was typed', async () => {
    render(<RCAForm workItem={workItem()} rca={null} defaultOpen={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'Write RCA' }))
    await userEvent.type(screen.getByLabelText('Fix Applied'), 'draft')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Fix Applied')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Write RCA' }))
    expect(screen.getByLabelText('Fix Applied').value).toBe('draft')
  })

  test('a form that is open by default has no Cancel', () => {
    render(<RCAForm workItem={workItem()} rca={null} defaultOpen />)
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  test('a start before the first signal shows a warning that does not block the submit', async () => {
    api.submitRCA.mockResolvedValue({ id: 'r1' })
    render(<RCAForm workItem={workItem({ start_time: START, last_signal_at: LAST })} rca={null} />)
    expect(screen.queryByText(/Starts before the first signal/)).toBeNull()  // the pre-filled start is the first signal
    change('Impact Start', '2026-03-03T09:00')
    expect(screen.getByText(`Starts before the first signal (${fmtStamp(START)}).`)).toBeTruthy()
    await userEvent.selectOptions(screen.getByLabelText('Root Cause Category'), 'Code Defect')
    await userEvent.type(screen.getByLabelText('Fix Applied'), 'x')
    await userEvent.type(screen.getByLabelText('Prevention Steps'), 'y')
    await userEvent.click(screen.getByRole('button', { name: 'Submit RCA' }))
    expect(api.submitRCA).toHaveBeenCalledTimes(1)
  })

  test('an end before the first signal shows a warning that does not block the submit', async () => {
    api.submitRCA.mockResolvedValue({ id: 'r1' })
    render(<RCAForm workItem={workItem({ start_time: START, last_signal_at: LAST })} rca={null} />)
    expect(screen.queryByText(/Ends before the first signal/)).toBeNull()  // the pre-filled end is the last signal
    change('Impact Start', '2026-03-03T07:00')
    change('Impact End', '2026-03-03T09:00')
    expect(screen.getByText(`Ends before the first signal (${fmtStamp(START)}).`)).toBeTruthy()
    await userEvent.selectOptions(screen.getByLabelText('Root Cause Category'), 'Code Defect')
    await userEvent.type(screen.getByLabelText('Fix Applied'), 'x')
    await userEvent.type(screen.getByLabelText('Prevention Steps'), 'y')
    await userEvent.click(screen.getByRole('button', { name: 'Submit RCA' }))
    expect(api.submitRCA).toHaveBeenCalledTimes(1)
  })

  test('an end after the first signal has no end warning', () => {
    render(<RCAForm workItem={workItem({ start_time: START, last_signal_at: LAST })} rca={null} />)
    change('Impact End', '2026-03-06T12:30')
    expect(screen.queryByText(/Ends before the first signal/)).toBeNull()
  })

  test('the hint says what the RCA is for: closing once resolved while INVESTIGATING, submit it now once RESOLVED', () => {
    const { rerender } = render(<RCAForm workItem={workItem({ status: 'INVESTIGATING' })} rca={null} />)
    expect(screen.getByText('Needed to close the incident once it is resolved.')).toBeTruthy()
    rerender(<RCAForm workItem={workItem({ status: 'RESOLVED' })} rca={null} />)
    expect(screen.getByText('Submit the RCA to close this incident.')).toBeTruthy()
  })
})

test('the free-text fields stop at the backend limit of 8000 characters', () => {
  render(<RCAForm workItem={workItem({ status: 'INVESTIGATING' })} rca={null} />)
  expect(screen.getByLabelText('Fix Applied').maxLength).toBe(8000)
  expect(screen.getByLabelText('Prevention Steps').maxLength).toBe(8000)
})

test('the saved free text reads with dir=auto so Arabic or Hebrew aligns right', () => {
  const rca = { incident_start: '2026-01-01T10:00:00Z', incident_end: '2026-01-01T12:00:00Z', root_cause_category: 'Code Defect',
    fix_applied: 'أعدنا تشغيل الخدمة', prevention_steps: 'Failover' }
  render(<RCAForm workItem={workItem({ status: 'RESOLVED' })} rca={rca} />)
  expect(screen.getByText('أعدنا تشغيل الخدمة').dir).toBe('auto')
  expect(screen.getByText('Failover').dir).toBe('auto')
})
