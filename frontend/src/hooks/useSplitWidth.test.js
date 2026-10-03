import { renderHook, act } from '@testing-library/react'
import { useSplitWidth } from './useSplitWidth'

const KEY = 'nullify.split'
const key = (k) => ({ key: k, preventDefault: () => {} })

beforeEach(() => { vi.stubGlobal('innerWidth', 1440) })
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// The detail pane keeps at least 560px: max = innerWidth - sidebar (220 from 1280px, 56 from 900px, else 0) - 560.
test('defaults to 560 and exposes the bounds', () => {
  const { result } = renderHook(() => useSplitWidth())
  expect(result.current.width).toBe(560)
  expect(result.current.min).toBe(320)
  expect(result.current.max).toBe(660)
})

test('the maximum accounts for the sidebar width at each breakpoint', () => {
  vi.stubGlobal('innerWidth', 1100)  // icon sidebar, 56px
  const mid = renderHook(() => useSplitWidth()).result.current
  expect(mid.max).toBe(484)
  expect(mid.width).toBe(484)  // the 560 default is pulled in
  vi.stubGlobal('innerWidth', 1600)  // full sidebar, 220px
  expect(renderHook(() => useSplitWidth()).result.current.max).toBe(820)
})

test('restores a stored width', () => {
  localStorage.setItem(KEY, '600')
  const { result } = renderHook(() => useSplitWidth())
  expect(result.current.width).toBe(600)
})

test('clamps a stored width to 320 and to the maximum', () => {
  localStorage.setItem(KEY, '100')
  expect(renderHook(() => useSplitWidth()).result.current.width).toBe(320)
  localStorage.setItem(KEY, '5000')
  expect(renderHook(() => useSplitWidth()).result.current.width).toBe(660)
})

test('on a narrow window the maximum never drops below the minimum', () => {
  vi.stubGlobal('innerWidth', 700)
  const { result } = renderHook(() => useSplitWidth())
  expect(result.current.max).toBe(320)
  expect(result.current.width).toBe(320)
})

test('ArrowRight and ArrowLeft move by 16', () => {
  const { result } = renderHook(() => useSplitWidth())
  act(() => result.current.onKeyDown(key('ArrowRight')))
  expect(result.current.width).toBe(576)
  act(() => result.current.onKeyDown(key('ArrowLeft')))
  act(() => result.current.onKeyDown(key('ArrowLeft')))
  expect(result.current.width).toBe(544)
})

test('Home and End jump to the minimum and maximum', () => {
  const { result } = renderHook(() => useSplitWidth())
  act(() => result.current.onKeyDown(key('Home')))
  expect(result.current.width).toBe(320)
  act(() => result.current.onKeyDown(key('End')))
  expect(result.current.width).toBe(660)
})

test('arrow keys stop at the bounds', () => {
  const { result } = renderHook(() => useSplitWidth())
  act(() => result.current.onKeyDown(key('Home')))
  act(() => result.current.onKeyDown(key('ArrowLeft')))
  expect(result.current.width).toBe(320)
})

test('a change is persisted, and double-click resets to 560', () => {
  const { result } = renderHook(() => useSplitWidth())
  act(() => result.current.onKeyDown(key('ArrowLeft')))
  expect(localStorage.getItem(KEY)).toBe('544')
  act(() => result.current.onDoubleClick())
  expect(result.current.width).toBe(560)
  expect(localStorage.getItem(KEY)).toBe('560')
})

test('dragging moves the width by the pointer distance', () => {
  const { result } = renderHook(() => useSplitWidth())
  const target = { setPointerCapture: vi.fn() }
  act(() => result.current.onPointerDown({ clientX: 500, pointerId: 1, currentTarget: target }))
  act(() => result.current.onPointerMove({ clientX: 540 }))
  expect(result.current.width).toBe(600)
  act(() => result.current.onPointerUp())
  act(() => result.current.onPointerMove({ clientX: 900 }))
  expect(result.current.width).toBe(600)
})

test('unusable storage does not crash it', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  const { result } = renderHook(() => useSplitWidth())
  expect(result.current.width).toBe(560)
  act(() => result.current.onKeyDown(key('ArrowLeft')))
  expect(result.current.width).toBe(544)
})
