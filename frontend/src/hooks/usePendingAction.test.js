import { renderHook, act } from '@testing-library/react'
import { usePendingAction } from './usePendingAction'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

test('runs the action once, only when the delay is over', () => {
  const run = vi.fn()
  const { result } = renderHook(() => usePendingAction(5000))
  act(() => result.current.start('a', run))
  expect(result.current.pending).toEqual({ a: true })
  act(() => { vi.advanceTimersByTime(4999) })
  expect(run).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(2) })
  expect(run).toHaveBeenCalledTimes(1)
  expect(result.current.pending).toEqual({})
})

test('cancel means the action never runs', () => {
  const run = vi.fn()
  const { result } = renderHook(() => usePendingAction(5000))
  act(() => result.current.start('a', run))
  act(() => result.current.cancel('a'))
  expect(result.current.pending).toEqual({})
  act(() => { vi.advanceTimersByTime(10_000) })
  expect(run).not.toHaveBeenCalled()
})

test('actions for different keys run independently', () => {
  const a = vi.fn(), b = vi.fn()
  const { result } = renderHook(() => usePendingAction(5000))
  act(() => result.current.start('a', a))
  act(() => { vi.advanceTimersByTime(2000) })
  act(() => result.current.start('b', b))
  act(() => result.current.cancel('a'))
  act(() => { vi.advanceTimersByTime(6000) })
  expect(a).not.toHaveBeenCalled()
  expect(b).toHaveBeenCalledTimes(1)
})

test('starting the same key again replaces the pending action instead of doubling it', () => {
  const first = vi.fn(), second = vi.fn()
  const { result } = renderHook(() => usePendingAction(5000))
  act(() => result.current.start('a', first))
  act(() => result.current.start('a', second))
  act(() => { vi.advanceTimersByTime(6000) })
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
})

test('unmounting (leaving the page or logging out) cancels what is pending', () => {
  const run = vi.fn()
  const { result, unmount } = renderHook(() => usePendingAction(5000))
  act(() => result.current.start('a', run))
  unmount()
  act(() => { vi.advanceTimersByTime(10_000) })
  expect(run).not.toHaveBeenCalled()
})
