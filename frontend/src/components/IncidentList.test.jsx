import { useState } from 'react'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IncidentList } from './IncidentList'
import { DEFAULT_VIEW } from '../sort'
import * as api from '../api/client'
import { deferred, workItem, httpError, networkError } from '../test/utils'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), fetchWorkItems: vi.fn() }))

// The real page shape: `total` counts every row matching the filters, so it equals the item count once everything is loaded.
const page = (items, next_cursor = null, total = items.length) => ({ items, next_cursor, total })

// The list's view state lives in App; this stands in for it.
function Host(props) {
  const [view, setView] = useState(DEFAULT_VIEW)
  return <IncidentList view={view} setView={setView} {...props} />
}

beforeEach(() => { vi.resetAllMocks() })

// Priority and "Assigned to me" live in the Filters menu; the sort key and order in the Sort menu.
const openMenu = async (name) => {
  await userEvent.click(await screen.findByRole('button', { name }))
  return screen.findByRole('menu')
}
const pickFilter = async (item, role = 'menuitemradio') => {
  await openMenu(/^Filters/)
  await userEvent.click(screen.getByRole(role, { name: item }))
  if (role === 'menuitemcheckbox') await userEvent.keyboard('{Escape}')  // a checkbox item keeps the menu open
}
const sortBy = async (item) => {
  await openMenu(/^Sort:/)
  await userEvent.click(screen.getByRole('menuitemradio', { name: item }))
}

test('a row shows the component name (F-03)', async () => {
  api.fetchWorkItems.mockResolvedValue(page([workItem()]))
  render(<Host onSelect={() => {}} />)
  expect(await screen.findByText('RDBMS_PRIMARY')).toBeTruthy()
})

test('filter pills and incident rows are buttons (F-08)', async () => {
  api.fetchWorkItems.mockResolvedValue(page([workItem()]))
  render(<Host onSelect={() => {}} />)
  expect(await screen.findByRole('button', { name: /RDBMS_PRIMARY/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Active' })).toBeTruthy()
})

test('clicking a row selects it', async () => {
  api.fetchWorkItems.mockResolvedValue(page([workItem()]))
  const onSelect = vi.fn()
  render(<Host onSelect={onSelect} />)
  await userEvent.click(await screen.findByRole('button', { name: /RDBMS_PRIMARY/ }))
  expect(onSelect).toHaveBeenCalledWith('wi-1')
})

test('clicking the RESOLVED pill fetches RESOLVED incidents', async () => {
  api.fetchWorkItems.mockResolvedValue(page([]))
  render(<Host onSelect={() => {}} />)
  await userEvent.click(await screen.findByRole('button', { name: 'Resolved' }))
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'RESOLVED', limit: 100 }))
})

test('a late response for an old filter never overwrites the newer one (F-12)', async () => {
  const first = deferred()
  const second = deferred()
  api.fetchWorkItems.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  render(<Host onSelect={() => {}} />)
  await userEvent.click(screen.getByText('Resolved'))
  await act(async () => { second.resolve(page([workItem({ id: 'b', component: 'COMP_NEW' })])) })
  await act(async () => { first.resolve(page([workItem({ id: 'a', component: 'COMP_OLD' })])) })
  expect(screen.queryByText('COMP_OLD')).toBeNull()
  expect(screen.getByText('COMP_NEW')).toBeTruthy()
})

test('the critical count includes only P0 incidents that are still active', async () => {
  api.fetchWorkItems.mockResolvedValue(page([
    workItem({ id: 'a', component: 'P0_OPEN', status: 'OPEN', assignee_id: 'u2', assignee_username: 'alice' }),
    workItem({ id: 'b', component: 'P0_INV', status: 'INVESTIGATING', assignee_id: 'u2', assignee_username: 'alice' }),
    workItem({ id: 'c', component: 'P0_RESOLVED', status: 'RESOLVED' }),
    workItem({ id: 'd', component: 'P0_CLOSED', status: 'CLOSED' }),
    workItem({ id: 'e', component: 'P1_OPEN', priority: 'P1', status: 'OPEN' }),
  ]))
  render(<Host onSelect={() => {}} />)
  expect(await screen.findByText('2 critical')).toBeTruthy()
  const row = (name) => screen.getByRole('button', { name: new RegExp(name) })
  // The P0 chip is the row's one severity carrier: no row gets a red edge marker of its own any more.
  for (const name of ['P0_OPEN', 'P0_INV', 'P0_RESOLVED', 'P1_OPEN']) expect(row(name).hasAttribute('data-p0')).toBe(false)
})

