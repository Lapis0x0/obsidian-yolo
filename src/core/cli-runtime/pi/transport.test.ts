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
