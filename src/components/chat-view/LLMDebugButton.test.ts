import {
  bindLLMDebugTraceToSignal,
  createLLMDebugFetch,
  createLLMDebugTrace,
  flushLLMDebugTraceReads,
  getLLMDebugTrace,
  getLLMDebugTraces,
  registerLLMDebugTraceForTurn,
  runWithLLMDebugTrace,
  setLLMDebugCaptureEnabled,
} from '../../core/llm/debugCapture'
import { buildLLMDebugMarkdown } from '../../core/llm/debugMarkdown'
import type { ChatAssistantMessage } from '../../types/chat'
import { getLLMDebugTraceIdsForMessages } from './llmDebugTraceSelection'

describe('getLLMDebugTraceIdsForMessages', () => {
  afterEach(() => {
    setLLMDebugCaptureEnabled(false)
  })

  it('collects concurrent main, title-generation, and embedding captures for one user turn', async () => {
    setLLMDebugCaptureEnabled(true)

    const fetch = createLLMDebugFetch(
      jest.fn(async (input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/embeddings')) {
          return new Response(
            JSON.stringify({
              data: [{ embedding: Array.from({ length: 30 }, (_, i) => i) }],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/title')) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Captured Title' } }],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"Main"}}]}',
            'data: {"choices":[{"delta":{"content":" answer"}}]}',
            'data: [DONE]',
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }),
      'browser',
    )

    const conversationId = 'conversation-1'
    const sourceUserMessageId = 'user-1'
    const mainTrace = createLLMDebugTrace({ requestKind: 'streaming' })
    const titleTrace = createLLMDebugTrace({
      requestKind: 'title-generation',
    })
    const embeddingTrace = createLLMDebugTrace({ requestKind: 'embedding' })

    registerLLMDebugTraceForTurn({
      conversationId,
      sourceUserMessageId,
      traceId: titleTrace.id,
    })
    registerLLMDebugTraceForTurn({
      conversationId,
      sourceUserMessageId,
      traceId: embeddingTrace.id,
    })

    const mainController = new AbortController()
    const titleController = new AbortController()
    const embeddingController = new AbortController()
    bindLLMDebugTraceToSignal(mainTrace.id, mainController.signal)
    bindLLMDebugTraceToSignal(titleTrace.id, titleController.signal)
    bindLLMDebugTraceToSignal(embeddingTrace.id, embeddingController.signal)

    await Promise.all([
      runWithLLMDebugTrace(mainTrace.id, () =>
        fetch('https://example.test/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-main',
            messages: [{ role: 'user', content: 'Hello' }],
            stream: true,
          }),
          signal: mainController.signal,
        }),
      ),
      runWithLLMDebugTrace(titleTrace.id, () =>
        fetch('https://example.test/v1/title', {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-title',
            messages: [
              {
                role: 'system',
                content:
                  'You are a title generator. Generate a concise conversation title.',
              },
              { role: 'user', content: 'User first message:\nHello' },
            ],
          }),
          signal: titleController.signal,
        }),
      ),
      runWithLLMDebugTrace(embeddingTrace.id, () =>
        fetch('https://example.test/v1/embeddings', {
          method: 'POST',
          body: JSON.stringify({
            model: 'text-embedding-test',
            input: `LLM training ${'x'.repeat(220)}architecture`,
          }),
          signal: embeddingController.signal,
        }),
      ),
    ])
    await flushLLMDebugTraceReads([
      mainTrace.id,
      titleTrace.id,
      embeddingTrace.id,
    ])

    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'Main answer',
      metadata: {
        branchConversationId: conversationId,
        generationState: 'completed',
        llmDebugTraceId: mainTrace.id,
      },
    }

    const traceIds = getLLMDebugTraceIdsForMessages([assistantMessage])
    expect(traceIds).toEqual(
      expect.arrayContaining([mainTrace.id, titleTrace.id, embeddingTrace.id]),
    )

    const markdown = buildLLMDebugMarkdown(getLLMDebugTraces(traceIds))
    expect(markdown).toContain('## Subrequest 1')
    expect(markdown).toContain('https://example.test/v1/chat/completions')
    expect(markdown).toContain('## Other Requests')
    expect(markdown).toContain('Title generation request')
    expect(markdown).toContain('Captured Title')
    expect(markdown).toContain('Embedding request')
    expect(markdown).toContain('[OMITTED embedding input string: 45 chars]')
  })

  it('captures title requests even when the title fetch drops its bound signal during the main response', async () => {
    setLLMDebugCaptureEnabled(true)

    const fetch = createLLMDebugFetch(
      jest.fn(async (input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/title')) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Dropped Signal Title' } }],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/embeddings')) {
          return new Response(
            JSON.stringify({
              data: [{ embedding: Array.from({ length: 30 }, (_, i) => i) }],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"Main"}}]}',
            'data: [DONE]',
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }),
      'browser',
    )

    const conversationId = 'conversation-1'
    const sourceUserMessageId = 'user-1'
    const mainTrace = createLLMDebugTrace({ requestKind: 'streaming' })
    const titleTrace = createLLMDebugTrace({
      requestKind: 'title-generation',
    })
    registerLLMDebugTraceForTurn({
      conversationId,
      sourceUserMessageId,
      traceId: titleTrace.id,
    })

    const titleController = new AbortController()
    bindLLMDebugTraceToSignal(titleTrace.id, titleController.signal)

    await runWithLLMDebugTrace(mainTrace.id, async () => {
      await runWithLLMDebugTrace(titleTrace.id, async () => {
        // Simulates an SDK transport path that receives the title signal from
        // executeSingleTurn but does not forward it into the underlying fetch.
        // The title-generation heuristic should still attribute it correctly.
        await fetch('https://example.test/v1/title', {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-title',
            messages: [
              {
                role: 'system',
                content:
                  'You are a title generator. Generate a concise conversation title.',
              },
              { role: 'user', content: 'User first message:\nHello' },
            ],
          }),
        })
        // Unrelated background embedding work without an explicit debug trace.
        // We intentionally do NOT capture this into the main/title trace —
        // attributing background RAG / index embeddings to the user's chat
        // turn would leak unrelated vault content into the exported log.
        await fetch('https://example.test/v1/embeddings', {
          method: 'POST',
          body: JSON.stringify({
            model: 'text-embedding-test',
            input: `LLM training ${'x'.repeat(220)}architecture`,
          }),
        })
      })
      await fetch('https://example.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-main',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      })
    })
    await flushLLMDebugTraceReads([mainTrace.id, titleTrace.id])

    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'Main',
      metadata: {
        branchConversationId: conversationId,
        generationState: 'completed',
        llmDebugTraceId: mainTrace.id,
      },
    }

    const traceIds = getLLMDebugTraceIdsForMessages([assistantMessage])
    expect(traceIds).toContain(titleTrace.id)
    expect(getLLMDebugTrace(titleTrace.id)?.exchanges).toHaveLength(1)
    // Only the main chat completion is captured. The background embedding
    // is dropped because no embedding-kind trace is bound to it.
    expect(getLLMDebugTrace(mainTrace.id)?.exchanges).toHaveLength(1)

    const markdown = buildLLMDebugMarkdown(getLLMDebugTraces(traceIds))
    expect(markdown).toContain('Title generation request')
    expect(markdown).toContain('Dropped Signal Title')
    expect(markdown).not.toContain('Embedding request')
  })
})