test('"Load more" appears only when the server has another page, and asks for a larger limit (B-18)', async () => {
  api.fetchWorkItems.mockResolvedValueOnce(page([workItem()], 'cursor-1'))
  render(<Host onSelect={() => {}} />)
  const more = await screen.findByRole('button', { name: 'Load more' })
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ACTIVE', limit: 100 }))

  api.fetchWorkItems.mockResolvedValueOnce(page([workItem(), workItem({ id: 'wi-2', component: 'CACHE_X' })]))
  await userEvent.click(more)

  expect(await screen.findByText('CACHE_X')).toBeTruthy()
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ACTIVE', limit: 200 }))
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
})

test('typing in search refetches with q only after the 300 ms debounce', async () => {
  vi.useFakeTimers()
  try {
    api.fetchWorkItems.mockResolvedValue(page([]))
    render(<Host onSelect={() => {}} />)
    await act(async () => {})
    const input = screen.getByLabelText('Search components')
    expect(input.getAttribute('name')).toBe('q')
    fireEvent.change(input, { target: { value: 'rdbms' } })
    await act(async () => { vi.advanceTimersByTime(299) })
    expect(api.fetchWorkItems).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(2) })
    expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'rdbms' }))
  } finally { vi.useRealTimers() }
})

test('the Filters menu passes priority and assignee=me, and its button names what is active', async () => {
  api.fetchWorkItems.mockResolvedValue(page([]))
  render(<Host onSelect={() => {}} />)
  expect(await screen.findByRole('button', { name: 'Filters' })).toBeTruthy()
  await pickFilter('P0')
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'P0' }))
  expect(screen.getByRole('button', { name: 'Filters: P0' })).toBeTruthy()

  await openMenu(/^Filters/)
  const mine = screen.getByRole('menuitemcheckbox', { name: 'Assigned to me' })
  expect(mine.getAttribute('aria-checked')).toBe('false')
  await userEvent.click(mine)
  await userEvent.keyboard('{Escape}')  // a checkbox item keeps the menu open
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'P0', assignee: 'me' }))
  expect(screen.getByRole('button', { name: 'Filters: P0, assigned to me' })).toBeTruthy()

  await pickFilter('Assigned to me', 'menuitemcheckbox')
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ assignee: undefined }))
  await pickFilter('Any priority')
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ priority: undefined }))
  expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy()
})

test('rows show the assignee, or Unassigned', async () => {
  api.fetchWorkItems.mockResolvedValue(page([
    workItem({ id: 'a', component: 'WITH_OWNER', assignee_id: 'u2', assignee_username: 'alice' }),
    workItem({ id: 'b', component: 'NO_OWNER' }),
  ]))
  render(<Host onSelect={() => {}} />)
  const owned = await screen.findByRole('button', { name: /WITH_OWNER/ })
  const free = screen.getByRole('button', { name: /NO_OWNER/ })
  expect(owned.textContent).toContain('alice')
  expect(free.textContent).toContain('Unassigned')
})

