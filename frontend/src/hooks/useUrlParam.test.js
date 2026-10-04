import { renderHook, act } from '@testing-library/react'
import { useUrlParam } from './useUrlParam'

afterEach(() => { window.history.replaceState(null, '', '/') })

test('reads the initial value from the query string', () => {
  window.history.replaceState(null, '', '/?incident=abc')
  const { result } = renderHook(() => useUrlParam('incident'))
  expect(result.current[0]).toBe('abc')
})

test('is null when the param is absent', () => {
  const { result } = renderHook(() => useUrlParam('incident'))
  expect(result.current[0]).toBeNull()
})

test('setting a value pushes a history entry and updates the URL', () => {
  const push = vi.spyOn(window.history, 'pushState')
  const { result } = renderHook(() => useUrlParam('incident'))
  act(() => result.current[1]('xyz'))
  expect(result.current[0]).toBe('xyz')
  expect(window.location.search).toBe('?incident=xyz')
  expect(push).toHaveBeenCalledTimes(1)
  push.mockRestore()
})

test('setting with { replace: true } rewrites the current entry instead of adding one', () => {
  const push = vi.spyOn(window.history, 'pushState')
  const replace = vi.spyOn(window.history, 'replaceState')
  const { result } = renderHook(() => useUrlParam('incident'))
  act(() => result.current[1]('xyz', { replace: true }))
  expect(result.current[0]).toBe('xyz')
  expect(window.location.search).toBe('?incident=xyz')
  expect(replace).toHaveBeenCalledTimes(1)
  expect(push).not.toHaveBeenCalled()
  push.mockRestore(); replace.mockRestore()
})

test('setting null removes the param', () => {
  window.history.replaceState(null, '', '/?incident=abc&other=1')
  const { result } = renderHook(() => useUrlParam('incident'))
  act(() => result.current[1](null))
  expect(result.current[0]).toBeNull()
  expect(window.location.search).toBe('?other=1')
})

test('Back and Forward (popstate) update the value', () => {
  window.history.replaceState(null, '', '/?incident=one')
  const { result } = renderHook(() => useUrlParam('incident'))
  act(() => result.current[1]('two'))
  act(() => {
    window.history.replaceState(null, '', '/?incident=one')  // what the browser does on Back
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  expect(result.current[0]).toBe('one')
})
