import type { ChatMessage } from '../../types/chat'
import { getCompactionRetainedStartIndex } from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { RequestMessage, RequestTool } from '../../types/llm/request'
import type { LLMProvider } from '../../types/provider.types'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { markRequestErrorNonRetryable } from '../ai/requestRetry'
import { executeSingleTurn } from '../ai/single-turn'
import type { BaseLLMProvider } from '../llm/base'

import {
  buildAnchoredCompactionState,
  createConversationCompactionSummary,
  estimateNextRequestContextTokens,
  findForcedCompactionRetainedStartIndex,
  getLatestAssistantContextUsage,
  resolveAutoContextCompactionInput,
} from './compaction'

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

const mockedExecuteSingleTurn = executeSingleTurn as jest.MockedFunction<
  typeof executeSingleTurn
>

const fakeProviderClient = {} as unknown as BaseLLMProvider<LLMProvider>
const fakeModel = {
  providerId: 'provider',
  id: 'model-id',
  model: 'model-name',
} as ChatModel

const stubSingleTurnResult = (content: string, toolCalls = []) =>
  ({
    content,
    toolCalls,
  }) as Awaited<ReturnType<typeof executeSingleTurn>>

describe('createConversationCompactionSummary', () => {
  beforeEach(() => {
    mockedExecuteSingleTurn.mockReset()
  })

  const prefix: RequestMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'first user message' },
    { role: 'assistant', content: 'assistant reply' },
  ]
  const tools: RequestTool[] = [
    {
      type: 'function',
      function: {
        name: 'fs_read',
        parameters: { type: 'object', properties: {} },
      },
    },
  ]

  it('reuses the prefix verbatim, appends the instruction, and forwards tools with tool_choice none', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>SUMMARY BODY</summary>'),
    )

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
      tools,
    })

    expect(summary).toBe('SUMMARY BODY')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(1)
    const call = mockedExecuteSingleTurn.mock.calls[0][0]
    // Prefix is reused byte-for-byte at the head of the request.
    expect(call.request.messages.slice(0, prefix.length)).toEqual(prefix)
    // Tools forwarded, tool calls forbidden, standard purpose, buffered delivery.
    expect(call.tools).toBe(tools)
    expect(call.tool_choice).toBe('none')
    expect(call.purpose).toBe('standard')
    expect(call.deliveryMode).toBe('buffered')
    // Tail message is the compaction instruction.
    const tail = call.request.messages.at(-1)
    expect(tail?.role).toBe('user')
    expect(typeof tail?.content === 'string' && tail.content).toContain(
      'paused for context compaction',
    )
  })

  it('appends turn messages between the prefix and the instruction', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )
    const turnMessages: RequestMessage[] = [
      { role: 'assistant', content: 'calling compact' },
    ]

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
      turnMessages,
    })

    const call = mockedExecuteSingleTurn.mock.calls[0][0]
    expect(call.request.messages).toHaveLength(
      prefix.length + turnMessages.length + 1,
    )
    expect(call.request.messages[prefix.length]).toEqual(turnMessages[0])
  })

  it('does not retry a buffered request classified as non-retryable', async () => {
    const error = markRequestErrorNonRetryable(new Error('buffered failure'))
    mockedExecuteSingleTurn.mockRejectedValueOnce(error)

    await expect(
      createConversationCompactionSummary({
        providerClient: fakeProviderClient,
        model: fakeModel,
        requestMessages: prefix,
      }),
    ).rejects.toBe(error)
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(1)
  })

  it('parses a bare summary without tags as a fallback', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('  plain summary text  '),
    )

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    expect(summary).toBe('plain summary text')
  })

  it('retries once when the first response is empty, then succeeds', async () => {
    mockedExecuteSingleTurn
      .mockResolvedValueOnce(stubSingleTurnResult('<summary>   </summary>'))
      .mockResolvedValueOnce(
        stubSingleTurnResult('<summary>recovered</summary>'),
      )

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    expect(summary).toBe('recovered')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(2)
  })

  it('retries on an empty summary even when stray tool calls are present', async () => {
    // An empty summary triggers the retry; the stray tool call is incidental.
    mockedExecuteSingleTurn
      .mockResolvedValueOnce(
        stubSingleTurnResult('', [{ name: 'fs_read' }] as never),
      )
      .mockResolvedValueOnce(stubSingleTurnResult('<summary>ok</summary>'))

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    expect(summary).toBe('ok')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(2)
  })

  it('accepts a non-empty summary even when stray tool calls are returned', async () => {
    // Providers that ignore tool_choice:'none' (Gemini, etc.) may still emit a
    // tool call; as long as summary text exists we accept it without retrying.
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>kept</summary>', [
        { name: 'fs_read' },
      ] as never),
    )

    const summary = await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    expect(summary).toBe('kept')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(1)
  })

  it('forwards the reasoning level into the request', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
      reasoningLevel: 'high',
    })

    const call = mockedExecuteSingleTurn.mock.calls[0][0]
    expect((call.request as { reasoningLevel?: unknown }).reasoningLevel).toBe(
      'high',
    )
  })

  it('omits tool_choice when no tools are provided', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    const call = mockedExecuteSingleTurn.mock.calls[0][0]
    expect(call.tool_choice).toBeUndefined()
  })

  it('throws when both attempts yield an empty summary', async () => {
    mockedExecuteSingleTurn
      .mockResolvedValueOnce(stubSingleTurnResult(''))
      .mockResolvedValueOnce(stubSingleTurnResult(''))

    await expect(
      createConversationCompactionSummary({
        providerClient: fakeProviderClient,
        model: fakeModel,
        requestMessages: prefix,
      }),
    ).rejects.toThrow('empty summary')
    expect(mockedExecuteSingleTurn).toHaveBeenCalledTimes(2)
  })
})

