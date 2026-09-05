import type { PiProcessExitListener, PiProcessLike } from './process'
import { PiRpcResponseError, PiRpcTransport } from './transport'

class FakeProcess implements PiProcessLike {
  writes: string[] = []
  private dataListener: ((chunk: string) => void) | null = null
  private exitListener: PiProcessExitListener | null = null

  write(text: string): void {
    this.writes.push(text)
  }
  onData(listener: (chunk: string) => void): () => void {
    this.dataListener = listener
    return () => {
      this.dataListener = null
    }
  }
  onExit(listener: PiProcessExitListener): () => void {
    this.exitListener = listener
    return () => {
      this.exitListener = null
    }
  }
  getStderrSnapshot(): string {
    return ''
  }
  async shutdown(): Promise<void> {}

  emitChunk(chunk: string): void {
    this.dataListener?.(chunk)
  }
  emitExit(
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.exitListener?.(code, signal)
  }
}

describe('PiRpcTransport', () => {
  it('splits frames only on \\n and strips a trailing \\r', () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)
    const events: unknown[] = []
    transport.onEvent((event) => events.push(event))

    // Two frames delivered in one chunk, CRLF-terminated, plus a split
    // across chunk boundaries.
    process.emitChunk(
      `${JSON.stringify({ type: 'agent_start' })}\r\n${JSON.stringify({ type: 'compaction_start' })}\r\n`,
    )
    process.emitChunk('{"type":"compac')
    process.emitChunk('tion_end"}\n')

    expect(events).toEqual([
      { type: 'agent_start' },
      { type: 'compaction_start' },
      { type: 'compaction_end' },
    ])
  })

  it('does not split a frame on a literal U+2028/U+2029 inside a JSON string', () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)
    const events: unknown[] = []
    transport.onEvent((event) => events.push(event))

    const payload = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'line one line two line three',
      },
    })
    // A naive generic-line-terminator splitter would cut this into three
    // pieces; byte-buffer + indexOf('\n') framing must not.
    process.emitChunk(`${payload}\n`)

    expect(events).toHaveLength(1)
    expect(
      (events[0] as { assistantMessageEvent: { delta: string } })
        .assistantMessageEvent.delta,
    ).toBe('line one line two line three')
  })

  it("resolves a request from the response envelope's data field", async () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)

    const resultPromise = transport.request<{ ok: boolean }>('get_state', {})
    const sent = JSON.parse(process.writes[0]) as { id: string; type: string }
    expect(sent.type).toBe('get_state')

    process.emitChunk(
      `${JSON.stringify({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { ok: true },
        id: sent.id,
      })}\n`,
    )

    await expect(resultPromise).resolves.toEqual({ ok: true })
  })

  it('ignores a `result` field on the response envelope — only `data` is read', async () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)

    const resultPromise = transport.request('get_state', {})
    const sent = JSON.parse(process.writes[0]) as { id: string }

    process.emitChunk(
      `${JSON.stringify({
        type: 'response',
        command: 'get_state',
        success: true,
        result: { ok: true },
        id: sent.id,
      })}\n`,
    )

    await expect(resultPromise).resolves.toBeUndefined()
  })

  it("rejects with the response envelope's error field on success: false", async () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)

    const resultPromise = transport.request('prompt', {})
    const sent = JSON.parse(process.writes[0]) as { id: string }

    process.emitChunk(
      `${JSON.stringify({
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'model not selected',
        id: sent.id,
      })}\n`,
    )

    await expect(resultPromise).rejects.toThrow(PiRpcResponseError)
    await expect(resultPromise).rejects.toThrow('model not selected')
  })

  it('broadcasts non-response lines as events and ignores unparsable lines', () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)
    const events: unknown[] = []
    transport.onEvent((event) => events.push(event))

    process.emitChunk('not json\n')
    process.emitChunk(`${JSON.stringify({ type: 'agent_settled' })}\n`)

    expect(events).toEqual([{ type: 'agent_settled' }])
  })

  it('send() writes without an id and never resolves a pending request', () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)

    transport.send({ type: 'abort' })

    expect(process.writes).toHaveLength(1)
    const sent = JSON.parse(process.writes[0]) as Record<string, unknown>
    expect(sent).toEqual({ type: 'abort' })
  })

  it('does not time out when timeoutMs is 0', async () => {
    jest.useFakeTimers()
    try {
      const process = new FakeProcess()
      const transport = new PiRpcTransport(process)

      const resultPromise = transport.request('compact', {}, 0)
      jest.advanceTimersByTime(60_000)

      const sent = JSON.parse(process.writes[0]) as { id: string }
      process.emitChunk(
        `${JSON.stringify({
          type: 'response',
          command: 'compact',
          success: true,
          data: { summary: 'ok' },
          id: sent.id,
        })}\n`,
      )

      await expect(resultPromise).resolves.toEqual({ summary: 'ok' })
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects pending requests when the process exits', async () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)

    const resultPromise = transport.request('get_state', {})
    process.emitExit(1, null)

    await expect(resultPromise).rejects.toThrow()
  })
})

/**
 * omp's protocol v2. Everything here is inert for pi, which announces no
 * `ready` frame and never negotiates.
 */
