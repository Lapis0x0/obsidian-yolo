import {
  CONNECT_TIMEOUT_MS,
  armWebSocketConnectTimeout,
  combineTranscript,
  createWhisperLiveKitNativeTranscriptState,
  readTranscript,
  readWhisperLiveKitNativeTranscript,
} from './common'

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

describe('readWhisperLiveKitNativeTranscript', () => {
  it('can include speaker labels when requested', () => {
    const result = readWhisperLiveKitNativeTranscript(
      {
        lines: [
          { speaker: 0, text: 'hello' },
          { speaker: 0, text: 'again' },
          { speaker: 1, text: 'hi' },
          { speaker: -2, text: 'noise' },
        ],
      },
      { includeSpeakerLabels: true },
    )

    expect(result.text).toBe(
      'Speaker 1: hello\nagain\nSpeaker 2: hi\nSpeaker -2: noise',
    )
  })

  it('keeps WhisperLiveKit negative speaker ids instead of dropping them', () => {
    const result = readWhisperLiveKitNativeTranscript(
      {
        lines: [
          { speaker: -2, text: 'first speaker' },
          { speaker: 1, text: 'second speaker' },
        ],
      },
      { includeSpeakerLabels: true },
    )

    expect(result.text).toBe(
      'Speaker -2: first speaker\nSpeaker 2: second speaker',
    )
  })

  it('reconstructs WhisperLiveKit diff mode without dropping pruned text', () => {
    const state = createWhisperLiveKitNativeTranscriptState()
    const snapshot = readWhisperLiveKitNativeTranscript(
      {
        type: 'snapshot',
        lines: [{ speaker: 0, text: 'first' }],
        buffer_transcription: '',
      },
      { includeSpeakerLabels: true, state },
    )
    const diff = readWhisperLiveKitNativeTranscript(
      {
        type: 'diff',
        lines_pruned: 1,
        n_lines: 1,
        new_lines: [{ speaker: 1, text: 'second' }],
        buffer_transcription: 'draft',
      },
      { includeSpeakerLabels: true, state },
    )

    expect(snapshot.text).toBe('Speaker 1: first')
    expect(snapshot.committedChanged).toBe(true)
    expect(diff.text).toBe('Speaker 1: first\nSpeaker 2: second')
    expect(diff.buffer).toBe('draft')
    expect(diff.committedChanged).toBe(true)
  })

  it('updates a growing WhisperLiveKit diff line without duplicating text', () => {
    const state = createWhisperLiveKitNativeTranscriptState()
    const first = readWhisperLiveKitNativeTranscript(
      {
        type: 'diff',
        n_lines: 1,
        new_lines: [{ text: 'hello' }],
      },
      { state },
    )
    const second = readWhisperLiveKitNativeTranscript(
      {
        type: 'diff',
        n_lines: 1,
        new_lines: [{ text: 'hello world' }],
      },
      { state },
    )

    expect(first.text).toBe('hello')
    expect(first.committedChanged).toBe(true)
    expect(second.text).toBe('hello world')
    expect(second.committedChanged).toBe(true)
  })

  it('treats same-start pruned WhisperLiveKit lines as replacements', () => {
    const state = createWhisperLiveKitNativeTranscriptState()
    const first = readWhisperLiveKitNativeTranscript(
      {
        type: 'diff',
        n_lines: 1,
        new_lines: [{ speaker: 1, text: '1975年夏季的', start: '0:00:00.18' }],
      },
      { includeSpeakerLabels: true, state },
    )
    const second = readWhisperLiveKitNativeTranscript(
      {
        type: 'diff',
        lines_pruned: 1,
        n_lines: 1,
        new_lines: [
          { speaker: 1, text: '1975年夏季的一天', start: '0:00:00.18' },
        ],
      },
      { includeSpeakerLabels: true, state },
    )

    expect(first.text).toBe('Speaker 2: 1975年夏季的')
    expect(first.committedChanged).toBe(true)
    expect(second.text).toBe('Speaker 2: 1975年夏季的一天')
    expect(second.committedChanged).toBe(true)
  })

  it('preserves stable WhisperLiveKit lines while refreshing the growing tail', () => {
    const state = createWhisperLiveKitNativeTranscriptState()
    readWhisperLiveKitNativeTranscript(
      {
        type: 'diff',
        n_lines: 1,
        new_lines: [{ text: 'first line' }],
      },
      { state },
    )
    readWhisperLiveKitNativeTranscript(
      {
        type: 'diff',
        n_lines: 2,
        new_lines: [{ text: 'second' }],
      },
      { state },
    )

    const result = readWhisperLiveKitNativeTranscript(
      {
        type: 'diff',
        n_lines: 2,
        new_lines: [{ text: 'second line' }],
      },
      { state },
    )

    expect(result.text).toBe('first line second line')
    expect(result.committedChanged).toBe(true)
  })

  it('treats WhisperLiveKit buffer-only diffs as partial updates', () => {
    const state = createWhisperLiveKitNativeTranscriptState()
    readWhisperLiveKitNativeTranscript(
      {
        type: 'snapshot',
        lines: [{ speaker: 0, text: 'first' }],
      },
      { state },
    )

    const result = readWhisperLiveKitNativeTranscript(
      {
        type: 'diff',
        n_lines: 1,
        buffer_transcription: 'partial',
      },
      { state },
    )

    expect(result.text).toBe('first')
    expect(result.buffer).toBe('partial')
    expect(result.committedChanged).toBe(false)
  })
})

describe('readTranscript', () => {
  it('can carry Deepgram speaker labels across final messages', () => {
    const speakerState = { lastSpeakerLabel: '' }
    const first = readTranscript(
      {
        channel: {
          alternatives: [
            {
              transcript: 'hello again',
              words: [
                { speaker: 0, word: 'hello' },
                { speaker: 0, word: 'again' },
              ],
            },
          ],
        },
      },
      { includeSpeakerLabels: true, speakerState },
    )
    const second = readTranscript(
      {
        channel: {
          alternatives: [
            {
              transcript: 'still here',
              words: [
                { speaker: 0, word: 'still' },
                { speaker: 0, word: 'here' },
              ],
            },
          ],
        },
      },
      { includeSpeakerLabels: true, speakerState },
    )

    expect(first).toBe('Speaker 1: helloagain')
    expect(second).toBe('stillhere')
    expect(combineTranscript([first, second])).toBe(
      'Speaker 1: helloagain stillhere',
    )
  })

  it('adds a line break when Deepgram speaker changes across final messages', () => {
    const speakerState = { lastSpeakerLabel: '' }
    const first = readTranscript(
      {
        channel: {
          alternatives: [
            {
              transcript: 'hello again',
              words: [
                { speaker: 0, word: 'hello' },
                { speaker: 0, word: 'again' },
              ],
            },
          ],
        },
      },
      { includeSpeakerLabels: true, speakerState },
    )
    const second = readTranscript(
      {
        channel: {
          alternatives: [
            {
              transcript: 'hi there',
              words: [
                { speaker: 1, word: 'hi' },
                { speaker: 1, word: 'there' },
              ],
            },
          ],
        },
      },
      { includeSpeakerLabels: true, speakerState },
    )

    expect(first).toBe('Speaker 1: helloagain')
    expect(second).toBe('Speaker 2: hithere')
    expect(combineTranscript([first, second])).toBe(
      'Speaker 1: helloagain\nSpeaker 2: hithere',
    )
  })
})
