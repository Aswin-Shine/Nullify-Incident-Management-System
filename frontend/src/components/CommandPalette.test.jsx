import { screen, act, fireEvent, within } from '@testing-library/react'
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
  const fns = {
    onClose: vi.fn(), onGo: vi.fn(), onTheme: vi.fn(), onSelectIncident: vi.fn(),
    onStartInvestigating: vi.fn(), onAssignMe: vi.fn(), onResolve: vi.fn(), onCopyLink: vi.fn(),
  }
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

const groupNames = () => screen.getAllByRole('group').map(g => g.getAttribute('aria-label'))

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

test('a pointer resting under the list does not steal the highlight, so Enter runs the first option', async () => {
  const { onGo } = await open()
  fireEvent.mouseEnter(screen.getAllByRole('option')[2])  // no real movement: the list just appeared under the pointer
  expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
  await userEvent.keyboard('{Enter}')
  expect(onGo).toHaveBeenCalledWith('incidents')
})

test('once the mouse really moves, hovering an option highlights it', async () => {
  const { onGo } = await open()
  fireEvent.mouseMove(screen.getByRole('listbox'))
  fireEvent.mouseEnter(screen.getAllByRole('option')[1])
  expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
  await userEvent.keyboard('{Enter}')
  expect(onGo).toHaveBeenCalledWith('analytics')
})

describe('third critique: palette actions', () => {
  const inc = (over = {}) => ({ id: 'wi-1', component: 'RDBMS_PRIMARY', status: 'OPEN', assignee_id: null, ...over })

  test('an open OPEN incident gets a "This incident" group first, and Start investigating runs the handler', async () => {
    const incident = inc()
    const { onStartInvestigating, onClose } = await open('sre', { incident })
    expect(groupNames()[0]).toBe('This incident')
    expect(optionNames()).not.toContain('Mark resolved RDBMS_PRIMARY')
    await userEvent.click(screen.getByRole('option', { name: 'Start investigating RDBMS_PRIMARY' }))
    expect(onStartInvestigating).toHaveBeenCalledWith(incident)
    expect(onClose).toHaveBeenCalled()
  })

  test('an INVESTIGATING incident offers Mark resolved, which hands over to onResolve, and no Start investigating', async () => {
    const incident = inc({ status: 'INVESTIGATING' })
    const { onResolve } = await open('sre', { incident })
    expect(optionNames()).not.toContain('Start investigating RDBMS_PRIMARY')
    await userEvent.click(screen.getByRole('option', { name: 'Mark resolved RDBMS_PRIMARY' }))
    expect(onResolve).toHaveBeenCalledWith(incident)
  })

  test('Assign to me runs the handler, and is not offered when you already own it or it is CLOSED', async () => {
    const incident = inc()
    const { onAssignMe, unmount } = await open('sre', { incident })
    await userEvent.click(screen.getByRole('option', { name: 'Assign RDBMS_PRIMARY to me' }))
    expect(onAssignMe).toHaveBeenCalledWith(incident)
    unmount()
    const mine = await open('sre', { incident: inc({ assignee_id: 'u1' }) })
    expect(optionNames()).not.toContain('Assign RDBMS_PRIMARY to me')
    mine.unmount()
    await open('sre', { incident: inc({ status: 'CLOSED' }) })
    expect(optionNames()).not.toContain('Assign RDBMS_PRIMARY to me')
  })

  test('Copy link is offered in every state, even CLOSED', async () => {
    const incident = inc({ status: 'CLOSED' })
    const { onCopyLink } = await open('sre', { incident })
    expect(optionNames().filter(n => /Start|Mark|Assign/.test(n))).toEqual([])
    await userEvent.click(screen.getByRole('option', { name: 'Copy link to RDBMS_PRIMARY' }))
    expect(onCopyLink).toHaveBeenCalledWith(incident)
  })

  test('a viewer gets no "This incident" group', async () => {
    await open('viewer', { incident: inc() })
    expect(groupNames()).not.toContain('This incident')
    expect(optionNames().join('|')).not.toMatch(/Start investigating|Assign|Copy link/)
  })

  test('with no incident open there is no "This incident" group', async () => {
    await open('sre')
    expect(groupNames()).not.toContain('This incident')
  })

  test('typing narrows the incident actions like any other command', async () => {
    await open('sre', { incident: inc() })
    await userEvent.type(screen.getByRole('combobox'), 'copy link')
    expect(optionNames()).toEqual(['Copy link to RDBMS_PRIMARY'])
  })

  test('"Open next critical" shows only when a handler is given, and runs it', async () => {
    const { unmount } = await open('sre')
    expect(optionNames()).not.toContain('Open next critical')
    unmount()
    const onNextCritical = vi.fn()
    const { onClose } = await open('sre', { onNextCritical })
    await userEvent.click(screen.getByRole('option', { name: 'Open next critical' }))
    expect(onNextCritical).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  test('"Go to" is not offered for the tab you are already on', async () => {
    await open('sre', { activeTab: 'incidents' })
    expect(optionNames()).not.toContain('Go to Incidents')
    expect(optionNames()).toContain('Go to Analytics')
  })

  test('incident search lists active incidents first, then by priority, keeping the server order otherwise', async () => {
    const row = (id, priority, status) => ({ id, component: `C_${id}`, priority, status })
    api.fetchWorkItems.mockResolvedValue({
      items: [row('closed-p0', 'P0', 'CLOSED'), row('open-p2', 'P2', 'OPEN'), row('res-p1', 'P1', 'RESOLVED'),
        row('inv-p0', 'P0', 'INVESTIGATING'), row('open-p2b', 'P2', 'OPEN')],
      next_cursor: null,
    })
    await open()
    await userEvent.type(screen.getByRole('combobox'), 'c_')
    await screen.findByRole('option', { name: /Open C_closed-p0/ }, { timeout: 2000 })
    const found = [...document.querySelectorAll('.palette-label')].map(l => l.textContent).filter(t => t.startsWith('Open C_'))
    expect(found.map(t => t.slice(5))).toEqual(['C_inv-p0', 'C_open-p2', 'C_open-p2b', 'C_closed-p0', 'C_res-p1'])
  })

  test('the current theme is marked, in text and with a check, and the others are not', async () => {
    await open('sre', { theme: 'dark' })
    const dark = screen.getByRole('option', { name: 'Theme: Dark (current)' })
    expect(dark.querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('option', { name: 'Theme: Light' }).querySelector('svg')).toBeNull()
    expect(screen.getByRole('option', { name: 'Theme: System' })).toBeTruthy()
  })

  test('Log out is alone in the last group, Session', async () => {
    await open('sre', { incident: inc() })
    const names = groupNames()
    expect(names.at(-1)).toBe('Session')
    expect(names).toEqual(['This incident', 'Navigate', 'Preferences', 'Session'])
    expect(within(screen.getByRole('group', { name: 'Session' })).getAllByRole('option').map(o => o.textContent)).toEqual(['Log out'])
    expect(within(screen.getByRole('group', { name: 'Preferences' })).queryByRole('option', { name: 'Log out' })).toBeNull()
  })

  test('a label is one line with the full text in the tooltip', async () => {
    await open('sre')
    const label = screen.getByRole('option', { name: 'Go to Analytics' }).querySelector('.palette-label')
    expect(label.title).toBe('Go to Analytics')
  })
})
