import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginPage } from './LoginPage'
import { AuthProvider } from '../context/AuthContext'
import * as api from '../api/client'
import { httpError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), refreshSession: vi.fn(), login: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  api.refreshSession.mockRejectedValue(new Error('no session'))
})

const setup = () => render(<AuthProvider><LoginPage /></AuthProvider>)

test('inputs are labelled (F-09)', () => {
  setup()
  expect(screen.getByLabelText('Username')).toBeTruthy()
  expect(screen.getByLabelText('Password')).toBeTruthy()
})

test('Enter in the password field submits the form (F-10)', async () => {
  api.login.mockResolvedValue({ user: { username: 'u' } })
  setup()
  await userEvent.type(screen.getByLabelText('Username'), 'alice')
  await userEvent.type(screen.getByLabelText('Password'), 'secret-pass{Enter}')
  expect(api.login).toHaveBeenCalledWith({ username: 'alice', password: 'secret-pass' })
})

test('an API error is shown', async () => {
  api.login.mockRejectedValue(httpError(401, 'Invalid credentials'))
  setup()
  await userEvent.type(screen.getByLabelText('Username'), 'alice')
  await userEvent.type(screen.getByLabelText('Password'), 'x{Enter}')
  expect(await screen.findByText('Invalid credentials')).toBeTruthy()
})

test('a network failure shows the fallback message', async () => {
  api.login.mockRejectedValue(new Error('Network Error'))
  setup()
  await userEvent.type(screen.getByLabelText('Username'), 'alice')
  await userEvent.type(screen.getByLabelText('Password'), 'x{Enter}')
  expect(await screen.findByText('Authentication failed')).toBeTruthy()
})

test('inputs have names so password managers can fill them', () => {
  setup()
  expect(screen.getByLabelText('Username').getAttribute('name')).toBe('username')
  expect(screen.getByLabelText('Password').getAttribute('name')).toBe('password')
})

test('both inputs are required, so an empty submit never reaches the server', () => {
  setup()
  expect(screen.getByLabelText('Username').required).toBe(true)
  expect(screen.getByLabelText('Password').required).toBe(true)
})

test('the password field has no bullet placeholder', () => {
  setup()
  expect(screen.getByLabelText('Password').getAttribute('placeholder')).toBeNull()
})
