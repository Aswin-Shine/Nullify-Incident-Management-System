import { renderHook, act, waitFor } from '@testing-library/react'
import { useQuery } from './useQuery'

test('setData wins over a fetch that was already in flight', async () => {
  let resolveOld
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ status: 'OPEN' })                               // the first load
    .mockReturnValueOnce(new Promise(r => { resolveOld = r }))              // a refetch (live event) still running
  const { result, rerender } = renderHook(({ tick }) => useQuery('wi-1', fetcher, tick), { initialProps: { tick: 0 } })
  await waitFor(() => expect(result.current.data).toEqual({ status: 'OPEN' }))

  rerender({ tick: 1 })                                                       // the refetch starts
  act(() => result.current.setData({ status: 'INVESTIGATING' }))            // the mutation's own answer
  await act(async () => { resolveOld({ status: 'OPEN' }) })                  // the older GET lands last

  expect(result.current.data).toEqual({ status: 'INVESTIGATING' })
})

test('a fetch that starts after setData still updates the data', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ n: 3 })
  const { result, rerender } = renderHook(({ tick }) => useQuery('k', fetcher, tick), { initialProps: { tick: 0 } })
  await waitFor(() => expect(result.current.data).toEqual({ n: 1 }))
  act(() => result.current.setData({ n: 2 }))
  rerender({ tick: 1 })
  await waitFor(() => expect(result.current.data).toEqual({ n: 3 }))
})
