import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UsersPanel } from './UsersPanel'
import * as api from '../api/client'
import { renderAs, httpError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), listAccounts: vi.fn(), createUser: vi.fn(), updateUser: vi.fn(), deleteUser: vi.fn(),
}))

const ACCOUNTS = [
  { id: 'u1', username: 'me', email: 'me@example.com', role: 'admin', is_active: true, has_api_key: false },
  { id: 'u2', username: 'bob', email: 'bob@example.com', role: 'sre', is_active: true, has_api_key: false },
  { id: 'u3', username: 'carol', email: 'carol@example.com', role: 'viewer', is_active: false, has_api_key: true },
]

beforeEach(() => {
  vi.resetAllMocks()
  api.listAccounts.mockResolvedValue(ACCOUNTS)
  api.updateUser.mockResolvedValue({})
})

const row = async (name) => (await screen.findByText(name)).closest('tr')

test('renders a row per account with a role select and an active toggle', async () => {
  await renderAs('admin', <UsersPanel />)
  const bob = await row('bob')
  expect(within(bob).getByRole('combobox', { name: 'Role for bob' }).value).toBe('sre')
  expect(within(bob).getByRole('checkbox', { name: 'Active bob' }).checked).toBe(true)
  const carol = await row('carol')
  expect(within(carol).getByRole('checkbox', { name: 'Active carol' }).checked).toBe(false)
})

test('changing the role and toggling active call updateUser, then reload', async () => {
  await renderAs('admin', <UsersPanel />)
  const bob = await row('bob')
  await userEvent.selectOptions(within(bob).getByRole('combobox', { name: 'Role for bob' }), 'viewer')
  expect(api.updateUser).toHaveBeenCalledWith('u2', { role: 'viewer' })
  await userEvent.click(within(bob).getByRole('checkbox', { name: 'Active bob' }))
  expect(api.updateUser).toHaveBeenCalledWith('u2', { is_active: false })
  expect(api.listAccounts.mock.calls.length).toBeGreaterThan(1)
})

test("the acting admin's own role and active controls are disabled", async () => {
  await renderAs('admin', <UsersPanel />)
  const me = await row('me')
  expect(within(me).getByRole('combobox', { name: 'Role for me' }).disabled).toBe(true)
  expect(within(me).getByRole('checkbox', { name: 'Active me' }).disabled).toBe(true)
})

test('the create form calls createUser and reloads the list', async () => {
  api.createUser.mockResolvedValue({})
  await renderAs('admin', <UsersPanel />)
  await screen.findByText('bob')
  await userEvent.type(screen.getByLabelText('Username'), 'dave')
  await userEvent.type(screen.getByLabelText('Email'), 'dave@example.com')
  await userEvent.type(screen.getByLabelText('Password'), 'twelve-chars-pw')
  await userEvent.selectOptions(screen.getByLabelText('Role'), 'sre')
  const before = api.listAccounts.mock.calls.length
  await userEvent.click(screen.getByRole('button', { name: 'Create user' }))
  expect(api.createUser).toHaveBeenCalledWith(
    { username: 'dave', email: 'dave@example.com', password: 'twelve-chars-pw', role: 'sre' })
  await screen.findByText('bob')
  expect(api.listAccounts.mock.calls.length).toBeGreaterThan(before)
})

test('a create error is shown', async () => {
  api.createUser.mockRejectedValue(httpError(400, 'Username or email already in use'))
  await renderAs('admin', <UsersPanel />)
  await screen.findByText('bob')
  await userEvent.type(screen.getByLabelText('Username'), 'bob')
  await userEvent.type(screen.getByLabelText('Email'), 'bob@example.com')
  await userEvent.type(screen.getByLabelText('Password'), 'twelve-chars-pw')
  await userEvent.click(screen.getByRole('button', { name: 'Create user' }))
  expect(await screen.findByText('Username or email already in use')).toBeTruthy()
})

