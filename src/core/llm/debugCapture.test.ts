import {
  bindLLMDebugTraceToSignal,
  createLLMDebugFetch,
  createLLMDebugTrace,
  flushLLMDebugTraceReads,
  getLLMDebugTrace,
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
})
