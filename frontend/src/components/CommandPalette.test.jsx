import { screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from './CommandPalette'
import * as api from '../api/client'
import { renderAs } from '../test/utils'

vi.mock('../api/client', async (orig) => ({
  ...(await orig()),
  refreshSession: vi.fn(), fetchWorkItems: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchWorkItems.mockResolvedValue({ items: [], next_cursor: null })
})
afterEach(() => { vi.useRealTimers() })

const open = (role = 'sre', props = {}) => {
  const fns = { onClose: vi.fn(), onGo: vi.fn(), onTheme: vi.fn(), onSelectIncident: vi.fn() }
  return renderAs(role, <CommandPalette {...fns} {...props} />).then(r => ({ ...r, ...fns }))
}
const optionNames = () => screen.getAllByRole('option').map(o => o.textContent)

test('is a dialog named Command palette with the input focused', async () => {
  await open()
  expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('combobox'))
})

test('typing "ana" puts Go to Analytics first, and Enter runs it', async () => {
  const { onGo, onClose } = await open()
  await userEvent.type(screen.getByRole('combobox'), 'ana')
  expect(optionNames()[0]).toBe('Go to Analytics')
  await userEvent.keyboard('{Enter}')
  expect(onGo).toHaveBeenCalledWith('analytics')
  expect(onClose).toHaveBeenCalled()
})

test('ArrowDown moves the active option, and ArrowUp stops at the first one', async () => {
  const { onGo } = await open()
  const input = screen.getByRole('combobox')
  expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
  await userEvent.keyboard('{ArrowDown}')
  const second = screen.getAllByRole('option')[1]
  expect(second.getAttribute('aria-selected')).toBe('true')
  expect(input.getAttribute('aria-activedescendant')).toBe(second.id)
  await userEvent.keyboard('{ArrowUp}{ArrowUp}')
  expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
  await userEvent.keyboard('{ArrowDown}{Enter}')
  expect(onGo).toHaveBeenCalledWith('analytics')
})

test('a viewer gets no Inject command', async () => {
  await open('viewer')
  expect(optionNames()).toContain('Go to Analytics')
  expect(optionNames()).not.toContain('Go to Inject')
  expect(optionNames()).not.toContain('Go to Users')
})

test('an SRE gets Inject but not Users', async () => {
  await open('sre')
  expect(optionNames()).toContain('Go to Inject')
  expect(optionNames()).not.toContain('Go to Users')
})

test('an admin gets Inject and Users', async () => {
  await open('admin')
  expect(optionNames()).toContain('Go to Inject')
  expect(optionNames()).toContain('Go to Users')
})

test('lists the theme and log out commands, and a theme command calls onTheme', async () => {
  const { onTheme } = await open()
  expect(optionNames()).toEqual(expect.arrayContaining(['Theme: System', 'Theme: Light', 'Theme: Dark', 'Log out']))
  await userEvent.click(screen.getByRole('option', { name: 'Theme: Dark' }))
  expect(onTheme).toHaveBeenCalledWith('dark')
})

test('Escape calls onClose', async () => {
  const { onClose } = await open()
  await userEvent.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalled()
})

test('clicking the backdrop calls onClose', async () => {
  const { onClose } = await open()
  await userEvent.click(screen.getByTestId('palette-backdrop'))
  expect(onClose).toHaveBeenCalled()
})

test('a query of 2+ characters searches incidents once after the 200ms debounce', async () => {
  await open()
  vi.useFakeTimers()
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: 'r' } })
  fireEvent.change(input, { target: { value: 'rd' } })
  await act(async () => { vi.advanceTimersByTime(150) })
  expect(api.fetchWorkItems).not.toHaveBeenCalled()
  await act(async () => { vi.advanceTimersByTime(100) })
  expect(api.fetchWorkItems).toHaveBeenCalledTimes(1)
  expect(api.fetchWorkItems).toHaveBeenCalledWith({ q: 'rd', limit: 8 })
})

test('choosing "Open RDBMS_PRIMARY" selects that incident', async () => {
  api.fetchWorkItems.mockResolvedValue({
    items: [{ id: 'wi-1', component: 'RDBMS_PRIMARY', priority: 'P0', status: 'OPEN' }], next_cursor: null,
  })
  const { onSelectIncident, onClose } = await open()
  await userEvent.type(screen.getByRole('combobox'), 'rd')
  await userEvent.click(await screen.findByRole('option', { name: /Open RDBMS_PRIMARY/ }, { timeout: 2000 }))
  expect(onSelectIncident).toHaveBeenCalledWith('wi-1')
  expect(onClose).toHaveBeenCalled()
})

test('a failed incident search shows no Incidents group and no toast', async () => {
  api.fetchWorkItems.mockRejectedValue(new Error('down'))
  await open()
  await userEvent.type(screen.getByRole('combobox'), 'rd')
  await act(async () => { await new Promise(r => setTimeout(r, 400)) })
  expect(api.fetchWorkItems).toHaveBeenCalled()
  expect(screen.queryByText('Incidents')).toBeNull()
  expect(document.querySelector('.toast')).toBeNull()
})

test('closing returns focus to the element focused before it opened', async () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  const { unmount } = await open()
  expect(document.activeElement).not.toBe(trigger)
  unmount()
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})
