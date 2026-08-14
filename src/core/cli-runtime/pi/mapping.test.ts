import { ToolCallResponseStatus } from '../../../types/tool-call.types'

import {
  createPiMappingState,
  extractPiContextUsage,
  extractPiSessionIdentity,
  extractPiUsage,
  getPiTerminalErrorMessage,
  isPiAgentSettled,
  mapPiEntriesToHydration,
  mapPiEvent,
  mapPiModels,
  toPiPrompt,
} from './mapping'

describe('mapPiEvent — message_update delta aggregation', () => {
  it('accumulates text_delta into one streaming assistant message', () => {
    const state = createPiMappingState()
    const first = mapPiEvent(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hel' },
      },
      state,
    )
    const second = mapPiEvent(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'lo' },
      },
      state,
    )

    expect(first).toEqual([
      {
        type: 'message_upsert',
        message: expect.objectContaining({
          id: 'pi-assistant-stream',
          content: 'Hel',
        }),
      },
    ])
    expect(second).toEqual([
      {
        type: 'message_upsert',
        message: expect.objectContaining({
          id: 'pi-assistant-stream',
          content: 'Hello',
        }),
      },
    ])
  })

  it('accumulates thinking_delta separately from text_delta', () => {
    const state = createPiMappingState()
    mapPiEvent(
      {
        type: 'message_update',
        assistantMessageEvent: { text_delta: 'answer' },
      },
      state,
    )
    const events = mapPiEvent(
      {
        type: 'message_update',
        assistantMessageEvent: { thinking_delta: 'pondering' },
      },
      state,
    )

    expect(events).toEqual([
      {
        type: 'message_upsert',
        message: expect.objectContaining({
          id: 'pi-thinking-stream',
          content: '',
          reasoning: 'pondering',
        }),
      },
    ])
  })

  it('keeps concurrent streams separate when an itemId is present', () => {
    const state = createPiMappingState()
    mapPiEvent(
      {
        type: 'message_update',
        itemId: 'a',
        assistantMessageEvent: { text_delta: 'A' },
      },
      state,
    )
    const events = mapPiEvent(
      {
        type: 'message_update',
        itemId: 'b',
        assistantMessageEvent: { text_delta: 'B' },
      },
      state,
    )
    expect(events[0]).toEqual({
      type: 'message_upsert',
      message: expect.objectContaining({ id: 'pi-assistant-b', content: 'B' }),
    })
  })

  it('emits turn_metrics and context_usage from cumulative usage', () => {
    const state = createPiMappingState()
    const events = mapPiEvent(
      {
        type: 'message_update',
        assistantMessageEvent: { text_delta: 'x' },
        usage: {
          input: 100,
          output: 20,
          cacheRead: 40,
          cacheWrite: 0,
          totalTokens: 120,
          cost: 0.01,
        },
      },
      state,
      200_000,
    )

    expect(events).toContainEqual({
      type: 'turn_metrics',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cache_read_input_tokens: 40,
      },
    })
    expect(events).toContainEqual({
      type: 'context_usage',
      usage: {
        promptTokens: 100,
        maxContextTokens: 200_000,
        cacheHitRate: 0.4,
      },
    })
  })
})

