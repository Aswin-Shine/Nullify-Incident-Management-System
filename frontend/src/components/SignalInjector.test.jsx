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
  expect(screen.getByLabelText('Signal type')).toBeTruthy()
  expect(screen.getByLabelText(/Message/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Increase count' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Decrease count' })).toBeTruthy()
})

test('Enter in the message field submits the form (F-10)', async () => {
  api.ingestSignal.mockResolvedValue({})
  render(<SignalInjector />)
  await userEvent.type(screen.getByLabelText(/Message/), 'boom{Enter}')
  expect(api.ingestSignal).toHaveBeenCalledWith(expect.objectContaining({ component_id: 'DEMO_APP', message: 'boom' }))
})

test('the batch count sends that many signals', async () => {
  api.ingestSignal.mockResolvedValue({})
  render(<SignalInjector />)
  await userEvent.click(screen.getByRole('button', { name: 'Increase count' }))
  await userEvent.click(screen.getByRole('button', { name: 'Increase count' }))
  await userEvent.click(screen.getByRole('button', { name: /Inject 3 signals/ }))
  expect(api.ingestSignal).toHaveBeenCalledTimes(3)
})

test('an API error is shown', async () => {
  api.ingestSignal.mockRejectedValue(httpError(429, 'Rate limited'))
  render(<SignalInjector />)
  await userEvent.click(screen.getByRole('button', { name: /Inject signal/ }))
  expect(await screen.findByText(/Rate limited/)).toBeTruthy()
})

test('the default component is the DEMO_APP sandbox, not a production-looking one', () => {
  render(<SignalInjector />)
  expect(screen.getByLabelText('Component').value).toBe('DEMO_APP')
  expect(screen.getByLabelText('Component').options[0].value).toBe('DEMO_APP')
})

test('the submit button is secondary', () => {
  render(<SignalInjector />)
  const submit = screen.getByRole('button', { name: /Inject signal/ })
  expect(submit.classList.contains('btn-secondary')).toBe(true)
  expect(submit.classList.contains('btn-primary')).toBe(false)
})

test('the message placeholder is exactly what is sent when the field is left empty', async () => {
  api.ingestSignal.mockResolvedValue({})
  render(<SignalInjector />)
  const placeholder = screen.getByLabelText(/Message/).placeholder
  await userEvent.click(screen.getByRole('button', { name: /Inject signal/ }))
  expect(api.ingestSignal).toHaveBeenCalledWith(expect.objectContaining({ message: placeholder }))
})

test('the message input stops at the backend limit of 4096 characters', () => {
  render(<SignalInjector />)
  expect(screen.getByLabelText(/Message/).maxLength).toBe(4096)
})
