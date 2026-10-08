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

// After a deploy every client used to reconnect (and refetch) at the same moment, 3 s after the drop.
describe('reconnect backoff (architecture review, Low)', () => {
  const drop = (i) => act(() => sockets[i].onclose({ code: 1006 }))
  const authOk = (i) => act(() => sockets[i].onmessage({ data: JSON.stringify({ event: 'auth_ok' }) }))
  afterEach(() => { vi.restoreAllMocks() })

  test('the wait doubles from 1 s and stops growing at 30 s', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)  // no jitter: the full wait
    renderHook(() => useWebSocket(() => {}))
    const waits = []
    for (let i = 0; i < 7; i++) {
      drop(i)
      let waited = 0
      while (sockets.length === i + 1) { await vi.advanceTimersByTimeAsync(250); waited += 250 }
      waits.push(waited)
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  test('the wait starts over once a connection is authenticated again', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    renderHook(() => useWebSocket(() => {}))
    drop(0); await vi.advanceTimersByTimeAsync(1000)
    drop(1); await vi.advanceTimersByTimeAsync(2000)
    authOk(2)
    drop(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(4)
  })

  test('the wait is jittered, so clients spread out', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)  // the shortest draw: half the wait
    renderHook(() => useWebSocket(() => {}))
    drop(0)
    await vi.advanceTimersByTimeAsync(499)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(2)
  })
})

test('a 1008 close refreshes the session and then reconnects', async () => {
  renderHook(() => useWebSocket(() => {}))
  act(() => sockets[0].onclose({ code: 1008 }))
  expect(api.refreshSession).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3000)
  expect(sockets).toHaveLength(2)
})

test('no reconnect when the refresh settles after unmount (a revoked session signs the user out meanwhile)', async () => {
  let reject
  vi.mocked(api.refreshSession).mockReturnValue(new Promise((_, r) => { reject = r }))
  const { unmount } = renderHook(() => useWebSocket(() => {}))
  act(() => sockets[0].onclose({ code: 1008 }))
  unmount()
  reject(new Error('401'))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(sockets).toHaveLength(1)
})

test('auth_ok after a reconnect calls onReconnect, the first one does not (F-35)', async () => {
  const onReconnect = vi.fn()
  renderHook(() => useWebSocket(() => {}, onReconnect))
  sockets[0].onmessage({ data: JSON.stringify({ event: 'auth_ok' }) })
  expect(onReconnect).not.toHaveBeenCalled()
  act(() => sockets[0].onclose({ code: 1006 }))
  await vi.advanceTimersByTimeAsync(3000)
  sockets[1].onmessage({ data: JSON.stringify({ event: 'auth_ok' }) })
  expect(onReconnect).toHaveBeenCalledTimes(1)
})

const authOk = (ws) => ws.onmessage({ data: JSON.stringify({ event: 'auth_ok' }) })

test('onStatus goes connecting, live on auth_ok, reconnecting on close, live on the next auth_ok', async () => {
  const onStatus = vi.fn()
  renderHook(() => useWebSocket(() => {}, undefined, onStatus))
  expect(onStatus.mock.calls.map(c => c[0])).toEqual(['connecting'])
  sockets[0].onopen()
  expect(onStatus).toHaveBeenCalledTimes(1)  // an open socket is not live until the server accepts our token
  authOk(sockets[0])
  expect(onStatus).toHaveBeenLastCalledWith('live')
  act(() => sockets[0].onclose({ code: 1006 }))
  expect(onStatus).toHaveBeenLastCalledWith('reconnecting')
  await vi.advanceTimersByTimeAsync(3000)
  expect(onStatus).toHaveBeenLastCalledWith('reconnecting')  // the retry itself is still not live
  authOk(sockets[1])
  expect(onStatus.mock.calls.map(c => c[0])).toEqual(['connecting', 'live', 'reconnecting', 'live'])
})

test('a rejected token (1008) also reads as reconnecting', () => {
  const onStatus = vi.fn()
  renderHook(() => useWebSocket(() => {}, undefined, onStatus))
  act(() => sockets[0].onclose({ code: 1008 }))
  expect(onStatus).toHaveBeenLastCalledWith('reconnecting')
})

test('unmounting does not report a status', () => {
  const onStatus = vi.fn()
  const { unmount } = renderHook(() => useWebSocket(() => {}, undefined, onStatus))
  onStatus.mockClear()
  unmount()
  expect(onStatus).not.toHaveBeenCalled()
})

test('onStatus is optional', () => {
  renderHook(() => useWebSocket(() => {}))
  expect(() => authOk(sockets[0])).not.toThrow()
})