describe('sorting', () => {
  const order = () => [...document.querySelectorAll('[data-incident-id]')].map(el => el.dataset.incidentId)
  const three = (next = null) => page([
    workItem({ id: 'b', component: 'COMP_B' }), workItem({ id: 'c', component: 'COMP_C' }), workItem({ id: 'a', component: 'COMP_A' }),
  ], next)
  test('the Sort menu offers every key with Priority checked, and there are no column headers', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    render(<Host onSelect={() => {}} />)
    await screen.findByText('COMP_A')
    expect(screen.getByRole('button', { name: 'Sort: Priority, ascending' })).toBeTruthy()
    await openMenu(/^Sort:/)
    for (const name of ['Priority', 'SLA', 'Age', 'Component', 'Status', 'Assignee']) expect(screen.getByRole('menuitemradio', { name })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'Priority' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('group', { name: 'Sort incidents' })).toBeNull()
  })

  test('sorting by Component orders the rows A-Z, then Descending Z-A', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    render(<Host onSelect={() => {}} />)
    await screen.findByText('COMP_A')
    expect(order()).toEqual(['b', 'c', 'a'])
    await sortBy('Component')
    expect(order()).toEqual(['a', 'b', 'c'])
    expect(screen.getByRole('button', { name: 'Sort: Component, ascending' })).toBeTruthy()
    await sortBy('Descending')
    expect(order()).toEqual(['c', 'b', 'a'])
    expect(screen.getByRole('button', { name: 'Sort: Component, descending' })).toBeTruthy()
  })

  test('j follows the sorted order: from no selection it picks the alphabetically first row', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    const onSelect = vi.fn()
    render(<Host onSelect={onSelect} />)
    await screen.findByText('COMP_A')
    await sortBy('Component')
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(onSelect).toHaveBeenLastCalledWith('a')
  })

  test('with more pages on the server the list says its order only covers the loaded rows, under any sort', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ id: 'b', component: 'COMP_B' }), workItem({ id: 'a', component: 'COMP_A' })], 'cursor-1', 152))
    render(<Host onSelect={() => {}} />)
    await screen.findByText('COMP_A')
    expect(screen.getByText('Sorted within the 2 loaded')).toBeTruthy()  // the default sort is client-side too
    await sortBy('Component')
    expect(screen.getByText('Sorted within the 2 loaded')).toBeTruthy()
  })

  test('no hint without another page, under the default or a non-default sort', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    render(<Host onSelect={() => {}} />)
    await screen.findByText('COMP_A')
    expect(screen.queryByText(/Sorted within/)).toBeNull()
    await sortBy('Component')
    expect(screen.queryByText(/Sorted within/)).toBeNull()
  })
})

