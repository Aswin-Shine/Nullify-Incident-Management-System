import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccountPanel } from './AccountPanel'
import * as api from '../api/client'
import { renderAs, httpError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), changePassword: vi.fn(), rotateApiKey: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(() => { vi.unstubAllGlobals() })

const NEW_PW = 'a-brand-new-passphrase'

async function fillPasswords(current = 'old-password-123', next = NEW_PW, confirm = NEW_PW) {
  await userEvent.type(screen.getByLabelText('Current password'), current)
  await userEvent.type(screen.getByLabelText('New password'), next)
  await userEvent.type(screen.getByLabelText('Confirm new password'), confirm)
  await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
}

test('change password is a labelled form with autocomplete hints', async () => {
  await renderAs('sre', <AccountPanel />)
  const form = screen.getByRole('button', { name: 'Change password' }).closest('form')
  expect(form).toBeTruthy()
  expect(screen.getByLabelText('Current password').getAttribute('autocomplete')).toBe('current-password')
  expect(screen.getByLabelText('New password').getAttribute('autocomplete')).toBe('new-password')
  expect(screen.getByLabelText('Confirm new password').getAttribute('autocomplete')).toBe('new-password')
})

test('a mismatched confirmation shows an error and calls nothing', async () => {
  await renderAs('sre', <AccountPanel />)
  await fillPasswords('old-password-123', NEW_PW, 'something-else-entirely')
  expect(await screen.findByText(/do not match/i)).toBeTruthy()
  expect(api.changePassword).not.toHaveBeenCalled()
})

test('a valid submit calls changePassword, confirms, and clears the fields', async () => {
  api.changePassword.mockResolvedValue({ user: { id: 'u1', username: 'me', role: 'sre' } })
  await renderAs('sre', <AccountPanel />)
  await fillPasswords()
  expect(api.changePassword).toHaveBeenCalledWith('old-password-123', NEW_PW)
  expect(await screen.findByText(/Password changed/)).toBeTruthy()
  expect(screen.getByLabelText('Current password').value).toBe('')
  expect(screen.getByLabelText('New password').value).toBe('')
})

test('an API error is shown', async () => {
  api.changePassword.mockRejectedValue(httpError(400, 'Current password is incorrect'))
  await renderAs('sre', <AccountPanel />)
  await fillPasswords()
  expect(await screen.findByText('Current password is incorrect')).toBeTruthy()
})

test('the key status follows user.has_api_key', async () => {
  await renderAs('sre', <AccountPanel />, { has_api_key: true })
  expect(screen.getByText(/generating a new one disables it/i)).toBeTruthy()
})

test('without a key the panel says so', async () => {
  await renderAs('sre', <AccountPanel />)
  expect(screen.getByText(/No key yet/)).toBeTruthy()
})

test('Generate key shows the key once in a read-only field, and Copy writes it to the clipboard', async () => {
  api.rotateApiKey.mockResolvedValue({ api_key: 'nlfy_secret_key_123' })
  const writeText = vi.fn().mockResolvedValue()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  await renderAs('sre', <AccountPanel />)
  await userEvent.click(screen.getByRole('button', { name: 'Generate key' }))
  const field = await screen.findByDisplayValue('nlfy_secret_key_123')
  expect(field.readOnly).toBe(true)
  expect(screen.getByText(/will not be shown again/i)).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('nlfy_secret_key_123'))
})

test('Enable desktop alerts asks the browser for permission and shows the result', async () => {
  const requestPermission = vi.fn().mockResolvedValue('granted')
  vi.stubGlobal('Notification', { permission: 'default', requestPermission })
  await renderAs('sre', <AccountPanel />)
  expect(screen.getByText(/Permission: default/)).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Enable desktop alerts' }))
  expect(requestPermission).toHaveBeenCalledTimes(1)
  expect(await screen.findByText(/Permission: granted/)).toBeTruthy()
})

test('the desktop alerts card is hidden when the browser has no Notification API', async () => {
  vi.stubGlobal('Notification', undefined)
  await renderAs('sre', <AccountPanel />)
  expect(screen.queryByRole('button', { name: 'Enable desktop alerts' })).toBeNull()
})

describe('second critique: rotating an existing key', () => {
  test('with a key, Generate asks first and nothing is rotated until it is confirmed', async () => {
    api.rotateApiKey.mockResolvedValue({ api_key: 'nlfy_new_key' })
    await renderAs('sre', <AccountPanel />, { has_api_key: true })
    await userEvent.click(screen.getByRole('button', { name: 'Generate key' }))
    expect(screen.getByText('This disables your current key. Producers using it will start getting 401.')).toBeTruthy()
    expect(api.rotateApiKey).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Generate new key' }))
    expect(api.rotateApiKey).toHaveBeenCalledTimes(1)
    expect(await screen.findByDisplayValue('nlfy_new_key')).toBeTruthy()
  })

  test('Cancel dismisses the confirm without rotating', async () => {
    await renderAs('sre', <AccountPanel />, { has_api_key: true })
    await userEvent.click(screen.getByRole('button', { name: 'Generate key' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Producers using it/)).toBeNull()
    expect(api.rotateApiKey).not.toHaveBeenCalled()
  })

  test('without a key, Generate rotates straight away', async () => {
    api.rotateApiKey.mockResolvedValue({ api_key: 'nlfy_first' })
    await renderAs('sre', <AccountPanel />)
    await userEvent.click(screen.getByRole('button', { name: 'Generate key' }))
    expect(api.rotateApiKey).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Producers using it/)).toBeNull()
  })

  test('the page has a level-1 title', async () => {
    await renderAs('sre', <AccountPanel />)
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeTruthy()
  })
})
