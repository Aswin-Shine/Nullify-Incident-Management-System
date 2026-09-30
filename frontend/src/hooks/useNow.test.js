import { renderHook, act } from '@testing-library/react'
import { useNow } from './useNow'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

test('three subscribers share one interval and the last unmount clears it (F-19)', () => {
  const before = vi.getTimerCount()
  const hooks = [renderHook(() => useNow()), renderHook(() => useNow()), renderHook(() => useNow())]
  expect(vi.getTimerCount()).toBe(before + 1)
  hooks.forEach(h => h.unmount())
  expect(vi.getTimerCount()).toBe(before)
})

test('the value advances every second', () => {
  const { result } = renderHook(() => useNow())
  const t0 = result.current
  act(() => { vi.advanceTimersByTime(1000) })
  expect(result.current).toBeGreaterThan(t0)
})