describe('keyboard shortcuts', () => {
  const three = () => page([
    workItem({ id: 'a', component: 'COMP_A' }), workItem({ id: 'b', component: 'COMP_B' }), workItem({ id: 'c', component: 'COMP_C' }),
  ])
  const press = (key, init = {}) => fireEvent.keyDown(document.body, { key, ...init })

  test('j and k move the selection through the list without wrapping', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    const onSelect = vi.fn()
    const { rerender } = render(<Host onSelect={onSelect} selectedId={undefined} />)
    await screen.findByText('COMP_A')
    press('j')
    expect(onSelect).toHaveBeenLastCalledWith('a')
    rerender(<Host onSelect={onSelect} selectedId="a" />)
    press('j')
    expect(onSelect).toHaveBeenLastCalledWith('b')
    rerender(<Host onSelect={onSelect} selectedId="b" />)
    press('k')
    expect(onSelect).toHaveBeenLastCalledWith('a')
    onSelect.mockClear()
    rerender(<Host onSelect={onSelect} selectedId="a" />)
    press('k')
    expect(onSelect).not.toHaveBeenCalled()
    rerender(<Host onSelect={onSelect} selectedId="c" />)
    press('j')
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('/ focuses the search box, and typing j there does not move the selection', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    const onSelect = vi.fn()
    render(<Host onSelect={onSelect} />)
    await screen.findByText('COMP_A')
    press('/')
    const search = screen.getByRole('searchbox', { name: 'Search components' })
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'j' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('shortcuts with Ctrl, Meta or Alt are ignored', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    const onSelect = vi.fn()
    render(<Host onSelect={onSelect} />)
    await screen.findByText('COMP_A')
    press('j', { ctrlKey: true }); press('j', { metaKey: true }); press('j', { altKey: true })
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('the listener is removed on unmount', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    const onSelect = vi.fn()
    const { unmount } = render(<Host onSelect={onSelect} />)
    await screen.findByText('COMP_A')
    unmount()
    press('j')
    expect(onSelect).not.toHaveBeenCalled()
  })
})

test('a failed load shows the error and not the all-quiet empty state (F-34)', async () => {
  api.fetchWorkItems.mockRejectedValue(new Error('network'))
  render(<Host onSelect={() => {}} />)
  expect(await screen.findByText(/Could not load incidents/)).toBeTruthy()
  expect(screen.queryByText(/All quiet/)).toBeNull()
})

test('the full component name is available as a tooltip (F-42)', async () => {
  api.fetchWorkItems.mockResolvedValue(page([workItem({ component: 'A_VERY_LONG_COMPONENT_NAME_FOR_THE_ROW' })]))
  render(<Host onSelect={() => {}} />)
  expect((await screen.findByText('A_VERY_LONG_COMPONENT_NAME_FOR_THE_ROW')).title).toBe('A_VERY_LONG_COMPONENT_NAME_FOR_THE_ROW')
})

describe('UX step 2: quieter list', () => {
  const HOUR = 3_600_000, MIN = 60_000
  const lateBy = (ms) => new Date(Date.now() - ms - 30_000).toISOString()  // 30 s of slack so a stale clock tick cannot round it down
  const timerFor = async (text) => (await screen.findByText(text)).closest('.sla-timer')

  test('a P2 breached 2 hours ago shows its age in the muted level, with the word for screen readers', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ priority: 'P2', sla_deadline: lateBy(2 * HOUR) })]))
    render(<Host onSelect={() => {}} />)
    const timer = await timerFor('+2h 0m')
    expect(timer.dataset.level).toBe('muted')
    expect(screen.getByText('+2h 0m').getAttribute('aria-hidden')).toBe('true')
    expect(timer.querySelector('.sr-only').textContent).toMatch(/breached 2 hours 0 minutes ago/)
    expect(screen.queryByText('BREACHED')).toBeNull()
  })

  test('a P0 breached 2 hours ago is muted like any other old breach: the P0 chip carries the severity', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ priority: 'P0', sla_deadline: lateBy(2 * HOUR) })]))
    render(<Host onSelect={() => {}} />)
    expect((await timerFor('+2h 0m')).dataset.level).toBe('muted')
  })

  test('a P0 that breached only 10 minutes ago is still red', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ priority: 'P0', sla_deadline: lateBy(10 * MIN) })]))
    render(<Host onSelect={() => {}} />)
    expect((await timerFor('+10m')).dataset.level).toBe('p0')
  })

  test('a P2 that breached only 10 minutes ago is still red', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ priority: 'P2', sla_deadline: lateBy(10 * MIN) })]))
    render(<Host onSelect={() => {}} />)
    expect((await timerFor('+10m')).dataset.level).toBe('p0')
  })

  test('a countdown that has not breached is unchanged', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ priority: 'P2', sla_deadline: new Date(Date.now() + 2 * HOUR + 30_000).toISOString() })]))
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('RDBMS_PRIMARY')
    const timer = container.querySelector('.sla-timer')
    expect(timer.dataset.level).toBe('p3')
    expect(timer.textContent).toMatch(/^2h \d+m \d+s$/)
  })

  test('the status pills read Active, Resolved, Closed and All in sentence case, with Active pressed and fetched first', async () => {
    api.fetchWorkItems.mockResolvedValue(page([]))
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('All quiet, systems nominal.')
    const pills = [...container.querySelectorAll('.seg .pill')]
    expect(pills.map(p => p.textContent)).toEqual(['Active', 'Resolved', 'Closed', 'All'])
    expect(pills.map(p => p.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false'])
    expect(api.fetchWorkItems.mock.calls[0][0].status).toBe('ACTIVE')
  })

  test('ALL asks for every status, and a non-default filter with no rows says so', async () => {
    api.fetchWorkItems.mockResolvedValue(page([]))
    render(<Host onSelect={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Closed' }))
    expect(await screen.findByText('No incidents match these filters.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined }))
  })

  test('the critical count is a button that shows the active P0s', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ id: 'a', component: 'P0_OPEN' })]))
    render(<Host onSelect={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'All' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show 1 critical incident, 1 unowned' }))
    expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'P0', status: 'ACTIVE' }))
    expect(screen.getByRole('button', { name: 'Filters: P0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('onLoaded reports the ids of the active P0s of a load in order, or an empty list when there are none', async () => {
    const onLoaded = vi.fn()
    api.fetchWorkItems.mockResolvedValueOnce(page([
      workItem({ id: 'x', priority: 'P0', status: 'RESOLVED' }),
      workItem({ id: 'a', component: 'FIRST_P0', priority: 'P0', status: 'INVESTIGATING' }),
      workItem({ id: 'b', priority: 'P0', status: 'OPEN' }),
    ]))
    render(<Host onSelect={() => {}} onLoaded={onLoaded} />)
    await screen.findByText('FIRST_P0')
    expect(onLoaded).toHaveBeenLastCalledWith(['a', 'b'])
    api.fetchWorkItems.mockResolvedValueOnce(page([workItem({ priority: 'P1' })]))
    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(onLoaded).toHaveBeenLastCalledWith([]))
  })
})