describe('PiRpcTransport — negotiated chunk transport', () => {
  const READY = {
    type: 'ready',
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1_048_576,
    maxReassembledFrameBytes: 67_108_864,
  }

  const emit = (process: FakeProcess, record: unknown): void =>
    process.emitChunk(`${JSON.stringify(record)}\n`)

  /** Splits one record into `count` `rpc_chunk` frames, on byte boundaries. */
  const chunksFor = (
    record: unknown,
    count: number,
    chunkId = 'rpc-1',
  ): unknown[] => {
    const bytes = new TextEncoder().encode(JSON.stringify(record))
    const size = Math.ceil(bytes.length / count)
    return Array.from({ length: count }, (_, index) => {
      const slice = bytes.slice(index * size, (index + 1) * size)
      let binary = ''
      for (const byte of slice) binary += String.fromCharCode(byte)
      return {
        type: 'rpc_chunk',
        chunkId,
        index,
        count,
        byteLength: bytes.length,
        data: btoa(binary),
      }
    })
  }

  it('holds commands until the handshake settles, then flushes them in order', () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process, {
      negotiateProtocolVersion: 2,
    })

    const ignore = () => undefined
    void transport.request('get_available_models', {}).catch(ignore)
    void transport.request('get_state', {}).catch(ignore)
    expect(process.writes).toEqual([])

    emit(process, READY)
    const handshake = JSON.parse(process.writes[0]) as Record<string, unknown>
    expect(handshake).toMatchObject({
      type: 'negotiate_protocol',
      protocolVersion: 2,
    })
    // Still held: the agent has not accepted the upgrade yet.
    expect(process.writes).toHaveLength(1)

    emit(process, {
      type: 'response',
      command: 'negotiate_protocol',
      success: true,
      id: handshake.id,
      data: {},
    })
    expect(
      process.writes
        .slice(1)
        .map((line) => (JSON.parse(line) as { type: string }).type),
    ).toEqual(['get_available_models', 'get_state'])
    transport.dispose()
  })

  it('releases commands when the agent does not offer the version', () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process, {
      negotiateProtocolVersion: 2,
    })

    void transport.request('get_state', {}).catch(() => undefined)
    emit(process, { ...READY, supportedProtocolVersions: [1] })

    expect(
      process.writes.map((line) => (JSON.parse(line) as { type: string }).type),
    ).toEqual(['get_state'])
    transport.dispose()
  })

  it('reassembles a response split across chunks', async () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process, {
      negotiateProtocolVersion: 2,
    })

    const resultPromise = transport.request('get_available_models', {})
    emit(process, READY)
    const handshakeId = (JSON.parse(process.writes[0]) as { id: string }).id
    emit(process, {
      type: 'response',
      command: 'negotiate_protocol',
      success: true,
      id: handshakeId,
    })
    const requestId = (JSON.parse(process.writes[1]) as { id: string }).id

    // A multi-byte character straddling the split is the case a string-wise
    // reassembly would corrupt.
    const models = [{ id: 'xiaomi/mimo-v2.5', name: '小米 MiMo — 模型' }]
    for (const chunk of chunksFor(
      {
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: models,
        id: requestId,
      },
      7,
    )) {
      emit(process, chunk)
    }

    await expect(resultPromise).resolves.toEqual(models)
  })

  it('drops an interrupted sequence instead of parsing a partial object', () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process, {
      negotiateProtocolVersion: 2,
    })
    const events: unknown[] = []
    // The `ready` frame itself is broadcast like any other frame; only the
    // chunk-derived ones matter here.
    transport.onEvent((event) => {
      if ((event as { type?: string }).type !== 'ready') events.push(event)
    })
    emit(process, READY)

    const chunks = chunksFor({ type: 'agent_start' }, 3)
    emit(process, chunks[0])
    // A second sequence barges in mid-stream: both are unusable.
    emit(process, chunksFor({ type: 'agent_end' }, 3, 'rpc-2')[1])
    emit(process, chunks[1])
    emit(process, chunks[2])

    expect(events).toEqual([])
  })
})

describe('PiRpcTransport — responses without an id', () => {
  it('fails the matching request instead of leaving it to time out', async () => {
    // omp reports an unknown command this way: the command name is there,
    // the id is not.
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)

    const resultPromise = transport.request('get_entries', {})
    process.emitChunk(
      `${JSON.stringify({
        type: 'response',
        command: 'get_entries',
        success: false,
        error: 'Unknown command: get_entries',
      })}\n`,
    )

    await expect(resultPromise).rejects.toThrow('Unknown command: get_entries')
  })

  it('leaves both pending when two requests share the command name', async () => {
    const process = new FakeProcess()
    const transport = new PiRpcTransport(process)

    const first = transport.request('get_state', {})
    const second = transport.request('get_state', {})
    let settled = false
    void Promise.race([first, second]).then(
      () => (settled = true),
      () => (settled = true),
    )
    process.emitChunk(
      `${JSON.stringify({
        type: 'response',
        command: 'get_state',
        success: true,
        data: {},
      })}\n`,
    )
    await Promise.resolve()

    // Resolving a guess would hand one caller the other's answer.
    expect(settled).toBe(false)
    transport.dispose()
    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
  })
})
