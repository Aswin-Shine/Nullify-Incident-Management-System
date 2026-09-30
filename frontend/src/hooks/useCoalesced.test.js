import { renderHook } from '@testing-library/react'
import { useCoalesced } from './useCoalesced'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

test('50 calls inside the window run the callback once (F-27)', () => {
  const fn = vi.fn()
  const { result } = renderHook(() => useCoalesced(fn, 1000))
  for (let i = 0; i < 50; i++) result.current()
  vi.advanceTimersByTime(1000)
  expect(fn).toHaveBeenCalledTimes(1)
})

test('a call after the window runs it again', () => {
  const fn = vi.fn()
  const { result } = renderHook(() => useCoalesced(fn, 1000))
  result.current()
  vi.advanceTimersByTime(1000)
  result.current()
  vi.advanceTimersByTime(1000)
  expect(fn).toHaveBeenCalledTimes(2)
})

test('unmounting cancels anything pending', () => {
  const fn = vi.fn()
  const { result, unmount } = renderHook(() => useCoalesced(fn, 1000))
  result.current()
  unmount()
  vi.advanceTimersByTime(2000)
  expect(fn).not.toHaveBeenCalled()
})