describe('second critique: list', () => {
  const HOUR = 3_600_000
  const due = (ms) => new Date(Date.now() + ms).toISOString()

  test('onLoaded lists the critical incidents most overdue first, not in server order', async () => {
    api.fetchWorkItems.mockResolvedValue(page([
      workItem({ id: 'fresh', component: 'FRESH', sla_deadline: due(HOUR) }),
      workItem({ id: 'overdue', component: 'OVERDUE', sla_deadline: due(-5 * HOUR) }),
    ]))
    const onLoaded = vi.fn()
    render(<Host onSelect={() => {}} onLoaded={onLoaded} />)
    await screen.findByText('OVERDUE')
    // onLoaded fires from an effect, which can land just after the rows appear: wait for it rather than race it
    await waitFor(() => expect(onLoaded).toHaveBeenLastCalledWith(['overdue', 'fresh']))
    expect([...document.querySelectorAll('[data-incident-id]')].map(el => el.dataset.incidentId)).toEqual(['overdue', 'fresh'])
  })

  test('the selected row has aria-current, the others do not', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ id: 'a', component: 'COMP_A' }), workItem({ id: 'b', component: 'COMP_B' })]))
    render(<Host onSelect={() => {}} selectedId="b" />)
    await screen.findByText('COMP_A')
    expect(document.querySelector('[data-incident-id="b"]').getAttribute('aria-current')).toBe('true')
    expect(document.querySelector('[data-incident-id="a"]').getAttribute('aria-current')).toBeNull()
  })

  test('rows are one line: the component name only, no subtitle', async () => {
    api.fetchWorkItems.mockResolvedValue(page([
      workItem({ id: 'a', component: 'RDBMS_X', title: 'RDBMS_X - ERROR' }),
      workItem({ id: 'b', component: 'CACHE_Y', title: 'Something else entirely' }),
    ]))
    render(<Host onSelect={() => {}} />)
    await screen.findByText('RDBMS_X')
    expect(document.querySelector('.row-title')).toBeNull()
    expect(document.querySelector('[data-incident-id="a"]').textContent).not.toMatch(/ERROR/)
    expect(document.querySelector('[data-incident-id="b"]').textContent).not.toMatch(/Something else/)
  })

  describe('root-cause cue: unowned critical incidents', () => {
    const mix = () => page([
      workItem({ id: 'a', component: 'P0_FREE' }),
      workItem({ id: 'b', component: 'P0_OWNED', assignee_id: 'u2', assignee_username: 'alice' }),
      workItem({ id: 'c', component: 'P2_FREE', priority: 'P2' }),
    ])
    const cell = (id) => document.querySelector(`[data-incident-id="${id}"] .row-assignee`)

    test('the counter says how many critical incidents have no owner, and its name says so too', async () => {
      api.fetchWorkItems.mockResolvedValue(mix())
      render(<Host onSelect={() => {}} />)
      expect(await screen.findByText('2 critical · 1 unowned')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Show 2 critical incidents, 1 unowned' })).toBeTruthy()
    })

    test('with every critical incident owned the counter is just the count', async () => {
      api.fetchWorkItems.mockResolvedValue(page([workItem({ id: 'b', assignee_id: 'u2', assignee_username: 'alice' })]))
      render(<Host onSelect={() => {}} />)
      expect(await screen.findByText('1 critical')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Show 1 critical incident' })).toBeTruthy()
    })

    test('an unowned critical row shows a ring and the word, an unowned P2 or an owned P0 does not', async () => {
      api.fetchWorkItems.mockResolvedValue(mix())
      render(<Host onSelect={() => {}} />)
      await screen.findByText('P0_FREE')
      expect(cell('a').dataset.unowned).toBe('true')
      expect(cell('a').querySelector('.unowned-ring')).not.toBeNull()
      expect(cell('a').textContent).toBe('Unassigned')
      expect(cell('b').dataset.unowned).toBeUndefined()
      expect(cell('b').querySelector('.unowned-ring')).toBeNull()
      expect(cell('c').dataset.unowned).toBeUndefined()
      expect(cell('c').textContent).toBe('Unassigned')
    })
  })

  describe('an open incident that is not among the rows', () => {
    const info = { id: 'gone', component: 'RDBMS_T2_A', status: 'CLOSED' }

    test('a one-line bar names it, and Show all widens the view to every status', async () => {
      api.fetchWorkItems.mockResolvedValue(page([workItem({ id: 'a', component: 'COMP_A' })]))
      render(<Host onSelect={() => {}} selectedId="gone" selectedInfo={info} />)
      await screen.findByText('COMP_A')
      expect(screen.getByText('RDBMS_T2_A (CLOSED) is not in this view.')).toBeTruthy()
      await userEvent.click(screen.getByRole('button', { name: 'Show all' }))
      expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined }))
      expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    })

    test('no bar while it is in the rows, or with nothing selected', async () => {
      api.fetchWorkItems.mockResolvedValue(page([workItem({ id: 'gone', component: 'RDBMS_T2_A' })]))
      const { rerender } = render(<Host onSelect={() => {}} selectedId="gone" selectedInfo={info} />)
      await screen.findByText('RDBMS_T2_A')
      expect(screen.queryByText(/is not in this view/)).toBeNull()
      rerender(<Host onSelect={() => {}} selectedId={null} selectedInfo={null} />)
      expect(screen.queryByText(/is not in this view/)).toBeNull()
    })

    test('no bar before the first load finishes', async () => {
      const d = deferred()
      api.fetchWorkItems.mockReturnValue(d.promise)
      render(<Host onSelect={() => {}} selectedId="gone" selectedInfo={info} />)
      expect(screen.queryByText(/is not in this view/)).toBeNull()
      await act(async () => { d.resolve(page([])) })
      expect(screen.getByText(/is not in this view/)).toBeTruthy()
    })

    test('no bar when the view already shows everything (Show all could not help)', async () => {
      api.fetchWorkItems.mockResolvedValue(page([workItem({ id: 'a', component: 'COMP_A' })]))
      render(<Host onSelect={() => {}} selectedId="gone" selectedInfo={info} />)
      await screen.findByText('COMP_A')
      await userEvent.click(screen.getByRole('button', { name: 'Show all' }))
      await screen.findByText('COMP_A')
      expect(screen.queryByText(/is not in this view/)).toBeNull()
    })
  })
})

