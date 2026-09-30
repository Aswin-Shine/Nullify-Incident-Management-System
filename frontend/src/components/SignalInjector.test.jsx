import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SignalInjector } from './SignalInjector'
import * as api from '../api/client'
import { httpError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), ingestSignal: vi.fn() }))

beforeEach(() => { vi.resetAllMocks() })

test('inputs are labelled and the stepper buttons are named (F-08, F-09)', () => {
  render(<SignalInjector />)
  expect(screen.getByLabelText('Component')).toBeTruthy()
  expect(screen.getByLabelText('Signal Type')).toBeTruthy()
  expect(screen.getByLabelText(/Message/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Increase count' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Decrease count' })).toBeTruthy()
})

test('Enter in the message field submits the form (F-10)', async () => {
  api.ingestSignal.mockResolvedValue({})
  render(<SignalInjector />)
  await userEvent.type(screen.getByLabelText(/Message/), 'boom{Enter}')
  expect(api.ingestSignal).toHaveBeenCalledWith(expect.objectContaining({ component_id: 'RDBMS_PRIMARY', message: 'boom' }))
})

test('the batch count sends that many signals', async () => {
  api.ingestSignal.mockResolvedValue({})
  render(<SignalInjector />)
  await userEvent.click(screen.getByRole('button', { name: 'Increase count' }))
  await userEvent.click(screen.getByRole('button', { name: 'Increase count' }))
  await userEvent.click(screen.getByRole('button', { name: /Inject 3 Signals/ }))
  expect(api.ingestSignal).toHaveBeenCalledTimes(3)
})

test('an API error is shown', async () => {
  api.ingestSignal.mockRejectedValue(httpError(429, 'Rate limited'))
  render(<SignalInjector />)
  await userEvent.click(screen.getByRole('button', { name: /Inject Signal/ }))
  expect(await screen.findByText(/Rate limited/)).toBeTruthy()
})
