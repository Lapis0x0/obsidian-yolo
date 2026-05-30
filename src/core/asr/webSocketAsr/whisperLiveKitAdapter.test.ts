import { openWhisperLiveKitNativeStream } from './whisperLiveKitAdapter'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static readonly instances: FakeWebSocket[] = []

  readonly sent: unknown[] = []
  readonly url: string
  binaryType = ''
  readyState = FakeWebSocket.CONNECTING

  private readonly listeners = new Map<string, Set<EventListener>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code: 1000 })
  }

  emit(type: string, init: Record<string, unknown> = {}): void {
    const event = { type, ...init } as Event
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

describe('openWhisperLiveKitNativeStream', () => {
  const globalForTest = globalThis as any
  let originalWindow: unknown
  let originalWebSocket: unknown

  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    originalWindow = globalForTest.window
    originalWebSocket = globalForTest.WebSocket
    globalForTest.window = { setTimeout, clearTimeout }
    globalForTest.WebSocket = FakeWebSocket
  })

  afterEach(() => {
    globalForTest.window = originalWindow
    globalForTest.WebSocket = originalWebSocket
  })

  it('keeps WhisperLiveKit diff updates partial until finish returns final text', async () => {
    const onPartial = jest.fn()
    const onFinal = jest.fn()
    const sessionPromise = openWhisperLiveKitNativeStream({
      url: 'ws://localhost:8000/asr?mode=diff',
      callbacks: { onPartial, onFinal },
      includeSpeakerLabels: true,
    })
    const socket = FakeWebSocket.instances[0]
    await Promise.resolve()
    socket.readyState = FakeWebSocket.OPEN
    socket.emit('open')

    const session = await sessionPromise
    socket.emit('message', {
      data: JSON.stringify({
        type: 'diff',
        n_lines: 1,
        new_lines: [{ speaker: 1, text: 'hello' }],
      }),
    })
    socket.emit('message', {
      data: JSON.stringify({
        type: 'diff',
        n_lines: 1,
        new_lines: [{ speaker: 1, text: 'hello world' }],
      }),
    })

    expect(onPartial).toHaveBeenLastCalledWith('Speaker 2: hello world')
    expect(onFinal).not.toHaveBeenCalled()

    const finishPromise = session.finish()
    await Promise.resolve()
    socket.emit('message', {
      data: JSON.stringify({ type: 'ready_to_stop' }),
    })
    const result = await finishPromise

    expect(result.text).toBe('Speaker 2: hello world')
    expect(onFinal).not.toHaveBeenCalled()
  })
})