describe('fourth critique: an honest list', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => workItem({ id: `w${i}`, component: `COMP_${i}` }))
  const count = (container) => container.querySelector('.list-count')

  test('with another page the count reads "loaded of total"', async () => {
    api.fetchWorkItems.mockResolvedValue(page(rows(3), 'cursor-1', 152))
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('COMP_0')
    expect(count(container).textContent).toBe('3 of 152')
  })

  test('with everything loaded the count is just the total', async () => {
    api.fetchWorkItems.mockResolvedValue(page(rows(3)))
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('COMP_0')
    expect(count(container).textContent).toBe('3')
  })

  test('an empty list reads 0 beside the empty state', async () => {
    api.fetchWorkItems.mockResolvedValue(page([]))
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('No incidents')
    expect(count(container).textContent).toBe('0')
  })

  test('an API without a total shows no count rather than a wrong one', async () => {
    api.fetchWorkItems.mockResolvedValue({ items: rows(3), next_cursor: 'cursor-1' })
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('COMP_0')
    expect(count(container)).toBeNull()
  })

  test('the count sits next to the Incidents heading', async () => {
    api.fetchWorkItems.mockResolvedValue(page(rows(2)))
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('COMP_0')
    expect(screen.getByRole('heading', { name: 'Incidents' }).nextElementSibling).toBe(count(container))
  })

  test('the critical counter is a dot plus neutral text: the dot is the only red', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ status: 'OPEN' })]))
    render(<Host onSelect={() => {}} />)
    const counter = await screen.findByRole('button', { name: /Show 1 critical incident/ })
    const dot = counter.querySelector('.critical-dot')
    expect(dot).not.toBeNull()
    expect(dot.getAttribute('aria-hidden')).toBe('true')
    expect(counter.firstElementChild).toBe(dot)
    expect(counter.textContent).toBe('1 critical · 1 unowned')
    expect(counter.hasAttribute('data-level')).toBe(false)
  })

  test('an unowned critical row keeps its red Unassigned marker (ownership is an act-now signal)', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ status: 'OPEN' })]))
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('RDBMS_PRIMARY')
    expect(container.querySelector('.row-assignee').dataset.unowned).toBe('true')
    expect(container.querySelector('.unowned-ring')).not.toBeNull()
  })
})

