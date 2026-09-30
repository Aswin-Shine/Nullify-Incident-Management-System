import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IncidentList } from './IncidentList'
import * as api from '../api/client'
import { deferred, workItem } from '../test/utils'

vi.mock('../api/client', async (orig) => ({ ...(await orig()), fetchWorkItems: vi.fn() }))

beforeEach(() => { vi.resetAllMocks() })

test('a row shows the component name (F-03)', async () => {
  api.fetchWorkItems.mockResolvedValue([workItem()])
  render(<IncidentList onSelect={() => {}} />)
  expect(await screen.findByText('RDBMS_PRIMARY')).toBeTruthy()
})

test('filter pills and incident rows are buttons (F-08)', async () => {
  api.fetchWorkItems.mockResolvedValue([workItem()])
  render(<IncidentList onSelect={() => {}} />)
  expect(await screen.findByRole('button', { name: /RDBMS_PRIMARY/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'OPEN' })).toBeTruthy()
})

test('clicking a row selects it', async () => {
  api.fetchWorkItems.mockResolvedValue([workItem()])
  const onSelect = vi.fn()
  render(<IncidentList onSelect={onSelect} />)
  await userEvent.click(await screen.findByRole('button', { name: /RDBMS_PRIMARY/ }))
  expect(onSelect).toHaveBeenCalledWith('wi-1')
})

test('clicking the OPEN pill fetches OPEN incidents', async () => {
  api.fetchWorkItems.mockResolvedValue([])
  render(<IncidentList onSelect={() => {}} />)
  await userEvent.click(await screen.findByRole('button', { name: 'OPEN' }))
  expect(api.fetchWorkItems).toHaveBeenLastCalledWith('OPEN')
})

test('a late response for an old filter never overwrites the newer one (F-12)', async () => {
  const first = deferred()
  const second = deferred()
  api.fetchWorkItems.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  render(<IncidentList onSelect={() => {}} />)
  await userEvent.click(screen.getByText('OPEN'))
  await act(async () => { second.resolve([workItem({ id: 'b', component: 'COMP_NEW' })]) })
  await act(async () => { first.resolve([workItem({ id: 'a', component: 'COMP_OLD' })]) })
  expect(screen.queryByText('COMP_OLD')).toBeNull()
  expect(screen.getByText('COMP_NEW')).toBeTruthy()
})
