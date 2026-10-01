import { render, screen, act } from '@testing-library/react'
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
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith('OPEN', 100)
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
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(undefined, 100)

  api.fetchWorkItems.mockResolvedValueOnce(page([workItem(), workItem({ id: 'wi-2', component: 'CACHE_X' })]))
  await userEvent.click(more)

  expect(await screen.findByText('CACHE_X')).toBeTruthy()
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith(undefined, 200)
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
})
