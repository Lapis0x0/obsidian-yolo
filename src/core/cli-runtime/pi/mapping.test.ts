import { ToolCallResponseStatus } from '../../../types/tool-call.types'

import {
  buildPiForkSessionContent,
  collectPiForkRawEntries,
  createPiMappingState,
  decodePiModelId,
  encodePiModelId,
  extractPiContextUsage,
  extractPiCurrentModelState,
  extractPiSessionIdentity,
  extractPiUsage,
  getPiTerminalErrorMessage,
  isPiAgentSettled,
  mapPiEntriesToHydration,
  mapPiEvent,
  mapPiModels,
  resetPiMappingState,
  resolvePiRewriteCheckpoint,
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
          id: 'pi-assistant-stream-0',
          content: 'Hel',
        }),
      },
    ])
    expect(second).toEqual([
      {
        type: 'message_upsert',
        message: expect.objectContaining({
          id: 'pi-assistant-stream-0',
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
          id: 'pi-thinking-stream-0',
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

  it('scopes the fallback stream id per turn so a second turn does not edit the first', () => {
    const state = createPiMappingState()
    resetPiMappingState(state)
    const turn1 = mapPiEvent(
      {
        type: 'message_update',
        assistantMessageEvent: { text_delta: 'first' },
      },
      state,
    )
    resetPiMappingState(state)
    const turn2 = mapPiEvent(
      {
        type: 'message_update',
        assistantMessageEvent: { text_delta: 'second' },
      },
      state,
    )

    expect(turn1).toMatchObject([
      { message: { id: 'pi-assistant-stream-1', content: 'first' } },
    ])
    expect(turn2).toMatchObject([
      { message: { id: 'pi-assistant-stream-2', content: 'second' } },
    ])
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

  it('prioritizes the documented event.message.stopReason/errorMessage shape', () => {
    expect(
      getPiTerminalErrorMessage({
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'provider unavailable',
        },
        toolResults: [],
      }),
    ).toBe('provider unavailable')
    // message.errorMessage wins over a conflicting top-level field.
    expect(
      getPiTerminalErrorMessage({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'from message',
        },
        errorMessage: 'from top level',
      }),
    ).toBe('from message')
  })

  it('lets event.message win over a conflicting legacy/top-level stopReason', () => {
    expect(
      getPiTerminalErrorMessage({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop' },
        stopReason: 'error',
      }),
    ).toBeNull()
  })

  it('falls back to the legacy assistantMessageEvent shape when message is absent', () => {
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

describe('encodePiModelId / decodePiModelId', () => {
  it('round-trips a provider/modelId pair', () => {
    expect(
      decodePiModelId(encodePiModelId('anthropic', 'claude-sonnet-4')),
    ).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
    })
  })

  it('takes the first slash as the provider boundary, keeping later slashes in modelId', () => {
    expect(decodePiModelId('openrouter/anthropic/claude-3.5')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-3.5',
    })
  })

  it('returns null for a string with no provider boundary', () => {
    expect(decodePiModelId('gpt-5')).toBeNull()
  })
})

describe('mapPiModels', () => {
  it('maps discovered models with off|low|medium|high|max reasoning efforts', () => {
    const models = mapPiModels([
      {
        id: 'gpt-5',
        provider: 'openai',
        label: 'GPT-5',
        reasoning: true,
        isDefault: true,
      },
      { id: 'small', provider: 'openai', name: 'Small', reasoning: false },
    ])
    expect(models).toEqual([
      {
        id: 'openai/gpt-5',
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
      {
        id: 'openai/small',
        label: 'Small',
        reasoningEfforts: [{ id: 'off' }],
      },
    ])
  })

  it('deduplicates by provider+id and skips entries without a provider or id', () => {
    const models = mapPiModels([
      { id: 'a', provider: 'p1', label: 'A' },
      { id: 'a', provider: 'p1', label: 'A dup' },
      { id: 'a', provider: 'p2', label: 'A (other provider)' },
      { label: 'no id', provider: 'p1' },
      { id: 'no-provider' },
    ])
    expect(models.map((model) => model.id)).toEqual(['p1/a', 'p2/a'])
  })

  it('keeps the same bare model id distinct across different providers', () => {
    const models = mapPiModels([
      { id: 'shared-id', provider: 'anthropic', label: 'Anthropic model' },
      { id: 'shared-id', provider: 'openai', label: 'OpenAI model' },
    ])
    expect(models).toHaveLength(2)
    expect(models.map((model) => model.id)).toEqual([
      'anthropic/shared-id',
      'openai/shared-id',
    ])
  })
})

describe('extractPiCurrentModelState', () => {
  it('reads the current provider/model and thinkingLevel off get_state', () => {
    expect(
      extractPiCurrentModelState({
        model: { id: 'claude-sonnet-4', provider: 'anthropic' },
        thinkingLevel: 'high',
      }),
    ).toEqual({ modelId: 'anthropic/claude-sonnet-4', thinkingLevel: 'high' })
  })

  it('reads from a nested state/session wrapper', () => {
    expect(
      extractPiCurrentModelState({
        state: { model: { id: 'gpt-5', provider: 'openai' } },
      }),
    ).toEqual({ modelId: 'openai/gpt-5', thinkingLevel: null })
  })

  it('returns null when the model or provider is missing', () => {
    expect(extractPiCurrentModelState({ model: { id: 'gpt-5' } })).toBeNull()
    expect(extractPiCurrentModelState({})).toBeNull()
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

  it('follows the response leafId when it points earlier than the last appended entry', () => {
    // `get_entries` is append-only: the client navigated back to `a1` (e.g.
    // a rewrite/fork), so the abandoned `u2`/`a2` entries are still appended
    // after it in the array, but `leafId` says the active branch ends at
    // `a1`. Hydration must follow `leafId`, not "last array element".
    const { messages } = mapPiEntriesToHydration({
      leafId: 'a1',
      entries: [
        { id: 'u1', type: 'user', message: { role: 'user', content: 'first' } },
        {
          id: 'a1',
          parentId: 'u1',
          type: 'assistant',
          message: { role: 'assistant', content: 'reply A' },
        },
        // Appended after a1 but abandoned — not on the leafId's branch.
        {
          id: 'u2',
          parentId: 'a1',
          type: 'user',
          message: { role: 'user', content: 'abandoned follow-up' },
        },
        {
          id: 'a2',
          parentId: 'u2',
          type: 'assistant',
          message: { role: 'assistant', content: 'abandoned reply' },
        },
      ],
    })
    expect(messages.map((message) => message.id)).toEqual(['u1', 'a1'])
  })

  it('falls back to the last appended entry when leafId is absent (bare array response)', () => {
    const { messages } = mapPiEntriesToHydration([
      { id: 'u1', type: 'user', message: { role: 'user', content: 'first' } },
      {
        id: 'a1',
        parentId: 'u1',
        type: 'assistant',
        message: { role: 'assistant', content: 'reply A' },
      },
    ])
    expect(messages.map((message) => message.id)).toEqual(['u1', 'a1'])
  })
})

const linearHistory = [
  { id: 'u1', type: 'user', message: { role: 'user', content: 'first' } },
  {
    id: 'a1',
    type: 'assistant',
    message: { role: 'assistant', content: 'reply A' },
  },
  {
    id: 't1',
    type: 'toolResult',
    message: { toolCallId: 'call-1', result: 'ok' },
  },
  { id: 'u2', type: 'user', message: { role: 'user', content: 'second' } },
  {
    id: 'a2',
    type: 'assistant',
    message: { role: 'assistant', content: 'reply B' },
  },
]

describe('pi rewrite checkpoints', () => {
  it('forks at the previous assistant when rewriting a later user turn', () => {
    expect(resolvePiRewriteCheckpoint(linearHistory, 'u2')).toEqual({
      resumeAt: 'a1',
      userIndex: 1,
    })
  })

  it('matches a live YOLO user-message id by ordinal', () => {
    expect(
      resolvePiRewriteCheckpoint(linearHistory, 'yolo-2', ['yolo-1', 'yolo-2']),
    ).toEqual({ resumeAt: 'a1', userIndex: 1 })
  })

  it('starts a fresh session when rewriting the first user turn', () => {
    expect(resolvePiRewriteCheckpoint(linearHistory, 'u1')).toEqual({
      resumeAt: null,
      userIndex: 0,
    })
  })

  it('keeps tool results that belong to the forked prefix', () => {
    expect(
      collectPiForkRawEntries(linearHistory, 'a1').map((entry) => entry.id),
    ).toEqual(['u1', 'a1', 't1'])
  })

  it('writes a session header plus the forked raw entries', () => {
    const content = buildPiForkSessionContent({
      entries: collectPiForkRawEntries(linearHistory, 'a1'),
      sessionId: 'fork-1',
      timestamp: '2026-08-14T11:00:00.000Z',
      cwd: '/vault',
      parentSession: '/tmp/source.jsonl',
    })
    const lines = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({
      type: 'session',
      id: 'fork-1',
      parentSession: '/tmp/source.jsonl',
    })
    expect(lines.slice(1).map((entry: { id: string }) => entry.id)).toEqual([
      'u1',
      'a1',
      't1',
    ])
  })
})
