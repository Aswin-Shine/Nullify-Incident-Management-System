import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IncidentList } from './IncidentList'
import * as api from '../api/client'
import { deferred, workItem } from '../test/utils'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), fetchWorkItems: vi.fn() }))

const page = (items, next_cursor = null) => ({ items, next_cursor })

beforeEach(() => { vi.resetAllMocks() })

test('a row shows the component name (F-03)', async () => {
  api.fetchWorkItems.mockResolvedValue(page([workItem()]))
  render(<IncidentList onSelect={() => {}} />)
  expect(await screen.findByText('RDBMS_PRIMARY')).toBeTruthy()
})

test('filter pills and incident rows are buttons (F-08)', async () => {
  api.fetchWorkItems.mockResolvedValue(page([workItem()]))
  render(<IncidentList onSelect={() => {}} />)
  expect(await screen.findByRole('button', { name: /RDBMS_PRIMARY/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'OPEN' })).toBeTruthy()
})

test('clicking a row selects it', async () => {
  api.fetchWorkItems.mockResolvedValue(page([workItem()]))
  const onSelect = vi.fn()
  render(<IncidentList onSelect={onSelect} />)
  await userEvent.click(await screen.findByRole('button', { name: /RDBMS_PRIMARY/ }))
  expect(onSelect).toHaveBeenCalledWith('wi-1')
})

test('clicking the OPEN pill fetches OPEN incidents', async () => {
  api.fetchWorkItems.mockResolvedValue(page([]))
  render(<IncidentList onSelect={() => {}} />)
  await userEvent.click(await screen.findByRole('button', { name: 'OPEN' }))
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'OPEN', limit: 100 }))
})

test('a late response for an old filter never overwrites the newer one (F-12)', async () => {
  const first = deferred()
  const second = deferred()
  api.fetchWorkItems.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  render(<IncidentList onSelect={() => {}} />)
  await userEvent.click(screen.getByText('OPEN'))
  await act(async () => { second.resolve(page([workItem({ id: 'b', component: 'COMP_NEW' })])) })
  await act(async () => { first.resolve(page([workItem({ id: 'a', component: 'COMP_OLD' })])) })
  expect(screen.queryByText('COMP_OLD')).toBeNull()
  expect(screen.getByText('COMP_NEW')).toBeTruthy()
})

test('the critical count and row flag include only P0 incidents that are still active', async () => {
  api.fetchWorkItems.mockResolvedValue(page([
    workItem({ id: 'a', component: 'P0_OPEN', status: 'OPEN' }),
    workItem({ id: 'b', component: 'P0_INV', status: 'INVESTIGATING' }),
    workItem({ id: 'c', component: 'P0_RESOLVED', status: 'RESOLVED' }),
    workItem({ id: 'd', component: 'P0_CLOSED', status: 'CLOSED' }),
    workItem({ id: 'e', component: 'P1_OPEN', priority: 'P1', status: 'OPEN' }),
  ]))
  render(<IncidentList onSelect={() => {}} />)
  expect(await screen.findByText('2 critical')).toBeTruthy()
  const row = (name) => screen.getByRole('button', { name: new RegExp(name) })
  expect(row('P0_OPEN').dataset.p0).toBe('true')
  expect(row('P0_INV').dataset.p0).toBe('true')
  expect(row('P0_RESOLVED').dataset.p0).toBe('false')
  expect(row('P1_OPEN').dataset.p0).toBe('false')
})

test('"Load more" appears only when the server has another page, and asks for a larger limit (B-18)', async () => {
  api.fetchWorkItems.mockResolvedValueOnce(page([workItem()], 'cursor-1'))
  render(<IncidentList onSelect={() => {}} />)
  const more = await screen.findByRole('button', { name: 'Load more' })
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined, limit: 100 }))

  api.fetchWorkItems.mockResolvedValueOnce(page([workItem(), workItem({ id: 'wi-2', component: 'CACHE_X' })]))
  await userEvent.click(more)

  expect(await screen.findByText('CACHE_X')).toBeTruthy()
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined, limit: 200 }))
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
})

test('typing in search refetches with q only after the 300 ms debounce', async () => {
  vi.useFakeTimers()
  try {
    api.fetchWorkItems.mockResolvedValue(page([]))
    render(<IncidentList onSelect={() => {}} />)
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

test('the priority select and "Assigned to me" toggle pass priority and assignee=me', async () => {
  api.fetchWorkItems.mockResolvedValue(page([]))
  render(<IncidentList onSelect={() => {}} />)
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Priority' }), 'P0')
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'P0' }))

  const mine = screen.getByRole('button', { name: 'Assigned to me' })
  expect(mine.getAttribute('aria-pressed')).toBe('false')
  await userEvent.click(mine)
  expect(mine.getAttribute('aria-pressed')).toBe('true')
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'P0', assignee: 'me' }))

  await userEvent.click(mine)
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(expect.objectContaining({ assignee: undefined }))
})