test('Reset password opens an inline field and calls updateUser with the password', async () => {
  await renderAs('admin', <UsersPanel />)
  const bob = await row('bob')
  await userEvent.click(within(bob).getByRole('button', { name: 'Reset password' }))
  await userEvent.type(within(bob).getByLabelText('New password for bob'), 'reset-by-the-admin-1')
  await userEvent.click(within(bob).getByRole('button', { name: 'Save' }))
  expect(api.updateUser).toHaveBeenCalledWith('u2', { password: 'reset-by-the-admin-1' })
})

test('the create form constrains its inputs and explains the rules', async () => {
  await renderAs('admin', <UsersPanel />)
  const username = await screen.findByLabelText('Username')
  expect(username.required).toBe(true)
  expect(username.minLength).toBe(3)
  expect(username.maxLength).toBe(64)
  expect(username.pattern).toBe('[A-Za-z0-9_.\\-]{3,64}')
  expect(username.getAttribute('aria-describedby')).toBeTruthy()
  expect(document.getElementById(username.getAttribute('aria-describedby')).textContent).toBe('3-64 letters, digits, dot, dash or underscore')
  const password = screen.getByLabelText('Password')
  expect(password.required).toBe(true)
  expect(password.minLength).toBe(12)
  expect(password.maxLength).toBe(128)
  expect(document.getElementById(password.getAttribute('aria-describedby')).textContent).toBe('At least 12 characters')
  expect(screen.getByLabelText('Email').required).toBe(true)
})

test('the reset password input requires 12 characters', async () => {
  await renderAs('admin', <UsersPanel />)
  const bob = await row('bob')
  await userEvent.click(within(bob).getByRole('button', { name: 'Reset password' }))
  expect(within(bob).getByLabelText('New password for bob').minLength).toBe(12)
})

describe('deleting an account', () => {
  test('every row but your own has a Delete button', async () => {
    await renderAs('admin', <UsersPanel />)
    expect(within(await row('bob')).getByRole('button', { name: 'Delete bob' })).toBeTruthy()
    expect(within(await row('me')).queryByRole('button', { name: /Delete/ })).toBeNull()
  })

  test('Delete asks first, and Cancel sends nothing and puts focus back on Delete', async () => {
    await renderAs('admin', <UsersPanel />)
    await userEvent.click(within(await row('bob')).getByRole('button', { name: 'Delete bob' }))
    const bob = await row('bob')
    expect(bob.textContent).toContain('Delete bob? They can\'t sign in again.')
    expect(within(bob).getByRole('button', { name: 'Cancel' }) === document.activeElement).toBe(true)
    await userEvent.click(within(bob).getByRole('button', { name: 'Cancel' }))
    expect(api.deleteUser).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(within(await row('bob')).getByRole('button', { name: 'Delete bob' }))
  })

  test('Escape cancels the confirm', async () => {
    await renderAs('admin', <UsersPanel />)
    await userEvent.click(within(await row('bob')).getByRole('button', { name: 'Delete bob' }))
    await userEvent.keyboard('{Escape}')
    expect(within(await row('bob')).queryByRole('button', { name: 'Delete account' })).toBeNull()
    expect(api.deleteUser).not.toHaveBeenCalled()
  })

  test('confirming deletes the account, reloads the list and says so', async () => {
    api.deleteUser.mockResolvedValue()
    await renderAs('admin', <UsersPanel />)
    await userEvent.click(within(await row('bob')).getByRole('button', { name: 'Delete bob' }))
    api.listAccounts.mockResolvedValue(ACCOUNTS.filter(a => a.id !== 'u2'))
    await userEvent.click(within(await row('bob')).getByRole('button', { name: 'Delete account' }))
    expect(api.deleteUser).toHaveBeenCalledWith('u2')
    expect(await screen.findByText('Deleted bob')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('bob')).toBeNull())
  })

  test('a failed delete shows the error and keeps the row', async () => {
    api.deleteUser.mockRejectedValue(httpError(400, 'You cannot delete your own account'))
    await renderAs('admin', <UsersPanel />)
    await userEvent.click(within(await row('bob')).getByRole('button', { name: 'Delete bob' }))
    await userEvent.click(within(await row('bob')).getByRole('button', { name: 'Delete account' }))
    expect(await screen.findByText('You cannot delete your own account')).toBeTruthy()
    expect(screen.getByText('bob')).toBeTruthy()
  })
})
