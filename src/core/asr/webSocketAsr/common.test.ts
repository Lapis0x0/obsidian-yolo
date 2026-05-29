import { CONNECT_TIMEOUT_MS, armWebSocketConnectTimeout } from './common'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1

  readyState = FakeWebSocket.CONNECTING

  private readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    const event = { type } as Event
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

describe('armWebSocketConnectTimeout', () => {
  const globalForTest = globalThis as any
  let originalWindow: unknown
  let originalWebSocket: unknown

  beforeEach(() => {
    jest.useFakeTimers()
    originalWindow = globalForTest.window
    originalWebSocket = globalForTest.WebSocket
    globalForTest.window = { setTimeout, clearTimeout }
    globalForTest.WebSocket = FakeWebSocket
  })

  afterEach(() => {
    globalForTest.window = originalWindow
    globalForTest.WebSocket = originalWebSocket
    jest.useRealTimers()
  })

  it('times out sockets that remain connecting', () => {
    const socket = new FakeWebSocket()
    const onTimeout = jest.fn()
    const cleanup = armWebSocketConnectTimeout({
      socket: socket as unknown as WebSocket,
      isSettled: () => false,
      onTimeout,
    })

    jest.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout.mock.calls[0]?.[0].message).toBe(
      'ASR WebSocket timed out while connecting.',
    )
    cleanup()
  })

  it('clears the timeout after the socket opens', () => {
    const socket = new FakeWebSocket()
    const onTimeout = jest.fn()
    const cleanup = armWebSocketConnectTimeout({
      socket: socket as unknown as WebSocket,
      isSettled: () => false,
      onTimeout,
    })

    socket.readyState = FakeWebSocket.OPEN
    socket.emit('open')
    jest.advanceTimersByTime(CONNECT_TIMEOUT_MS)

    expect(onTimeout).not.toHaveBeenCalled()
    cleanup()
  })
})