test('rows show the assignee, or Unassigned', async () => {
  api.fetchWorkItems.mockResolvedValue(page([
    workItem({ id: 'a', component: 'WITH_OWNER', assignee_id: 'u2', assignee_username: 'alice' }),
    workItem({ id: 'b', component: 'NO_OWNER' }),
  ]))
  render(<IncidentList onSelect={() => {}} />)
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
  const sortBtn = (name) => screen.getByRole('button', { name: `Sort by ${name}` })

  test('there is one sort button per column and Priority starts pressed', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    render(<IncidentList onSelect={() => {}} />)
    await screen.findByText('COMP_A')
    for (const name of ['Priority', 'Component', 'Status', 'SLA', 'Assignee', 'Age']) expect(sortBtn(name)).toBeTruthy()
    expect(sortBtn('Priority').getAttribute('aria-pressed')).toBe('true')
    expect(sortBtn('Component').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('group', { name: 'Sort incidents' })).toBeTruthy()
  })

  test('clicking Component orders the rows A-Z, a second click Z-A', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    render(<IncidentList onSelect={() => {}} />)
    await screen.findByText('COMP_A')
    expect(order()).toEqual(['b', 'c', 'a'])
    await userEvent.click(sortBtn('Component'))
    expect(order()).toEqual(['a', 'b', 'c'])
    expect(sortBtn('Component').getAttribute('aria-pressed')).toBe('true')
    expect(sortBtn('Priority').getAttribute('aria-pressed')).toBe('false')
    await userEvent.click(sortBtn('Component'))
    expect(order()).toEqual(['c', 'b', 'a'])
  })

  test('j follows the sorted order: from no selection it picks the alphabetically first row', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    const onSelect = vi.fn()
    render(<IncidentList onSelect={onSelect} />)
    await screen.findByText('COMP_A')
    await userEvent.click(sortBtn('Component'))
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(onSelect).toHaveBeenLastCalledWith('a')
  })

  test('with more pages on the server a non-default sort says it only covers the loaded rows', async () => {
    api.fetchWorkItems.mockResolvedValue(page([workItem({ id: 'b', component: 'COMP_B' }), workItem({ id: 'a', component: 'COMP_A' })], 'cursor-1'))
    render(<IncidentList onSelect={() => {}} />)
    await screen.findByText('COMP_A')
    expect(screen.queryByText(/Sorted within/)).toBeNull()
    await userEvent.click(sortBtn('Component'))
    expect(screen.getByText('Sorted within the 2 loaded incidents')).toBeTruthy()
  })

  test('no hint without another page, even under a non-default sort', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    render(<IncidentList onSelect={() => {}} />)
    await screen.findByText('COMP_A')
    await userEvent.click(sortBtn('Component'))
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
    const { rerender } = render(<IncidentList onSelect={onSelect} selectedId={undefined} />)
    await screen.findByText('COMP_A')
    press('j')
    expect(onSelect).toHaveBeenLastCalledWith('a')
    rerender(<IncidentList onSelect={onSelect} selectedId="a" />)
    press('j')
    expect(onSelect).toHaveBeenLastCalledWith('b')
    rerender(<IncidentList onSelect={onSelect} selectedId="b" />)
    press('k')
    expect(onSelect).toHaveBeenLastCalledWith('a')
    onSelect.mockClear()
    rerender(<IncidentList onSelect={onSelect} selectedId="a" />)
    press('k')
    expect(onSelect).not.toHaveBeenCalled()
    rerender(<IncidentList onSelect={onSelect} selectedId="c" />)
    press('j')
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('/ focuses the search box, and typing j there does not move the selection', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    const onSelect = vi.fn()
    render(<IncidentList onSelect={onSelect} />)
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
    render(<IncidentList onSelect={onSelect} />)
    await screen.findByText('COMP_A')
    press('j', { ctrlKey: true }); press('j', { metaKey: true }); press('j', { altKey: true })
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('the listener is removed on unmount', async () => {
    api.fetchWorkItems.mockResolvedValue(three())
    const onSelect = vi.fn()
    const { unmount } = render(<IncidentList onSelect={onSelect} />)
    await screen.findByText('COMP_A')
    unmount()
    press('j')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
