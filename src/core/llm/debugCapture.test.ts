import {
  bindLLMDebugTraceToSignal,
  captureLLMDebugOperation,
  createLLMDebugFetch,
  createLLMDebugTrace,
  flushLLMDebugTraceReads,
  getLLMDebugTrace,
  logAuxiliaryLLMUsage,
  omitBase64DebugData,
  runWithLLMDebugTrace,
  setLLMDebugCaptureEnabled,
} from './debugCapture'

describe('debugCapture', () => {
  afterEach(() => {
    setLLMDebugCaptureEnabled(false)
    jest.restoreAllMocks()
  })

  it('assigns fetches without signals when exactly one trace is active', async () => {
    setLLMDebugCaptureEnabled(true)
    const fetch = createLLMDebugFetch(
      jest.fn(async () => new Response('{"ok":true}')),
      'browser',
    )
    const mainTrace = createLLMDebugTrace({ requestKind: 'streaming' })

    await runWithLLMDebugTrace(mainTrace.id, async () => {
      await fetch('https://example.test/main', {
        method: 'POST',
        body: '{"messages":[]}',
      })
    })
    await flushLLMDebugTraceReads([mainTrace.id])

    expect(getLLMDebugTrace(mainTrace.id)?.exchanges).toHaveLength(1)
    expect(getLLMDebugTrace(mainTrace.id)?.exchanges[0].request.url).toBe(
      'https://example.test/main',
    )
    expect(getLLMDebugTrace(mainTrace.id)?.exchanges[0].response?.body).toBe(
      '{"ok":true}',
    )
  })

  it('does not assign signal-less fetches when active traces are ambiguous', async () => {
    setLLMDebugCaptureEnabled(true)
    const fetch = createLLMDebugFetch(
      jest.fn(async () => new Response('{"ok":true}')),
      'browser',
    )
    const mainTrace = createLLMDebugTrace({ requestKind: 'streaming' })
    const titleTrace = createLLMDebugTrace({
      requestKind: 'title-generation',
    })

    await runWithLLMDebugTrace(mainTrace.id, async () => {
      await runWithLLMDebugTrace(titleTrace.id, async () => {
        await fetch('https://example.test/title', {
          method: 'POST',
          body: '{"messages":[]}',
        })
      })
      await fetch('https://example.test/main', {
        method: 'POST',
        body: '{"messages":[]}',
      })
    })
    await flushLLMDebugTraceReads([mainTrace.id, titleTrace.id])

    expect(getLLMDebugTrace(titleTrace.id)?.exchanges).toHaveLength(0)
    expect(getLLMDebugTrace(mainTrace.id)?.exchanges).toHaveLength(1)
    expect(getLLMDebugTrace(mainTrace.id)?.exchanges[0].request.url).toBe(
      'https://example.test/main',
    )
  })

  it('uses a bound signal even when another trace is active', async () => {
    setLLMDebugCaptureEnabled(true)
    const fetch = createLLMDebugFetch(
      jest.fn(async () => new Response('{"ok":true}')),
      'browser',
    )
    const mainTrace = createLLMDebugTrace({ requestKind: 'streaming' })
    const titleTrace = createLLMDebugTrace({
      requestKind: 'title-generation',
    })
    const titleController = new AbortController()
    bindLLMDebugTraceToSignal(titleTrace.id, titleController.signal)

    await runWithLLMDebugTrace(mainTrace.id, async () => {
      await runWithLLMDebugTrace(titleTrace.id, async () => {
        await fetch('https://example.test/title', {
          method: 'POST',
          body: '{"messages":[]}',
          signal: titleController.signal,
        })
      })
    })
    await flushLLMDebugTraceReads([mainTrace.id, titleTrace.id])

    expect(getLLMDebugTrace(titleTrace.id)?.exchanges).toHaveLength(1)
    expect(getLLMDebugTrace(titleTrace.id)?.exchanges[0].request.url).toBe(
      'https://example.test/title',
    )
    expect(getLLMDebugTrace(mainTrace.id)?.exchanges).toHaveLength(0)
  })

  it('omits captured base64 payloads while preserving data URL prefixes', async () => {
    setLLMDebugCaptureEnabled(true)
    const base64 = 'A'.repeat(160)
    const fetch = createLLMDebugFetch(
      jest.fn(async () => new Response(JSON.stringify({ image: base64 }))),
      'browser',
    )
    const trace = createLLMDebugTrace({ requestKind: 'non-streaming' })

    await runWithLLMDebugTrace(trace.id, async () => {
      await fetch('https://example.test/images', {
        method: 'POST',
        body: JSON.stringify({
          image_url: `data:image/jpeg;base64,${base64}`,
          raw_data: base64,
        }),
      })
    })
    await flushLLMDebugTraceReads([trace.id])

    const exchange = getLLMDebugTrace(trace.id)?.exchanges[0]
    expect(exchange?.request.body).toContain(
      'data:image/jpeg;base64,[OMITTED base64 data: 160 chars]',
    )
    expect(exchange?.request.body).toContain(
      '"raw_data":"[OMITTED base64 data: 160 chars]"',
    )
    expect(exchange?.request.body).not.toContain(`base64,${base64}`)
    expect(exchange?.response?.body).toContain(
      '"image":"[OMITTED base64 data: 160 chars]"',
    )
  })

  it('uses OMITTED markers for long captured JSON strings', () => {
    const omitted = omitBase64DebugData('long text '.repeat(5_000))

    expect(omitted).toMatch(/\[OMITTED long JSON string: \d+ chars\]/)
    expect(omitted).not.toContain('Truncated long JSON string')
  })

  it('omits base64 data from captured operation responses before storage', async () => {
    setLLMDebugCaptureEnabled(true)
    const trace = createLLMDebugTrace({ requestKind: 'streaming' })
    const base64 = 'A'.repeat(1024)

    await runWithLLMDebugTrace(trace.id, async () => {
      await expect(
        captureLLMDebugOperation({
          traceId: trace.id,
          transportMode: 'mcp',
          url: 'mcp://yolo_local/fs_read',
          method: 'callTool',
          requestBody: { name: 'fs_read' },
          responseContentType: 'application/json',
          run: async () => ({
            status: 'success',
            content: [{ type: 'text', data: base64 }],
          }),
        }),
      ).resolves.toEqual({
        status: 'success',
        content: [{ type: 'text', data: base64 }],
      })
    })

    const responseBody = getLLMDebugTrace(trace.id)?.exchanges[0]?.response
      ?.body
    expect(responseBody).toContain('[OMITTED base64 data: 1024 chars]')
    expect(responseBody).not.toContain(base64)
  })

  it('adds debug capture context to serialization failures', async () => {
    setLLMDebugCaptureEnabled(true)
    const trace = createLLMDebugTrace({ requestKind: 'streaming' })

    await runWithLLMDebugTrace(trace.id, async () => {
      await expect(
        captureLLMDebugOperation({
          traceId: trace.id,
          transportMode: 'mcp',
          url: 'mcp://yolo_local/fs_read',
          method: 'callTool',
          requestBody: { name: 'fs_read' },
          responseContentType: 'application/json',
          run: async () => ({ ok: true }),
          getResponseBody: () => {
            throw new RangeError('Maximum call stack size exceeded')
          },
        }),
      ).rejects.toThrow(
        'LLM debug capture failed while serializing response body.',
      )
    })
  })

  it('redacts sensitive params in form-urlencoded request bodies', async () => {
    setLLMDebugCaptureEnabled(true)
    const fetch = createLLMDebugFetch(
      jest.fn(async () => new Response('{}')),
      'browser',
    )
    const trace = createLLMDebugTrace({ requestKind: 'non-streaming' })

    await runWithLLMDebugTrace(trace.id, async () => {
      await fetch('https://oauth.example.test/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'client-12345',
          client_secret: 'super-secret-value-xyz',
          refresh_token: 'r3fr3sh-t0k3n-abcdefgh',
          code: 'auth-code-9876543210',
        }),
      })
    })
    await flushLLMDebugTraceReads([trace.id])

    const body = getLLMDebugTrace(trace.id)?.exchanges[0]?.request.body ?? ''
    // Non-sensitive params remain readable.
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('client_id=client-12345')
    // Sensitive secrets are masked and original values do not survive.
    expect(body).not.toContain('super-secret-value-xyz')
    expect(body).not.toContain('r3fr3sh-t0k3n-abcdefgh')
    expect(body).not.toContain('auth-code-9876543210')
    expect(body).toMatch(/client_secret=[^&]*REDACTED/)
    expect(body).toMatch(/refresh_token=[^&]*REDACTED/)
    expect(body).toMatch(/(^|&)code=[^&]*REDACTED/)
  })

  it('logs auxiliary LLM usage without prompt or response content', () => {
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {})
    setLLMDebugCaptureEnabled(true)

    logAuxiliaryLLMUsage({
      purpose: 'voice-polish',
      providerId: 'provider-a',
      modelName: 'model-a',
      durationMs: 123,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      },
    })

    expect(debugSpy).toHaveBeenCalledTimes(1)
    const [, payload] = debugSpy.mock.calls[0]
    expect(payload).toEqual({
      purpose: 'voice-polish',
      provider: 'provider-a',
      model: 'model-a',
      durationMs: 123,
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
      cache_hit_rate: 0.8,
    })
    expect(payload).not.toHaveProperty('messages')
    expect(payload).not.toHaveProperty('prompt')
    expect(payload).not.toHaveProperty('content')
    expect(payload).not.toHaveProperty('response')
  })
})
