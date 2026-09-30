import { renderHook, act } from '@testing-library/react'
import { useWebSocket } from './useWebSocket'
import * as api from '../api/client'

vi.mock('../api/client', () => ({ getAccessToken: () => 'tok', refreshSession: vi.fn() }))

let sockets
class FakeWebSocket {
  constructor(url) { this.url = url; this.sent = []; sockets.push(this) }
  send(d) { this.sent.push(JSON.parse(d)) }
  close() { this.onclose?.({ code: 1000 }) }
}

beforeEach(() => {
  vi.useFakeTimers()
  sockets = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.mocked(api.refreshSession).mockResolvedValue({})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

test('the first frame authenticates and auth_ok is not forwarded', () => {
  const onMessage = vi.fn()
  renderHook(() => useWebSocket(onMessage))
  sockets[0].onopen()
  expect(sockets[0].sent[0]).toEqual({ type: 'auth', token: 'tok' })
  sockets[0].onmessage({ data: JSON.stringify({ event: 'auth_ok' }) })
  sockets[0].onmessage({ data: JSON.stringify({ event: 'work_item_updated', id: '1' }) })
  expect(onMessage).toHaveBeenCalledTimes(1)
  expect(onMessage).toHaveBeenCalledWith({ event: 'work_item_updated', id: '1' })
})

test('no reconnect after unmount (F-02)', async () => {
  const { unmount } = renderHook(() => useWebSocket(() => {}))
  unmount()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(sockets).toHaveLength(1)
})

test('a dropped connection reconnects after 3 seconds', async () => {
  renderHook(() => useWebSocket(() => {}))
  act(() => sockets[0].onclose({ code: 1006 }))
  await vi.advanceTimersByTimeAsync(3000)
  expect(sockets).toHaveLength(2)
})

test('a 1008 close refreshes the session and then reconnects', async () => {
  renderHook(() => useWebSocket(() => {}))
  act(() => sockets[0].onclose({ code: 1008 }))
  expect(api.refreshSession).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3000)
  expect(sockets).toHaveLength(2)
})