describe('mapPiEvent — tool call lifecycle', () => {
  it('upserts a Running tool pair on tool_execution_start, keyed by id', () => {
    const state = createPiMappingState()
    const events = mapPiEvent(
      {
        type: 'tool_execution_start',
        toolCall: { id: 'call-1', name: 'bash', input: { command: 'ls' } },
      },
      state,
    )

    expect(events).toHaveLength(2)
    const [assistant, tool] = events
    expect(assistant.type).toBe('message_upsert')
    expect(tool).toMatchObject({
      type: 'message_upsert',
      message: {
        id: 'pi-result-call-1',
        role: 'tool',
        toolCalls: [
          expect.objectContaining({
            response: { status: ToolCallResponseStatus.Running },
          }),
        ],
      },
    })
  })

  it('does not emit anything for tool_execution_update, only caches output', () => {
    const state = createPiMappingState()
    mapPiEvent(
      {
        type: 'tool_execution_start',
        toolCall: { id: 'call-1', name: 'bash' },
      },
      state,
    )
    const events = mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCall: { id: 'call-1', partialResult: 'partial output' },
      },
      state,
    )
    expect(events).toEqual([])
  })

  it('resolves the same message id to Success on tool_execution_end', () => {
    const state = createPiMappingState()
    mapPiEvent(
      {
        type: 'tool_execution_start',
        toolCall: { id: 'call-1', name: 'bash' },
      },
      state,
    )
    const events = mapPiEvent(
      {
        type: 'tool_execution_end',
        toolCall: { id: 'call-1', result: 'done', isError: false },
      },
      state,
    )

    const toolMessage = events.find(
      (event) =>
        event.type === 'message_upsert' && event.message.role === 'tool',
    )
    expect(toolMessage).toMatchObject({
      message: {
        id: 'pi-result-call-1',
        toolCalls: [
          {
            response: {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: 'done' },
            },
          },
        ],
      },
    })
  })

  it('falls back to the last cached partial output when the end result is empty', () => {
    const state = createPiMappingState()
    mapPiEvent(
      {
        type: 'tool_execution_start',
        toolCall: { id: 'call-1', name: 'bash' },
      },
      state,
    )
    mapPiEvent(
      {
        type: 'tool_execution_update',
        toolCall: { id: 'call-1', output: 'streamed chunk' },
      },
      state,
    )
    const events = mapPiEvent(
      {
        type: 'tool_execution_end',
        toolCall: { id: 'call-1', isError: false },
      },
      state,
    )
    const toolMessage = events.find(
      (event) =>
        event.type === 'message_upsert' && event.message.role === 'tool',
    )
    expect(toolMessage).toMatchObject({
      message: {
        toolCalls: [{ response: { data: { text: 'streamed chunk' } } }],
      },
    })
  })

  it('maps isError to an Error response', () => {
    const state = createPiMappingState()
    mapPiEvent(
      {
        type: 'tool_execution_start',
        toolCall: { id: 'call-1', name: 'bash' },
      },
      state,
    )
    const events = mapPiEvent(
      {
        type: 'tool_execution_end',
        toolCall: { id: 'call-1', result: 'boom', isError: true },
      },
      state,
    )
    const toolMessage = events.find(
      (event) =>
        event.type === 'message_upsert' && event.message.role === 'tool',
    )
    expect(toolMessage).toMatchObject({
      message: {
        toolCalls: [
          { response: { status: ToolCallResponseStatus.Error, error: 'boom' } },
        ],
      },
    })
  })
})

describe('agent_settled / terminal error detection', () => {
  it('recognizes agent_settled as the turn-completion signal', () => {
    expect(isPiAgentSettled({ type: 'agent_settled' })).toBe(true)
    expect(isPiAgentSettled({ type: 'agent_end' })).toBe(false)
  })

  it('extracts the error message from message_end/turn_end with stopReason error', () => {
    expect(
      getPiTerminalErrorMessage({
        type: 'message_end',
        stopReason: 'error',
        errorMessage: 'provider unavailable',
      }),
    ).toBe('provider unavailable')
    expect(
      getPiTerminalErrorMessage({
        type: 'turn_end',
        assistantMessageEvent: {
          stop_reason: 'error',
          error: { message: 'nested failure' },
        },
      }),
    ).toBe('nested failure')
  })

  it('returns null for a non-error stopReason and for unrelated event types', () => {
    expect(
      getPiTerminalErrorMessage({ type: 'message_end', stopReason: 'stop' }),
    ).toBeNull()
    expect(getPiTerminalErrorMessage({ type: 'agent_settled' })).toBeNull()
  })
})

describe('compaction events', () => {
  it('maps compaction_start/compaction_end to compaction_state and a boundary', () => {
    const state = createPiMappingState()
    expect(mapPiEvent({ type: 'compaction_start' }, state)).toEqual([
      { type: 'compaction_state', isCompacting: true },
    ])
    const endEvents = mapPiEvent({ type: 'compaction_end', id: 'c1' }, state)
    expect(endEvents[0]).toEqual({
      type: 'compaction_state',
      isCompacting: false,
    })
    expect(endEvents[1]).toMatchObject({
      type: 'compaction_boundary',
      boundary: { id: 'pi-compact-c1' },
    })
  })
})

describe('extractPiUsage / extractPiContextUsage', () => {
  it('returns null when input/output are missing', () => {
    expect(extractPiUsage({})).toBeNull()
    expect(extractPiContextUsage({}, null)).toBeNull()
  })

  it('propagates a null maxContextTokens when unavailable', () => {
    expect(extractPiContextUsage({ input: 10 }, null)).toEqual({
      promptTokens: 10,
      maxContextTokens: null,
    })
  })
})

