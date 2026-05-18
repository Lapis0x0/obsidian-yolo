import {
  bindLLMDebugTraceToSignal,
  createLLMDebugFetch,
  createLLMDebugTrace,
  createLinkedLLMDebugTrace,
  flushLLMDebugTraceReads,
  getLLMDebugTrace,
  getLinkedLLMDebugTraceIds,
  omitBase64DebugData,
  runWithLLMDebugTrace,
  setLLMDebugCaptureEnabled,
} from './debugCapture'

describe('debugCapture', () => {
  afterEach(() => {
    setLLMDebugCaptureEnabled(false)
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

  it('assigns signal-less fetches to the newest active trace', async () => {
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

    expect(getLLMDebugTrace(titleTrace.id)?.exchanges).toHaveLength(1)
    expect(getLLMDebugTrace(titleTrace.id)?.exchanges[0].request.url).toBe(
      'https://example.test/title',
    )
    expect(getLLMDebugTrace(mainTrace.id)?.exchanges).toHaveLength(1)
    expect(getLLMDebugTrace(mainTrace.id)?.exchanges[0].request.url).toBe(
      'https://example.test/main',
    )
  })

  it('captures linked sub-LLM requests on their own trace', async () => {
    setLLMDebugCaptureEnabled(true)
    const fetch = createLLMDebugFetch(
      jest.fn(async () => new Response('{"ok":true}')),
      'browser',
    )
    const mainTrace = createLLMDebugTrace({ requestKind: 'streaming' })
    const childTrace = createLinkedLLMDebugTrace({
      parentTraceId: mainTrace.id,
      requestKind: 'sub-llm',
    })

    expect(childTrace).not.toBeNull()
    await runWithLLMDebugTrace(mainTrace.id, async () => {
      await runWithLLMDebugTrace(childTrace?.id, async () => {
        await fetch('https://example.test/sub', {
          method: 'POST',
          body: '{"messages":[]}',
        })
      })
    })
    await flushLLMDebugTraceReads([mainTrace.id, childTrace!.id])

    expect(getLLMDebugTrace(mainTrace.id)?.exchanges).toHaveLength(0)
    expect(getLLMDebugTrace(childTrace!.id)?.exchanges).toHaveLength(1)
    expect(getLinkedLLMDebugTraceIds([mainTrace.id])).toEqual([childTrace!.id])
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

  it('attributes sub-LLM chat requests carrying embedding-like source text to the active trace', async () => {
    setLLMDebugCaptureEnabled(true)
    const fetch = createLLMDebugFetch(
      jest.fn(async () => new Response('{"ok":true}')),
      'browser',
    )
    const mainTrace = createLLMDebugTrace({ requestKind: 'streaming' })
    const childTrace = createLinkedLLMDebugTrace({
      parentTraceId: mainTrace.id,
      requestKind: 'sub-llm',
    })
    expect(childTrace).not.toBeNull()

    // run_model_task large-file case: the sub-LLM chat body embeds source
    // material that incidentally mentions embeddings and an "input": field.
    // No AbortSignal is forwarded to fetch (common for SDK clients), so trace
    // resolution must fall back to the active sub-LLM trace instead of dropping
    // the request as a misclassified embedding call.
    const body = JSON.stringify({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'Answer only from provided material.' },
        {
          role: 'user',
          content:
            'Analyze this file. It documents the embedding pipeline and a sample payload {"input": "vector text"}.',
        },
      ],
    })

    await runWithLLMDebugTrace(mainTrace.id, async () => {
      await runWithLLMDebugTrace(childTrace?.id, async () => {
        await fetch('https://api.example.test/v1/chat/completions', {
          method: 'POST',
          body,
        })
      })
    })
    await flushLLMDebugTraceReads([mainTrace.id, childTrace!.id])

    expect(getLLMDebugTrace(childTrace!.id)?.exchanges).toHaveLength(1)
    expect(getLLMDebugTrace(childTrace!.id)?.exchanges[0].request.url).toBe(
      'https://api.example.test/v1/chat/completions',
    )
    expect(getLLMDebugTrace(mainTrace.id)?.exchanges).toHaveLength(0)
  })

  it('keeps URL-confirmed embedding requests off the active conversation trace', async () => {
    setLLMDebugCaptureEnabled(true)
    const fetch = createLLMDebugFetch(
      jest.fn(async () => new Response('{"data":[]}')),
      'browser',
    )
    const mainTrace = createLLMDebugTrace({ requestKind: 'streaming' })

    // Background RAG embedding overlapping a chat turn: no active
    // embedding-kind trace and no forwarded signal. It must NOT leak into the
    // active chat trace's exported debug log.
    await runWithLLMDebugTrace(mainTrace.id, async () => {
      await fetch('https://api.example.test/v1/embeddings', {
        method: 'POST',
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: 'unrelated vault text',
        }),
      })
    })
    await flushLLMDebugTraceReads([mainTrace.id])

    expect(getLLMDebugTrace(mainTrace.id)?.exchanges).toHaveLength(0)
  })
})