describe('fifth critique: phone rows keep the owner', () => {
  test('a row keeps the assignee cell and the status word in the DOM (the narrow container hides the word visually only)', async () => {
    api.fetchWorkItems.mockResolvedValue(page([
      workItem({ id: 'a', component: 'OWNED', status: 'INVESTIGATING', assignee_id: 'u2', assignee_username: 'alice' }),
      workItem({ id: 'b', component: 'NOBODY', priority: 'P0', status: 'OPEN' }),
      workItem({ id: 'c', component: 'LOW', priority: 'P3', status: 'OPEN' }),
    ]))
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('OWNED')
    const row = (name) => [...container.querySelectorAll('.incident-row')].find(r => r.textContent.includes(name))
    expect(row('OWNED').querySelector('[data-col="assignee"]').textContent).toContain('alice')
    expect(row('OWNED').querySelector('[data-col="status"] .status-word').textContent).toBe('Investigating')
    expect(row('NOBODY').querySelector('[data-col="assignee"]').textContent).toBe('Unassigned')
    expect(row('NOBODY').querySelector('[data-col="assignee"] .unowned-ring')).not.toBeNull()
    expect(row('LOW').querySelector('[data-col="assignee"] .unowned-ring')).toBeNull()
  })
})

describe('harden', () => {
  test('a failed load says the server cannot be reached, and Try again fetches the same page again', async () => {
    api.fetchWorkItems.mockRejectedValueOnce(networkError()).mockResolvedValue(page([workItem()]))
    render(<Host onSelect={() => {}} />)
    expect(await screen.findByText(/Can't reach the server/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('RDBMS_PRIMARY')).toBeTruthy()
    expect(api.fetchWorkItems).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Can't reach the server/)).toBeNull()
  })

  test('a server error on Load more keeps the rows and offers Try again', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => workItem({ id: `w${i}`, component: `COMP_${i}` }))
    api.fetchWorkItems.mockResolvedValueOnce(page(rows, 'c1', 150)).mockRejectedValueOnce(httpError(500, 'Internal Server Error'))
    render(<Host onSelect={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByText(/The server hit an error/)).toBeTruthy()
    expect(screen.getByText('COMP_0')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  test('one critical incident reads in the singular, several in the plural', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ assignee_id: 'u1', assignee_username: 'me' })]))
    const { unmount } = render(<Host onSelect={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Show 1 critical incident' })).toBeTruthy()
    unmount()
    api.fetchWorkItems.mockResolvedValue(page([
      workItem({ id: 'a', assignee_id: 'u1' }), workItem({ id: 'b', component: 'B', assignee_id: 'u1' }),
    ]))
    render(<Host onSelect={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Show 2 critical incidents' })).toBeTruthy()
  })

  test('the totals use thousands separators', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem()], 'c1', 12345))
    const { container } = render(<Host onSelect={() => {}} />)
    await screen.findByText('RDBMS_PRIMARY')
    expect(container.querySelector('.list-count').textContent).toBe('1 of 12,345')
  })
})