describe('extractPiSessionIdentity', () => {
  it('reads sessionId/sessionFile from a flat or nested state record', () => {
    expect(extractPiSessionIdentity({ sessionId: 'abc' })).toEqual({
      sessionId: 'abc',
    })
    expect(
      extractPiSessionIdentity({ state: { session_file: '/tmp/s.jsonl' } }),
    ).toEqual({
      sessionFile: '/tmp/s.jsonl',
    })
    expect(extractPiSessionIdentity({})).toBeNull()
  })
})

describe('toPiPrompt', () => {
  it('passes plain string content through unchanged', () => {
    expect(toPiPrompt('hello')).toEqual({ message: 'hello', images: [] })
  })

  it('extracts base64 images from data URLs and joins text parts', () => {
    const result = toPiPrompt([
      { type: 'text', text: 'look at this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
    expect(result.message).toBe('look at this')
    expect(result.images).toEqual([
      { data: 'AAAA', mimeType: 'image/png', type: 'image' },
    ])
  })

  it('degrades a document (PDF) part to a text placeholder instead of throwing', () => {
    const result = toPiPrompt([
      {
        type: 'document',
        mediaType: 'application/pdf',
        name: 'report.pdf',
        data: 'base64',
      },
    ])
    expect(result.message).toBe('[Attachment: report.pdf]')
    expect(result.images).toEqual([])
  })
})

describe('mapPiModels', () => {
  it('maps discovered models with off|low|medium|high|max reasoning efforts', () => {
    const models = mapPiModels([
      { id: 'gpt-5', label: 'GPT-5', reasoning: true, isDefault: true },
      { id: 'small', name: 'Small', reasoning: false },
    ])
    expect(models).toEqual([
      {
        id: 'gpt-5',
        label: 'GPT-5',
        reasoningEfforts: [
          { id: 'off' },
          { id: 'low' },
          { id: 'medium' },
          { id: 'high' },
          { id: 'max' },
        ],
        isDefault: true,
      },
      { id: 'small', label: 'Small', reasoningEfforts: [{ id: 'off' }] },
    ])
  })

  it('deduplicates by id and skips entries without one', () => {
    const models = mapPiModels([
      { id: 'a', label: 'A' },
      { id: 'a', label: 'A dup' },
      { label: 'no id' },
    ])
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe('a')
  })
})

describe('mapPiEntriesToHydration', () => {
  it('maps a linear session into user/assistant messages', () => {
    const { messages, compactionBoundaries } = mapPiEntriesToHydration([
      { id: 'u1', type: 'user', message: { role: 'user', content: 'hi' } },
      {
        id: 'a1',
        type: 'assistant',
        message: { role: 'assistant', content: 'hello there' },
      },
    ])
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', id: 'u1', promptContent: 'hi' }),
      expect.objectContaining({
        role: 'assistant',
        id: 'a1',
        content: 'hello there',
      }),
    ])
    expect(compactionBoundaries).toEqual([])
  })

  it('resolves a tool call embedded in an assistant entry against its toolResult entry', () => {
    const { messages } = mapPiEntriesToHydration([
      { id: 'u1', type: 'user', message: { role: 'user', content: 'run ls' } },
      {
        id: 'a1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'bash',
              input: { command: 'ls' },
            },
          ],
        },
      },
      {
        id: 't1',
        type: 'toolResult',
        message: { toolCallId: 'call-1', result: 'file1\nfile2' },
      },
    ])
    const toolMessage = messages.find((message) => message.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolCalls: [
        {
          response: {
            status: ToolCallResponseStatus.Success,
            data: { text: 'file1\nfile2' },
          },
        },
      ],
    })
  })

  it('only keeps the current branch when entries form a parent-linked tree', () => {
    const { messages } = mapPiEntriesToHydration([
      { id: 'u1', type: 'user', message: { role: 'user', content: 'first' } },
      {
        id: 'a1',
        parentId: 'u1',
        type: 'assistant',
        message: { role: 'assistant', content: 'reply A' },
      },
      // An abandoned branch off the same parent — must not appear in the
      // active-branch result, which follows the *last* entry's parent chain.
      {
        id: 'a1-alt',
        parentId: 'u1',
        type: 'assistant',
        message: { role: 'assistant', content: 'reply B (dead branch)' },
      },
      {
        id: 'u2',
        parentId: 'a1',
        type: 'user',
        message: { role: 'user', content: 'second' },
      },
    ])
    expect(messages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2'])
  })
})