const userMsg = (id: string): ChatMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: 'hi',
  mentionables: [],
})

const assistantMsg = (
  id: string,
  usage?: {
    prompt_tokens: number
    completion_tokens?: number
    cache_read_input_tokens?: number
  },
  model?: Pick<ChatModel, 'maxContextTokens'>,
): ChatMessage => ({
  role: 'assistant',
  id,
  content: 'ok',
  metadata: usage
    ? {
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.prompt_tokens + (usage.completion_tokens ?? 0),
          ...(usage.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: usage.cache_read_input_tokens }
            : {}),
        },
        model: model
          ? ({
              providerId: 'provider',
              id: 'model-id',
              model: 'model-name',
              maxContextTokens: model.maxContextTokens,
            } satisfies ChatModel)
          : undefined,
      }
    : undefined,
})

const toolMsg = (id: string, text: string): ChatMessage => ({
  role: 'tool',
  id,
  toolCalls: [
    {
      request: {
        id: `${id}-call`,
        name: 'yolo_local__fs_read',
        arguments: createCompleteToolCallArguments({ value: {} }),
      },
      response: {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text },
      },
    },
  ],
})

describe('resolveAutoContextCompactionInput', () => {
  const settingsWith = (chatOptions: {
    autoContextCompactionEnabled?: boolean
    autoContextCompactionThresholdRatio?: number
  }) => ({
    chatOptions: chatOptions as never,
    providers: [
      { id: 'provider', presetType: 'openai' } as unknown as LLMProvider,
    ],
  })

  it('takes the ratio of the configured context window', () => {
    expect(
      resolveAutoContextCompactionInput({
        settings: settingsWith({ autoContextCompactionThresholdRatio: 0.5 }),
        model: { ...fakeModel, maxContextTokens: 100_000 },
      }),
    ).toEqual({ thresholdTokens: 50_000 })
  })

  it('assumes a 200k window when the model states none', () => {
    expect(
      resolveAutoContextCompactionInput({
        settings: settingsWith({}),
        model: { ...fakeModel, model: 'unknown-model-xyz' },
      }),
    ).toEqual({ thresholdTokens: 180_000 })
  })

  it('is off when disabled or when the provider owns the conversation', () => {
    expect(
      resolveAutoContextCompactionInput({
        settings: settingsWith({ autoContextCompactionEnabled: false }),
        model: fakeModel,
      }),
    ).toBeUndefined()
    expect(
      resolveAutoContextCompactionInput({
        settings: {
          chatOptions: {} as never,
          providers: [
            {
              id: 'provider',
              presetType: 'claude-oauth',
            } as unknown as LLMProvider,
          ],
        },
        model: fakeModel,
      }),
    ).toBeUndefined()
  })
})

describe('estimateNextRequestContextTokens', () => {
  it('adds a rough count of what came after the latest reported usage', () => {
    const estimate = estimateNextRequestContextTokens({
      messages: [
        userMsg('u1'),
        assistantMsg('a1', { prompt_tokens: 1000, completion_tokens: 50 }),
        toolMsg('t1', 'x'.repeat(40_000)),
      ],
      compactionState: [],
    })
    expect(estimate).toBeGreaterThanOrEqual(1050 + 10_000)
    expect(estimate).toBeLessThan(1050 + 11_000)
  })

  it('counts non-ASCII text a token per character', () => {
    const estimate = estimateNextRequestContextTokens({
      messages: [
        assistantMsg('a1', { prompt_tokens: 0 }),
        toolMsg('t1', '中'.repeat(5_000)),
      ],
      compactionState: [],
    })
    expect(estimate).toBeGreaterThanOrEqual(5_000)
  })

  it('ignores usage reported before the latest compaction anchor', () => {
    expect(
      estimateNextRequestContextTokens({
        messages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 9000 }),
          userMsg('u2'),
        ],
        compactionState: [
          { anchorMessageId: 'a1', summary: 's', compactedAt: 1 },
        ],
      }),
    ).toBeNull()
  })
})