describe('RCA due marker on resolved rows', () => {
  const HOUR = 3600_000
  const ago = (ms) => new Date(Date.now() - ms).toISOString()
  const slaCell = async (over) => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ status: 'RESOLVED', end_time: null, resolved_at: ago(HOUR - 60_000), ...over })]))
    render(<Host onSelect={() => {}} />)
    const row = await screen.findByRole('button', { name: /RDBMS_PRIMARY/ })
    return row.querySelector('[data-col="sla"]')
  }

  test('resolved an hour ago with no RCA: RCA due, in quiet text', async () => {
    const cell = await slaCell({})
    expect(cell.textContent).toContain('RCA in 1d')
    expect(cell.querySelector('.sr-only').textContent).toBe('RCA due in 1 day 23 hours')
    expect(cell.querySelector('[data-level]')).toBeNull()
  })

  test('resolved 3 days ago with no RCA: RCA overdue, with the muted breach dot', async () => {
    const cell = await slaCell({ resolved_at: ago(72 * HOUR + 60_000) })
    expect(cell.textContent).toContain('RCA +1d')
    expect(cell.querySelector('.sr-only').textContent).toBe('RCA overdue by 1 day 0 hours')
    expect(cell.querySelector('.sla-timer').dataset.level).toBe('muted')
  })

  test('no marker once an RCA exists', async () => {
    expect((await slaCell({ end_time: ago(HOUR / 2) })).textContent).toBe('')
  })

  test('no marker on a closed incident', async () => {
    expect((await slaCell({ status: 'CLOSED', resolved_at: ago(72 * HOUR) })).textContent).toBe('')
  })
})

describe('redesign: two-line rows', () => {
  test('line 1 holds the priority, the component and the SLA; line 2 the status, the owner and the age', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({
      id: 'a', component: 'RDBMS_PRIMARY', priority: 'P1', status: 'INVESTIGATING', assignee_id: 'u2', assignee_username: 'alice',
      sla_deadline: new Date(Date.now() - 2.5 * 3600_000).toISOString(),  // off the hour boundary: the shared clock can lag a moment
    })]))
    render(<Host onSelect={() => {}} />)
    const row = await screen.findByRole('button', { name: /RDBMS_PRIMARY/ })
    const [line1, line2] = row.querySelectorAll('.row-line')
    expect(line1.querySelector('[data-col="priority"]').textContent).toBe('P1')
    expect(line1.querySelector('[data-col="component"]').textContent).toBe('RDBMS_PRIMARY')
    expect(line1.querySelector('[data-col="sla"]').textContent).toContain('+2h')
    expect(line2.querySelector('[data-col="status"]').textContent).toBe('Investigating')
    expect(line2.querySelector('[data-col="assignee"]').textContent).toContain('alice')
    expect(line2.querySelector('[data-col="age"]').textContent).toBe('1h')
  })
})
