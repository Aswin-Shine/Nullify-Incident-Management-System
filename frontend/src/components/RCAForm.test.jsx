import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RCAForm } from './RCAForm'
import * as api from '../api/client'
import { workItem, httpError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), fetchRCA: vi.fn(), submitRCA: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchRCA.mockResolvedValue(null)
})

const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

async function fillValid(start = '2026-01-01T10:00', end = '2026-01-01T12:00') {
  change('Impact Start', start)
  change('Impact End', end)
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