describe('findForcedCompactionRetainedStartIndex', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1'),
    userMsg('u2'),
    assistantMsg('a2'),
    toolMsg('t2', 'result'),
  ]

  it('keeps the latest assistant turn and its tool results mid-run', () => {
    expect(
      findForcedCompactionRetainedStartIndex({
        messages,
        compactionState: [],
        midRun: true,
      }),
    ).toBe(3)
  })

  it('keeps the user messages that opened the run at its start', () => {
    expect(
      findForcedCompactionRetainedStartIndex({
        messages: [...messages, userMsg('u3'), userMsg('u4')],
        compactionState: [],
        midRun: false,
      }),
    ).toBe(5)
  })

  it('returns null when nothing new lies before the retained part', () => {
    expect(
      findForcedCompactionRetainedStartIndex({
        messages,
        compactionState: [
          { anchorMessageId: 'u2', summary: 's', compactedAt: 1 },
        ],
        midRun: true,
      }),
    ).toBeNull()
    expect(
      findForcedCompactionRetainedStartIndex({
        messages: [userMsg('u1')],
        compactionState: [],
        midRun: false,
      }),
    ).toBeNull()
  })
})

describe('buildAnchoredCompactionState retained start', () => {
  it('anchors on the given message and keeps from the retained start', async () => {
    const messages = [
      userMsg('u1'),
      assistantMsg('a1'),
      toolMsg('t1', 'one'),
      assistantMsg('a2'),
      toolMsg('t2', 'two'),
    ]
    const state = await buildAnchoredCompactionState({
      messages,
      anchorIndex: 4,
      retainedStartIndex: 3,
      summary: 's',
    })
    expect(state).toMatchObject({
      anchorMessageId: 't2',
      retainedFromMessageId: 'a2',
      compactedMessageCount: 3,
    })
    expect(getCompactionRetainedStartIndex(messages, state!)).toBe(3)
  })
})

describe('buildAnchoredCompactionState loadedDeferredToolSchemas persistence', () => {
  const emptyArgs = createCompleteToolCallArguments({ value: {} })

  it('persists disclosed on-demand tool schemas after manual compaction', async () => {
    const messages: ChatMessage[] = [
      userMsg('u1'),
      {
        role: 'tool' as const,
        id: 't-search',
        toolCalls: [
          {
            request: {
              id: 'call-search',
              name: 'yolo_local__load_tool_schemas',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text' as const,
                text: JSON.stringify({
                  tool: 'load_tool_schemas',
                  loadedToolNames: ['server__tool_a'],
                  matches: [
                    {
                      name: 'server__tool_a',
                      description: 'Tool A description',
                      parameters: {
                        type: 'object',
                        properties: { value: { type: 'string' } },
                        required: ['value'],
                      },
                    },
                  ],
                }),
              },
            },
          },
        ],
      },
    ]

    const state = await buildAnchoredCompactionState({
      messages,
      anchorIndex: messages.length - 1,
      summary: 'short summary',
    })
    expect(state?.loadedDeferredToolSchemas).toEqual([
      {
        name: 'server__tool_a',
        description: 'Tool A description',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    ])
  })

  it('drops oversized schemas from the compaction registry', async () => {
    const hugeProperties: Record<string, unknown> = {}
    // Inflate the schema well past the 2000-token guard.
    for (let i = 0; i < 5000; i += 1) {
      hugeProperties[`field_${i}`] = {
        type: 'string',
        description: 'x'.repeat(40),
      }
    }
    const messages: ChatMessage[] = [
      userMsg('u1'),
      {
        role: 'tool' as const,
        id: 't-search',
        toolCalls: [
          {
            request: {
              id: 'call-search',
              name: 'yolo_local__load_tool_schemas',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text' as const,
                text: JSON.stringify({
                  tool: 'load_tool_schemas',
                  loadedToolNames: ['server__big_tool'],
                  matches: [
                    {
                      name: 'server__big_tool',
                      description: 'huge schema',
                      parameters: {
                        type: 'object',
                        properties: hugeProperties,
                      },
                    },
                  ],
                }),
              },
            },
          },
        ],
      },
    ]

    const state = await buildAnchoredCompactionState({
      messages,
      anchorIndex: messages.length - 1,
      summary: 's',
    })
    // Dropped outright, name included: the model is told to re-disclose the
    // tool via load_tool_schemas, and the gateway now requires it to.
    expect(state?.loadedDeferredToolSchemas ?? []).toEqual([])
  })
})

describe('getLatestAssistantContextUsage', () => {
  it('matches the header ring data source by using the latest assistant with prompt tokens', () => {
    const contextUsage = getLatestAssistantContextUsage({
      messages: [
        userMsg('u1'),
        assistantMsg('a1', {
          prompt_tokens: 100,
          cache_read_input_tokens: 40,
        }),
        {
          role: 'tool',
          id: 't1',
          toolCalls: [],
        },
      ],
      maxContextTokens: 1000,
    })

    expect(contextUsage).toEqual(
      expect.objectContaining({
        promptTokens: 100,
        maxContextTokens: 1000,
        ratio: 0.1,
        cacheHitRate: 0.4,
      }),
    )
  })

  it('returns usage with null max when the context window is unknown', () => {
    const contextUsage = getLatestAssistantContextUsage({
      messages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 100 })],
      maxContextTokens: undefined,
    })

    expect(contextUsage).toEqual(
      expect.objectContaining({
        promptTokens: 100,
        maxContextTokens: null,
        ratio: null,
      }),
    )
  })
})
