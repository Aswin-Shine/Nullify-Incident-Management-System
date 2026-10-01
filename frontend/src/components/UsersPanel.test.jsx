import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UsersPanel } from './UsersPanel'
import * as api from '../api/client'
import { renderAs, httpError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), listAccounts: vi.fn(), createUser: vi.fn(), updateUser: vi.fn(),
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
