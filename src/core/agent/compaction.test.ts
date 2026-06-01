import type { ChatMessage } from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { RequestMessage, RequestTool } from '../../types/llm/request'
import type { LLMProvider } from '../../types/provider.types'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { executeSingleTurn } from '../ai/single-turn'
import type { BaseLLMProvider } from '../llm/base'

import {
  buildManualCompactionState,
  createConversationCompactionSummary,
  getLatestAssistantContextUsage,
  shouldTriggerAutoContextCompaction,
} from './compaction'

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

const mockedExecuteSingleTurn = executeSingleTurn as jest.MockedFunction<
  typeof executeSingleTurn
>

const fakeProviderClient = {} as BaseLLMProvider<LLMProvider>
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
    // Tools forwarded, tool calls forbidden, standard purpose, non-streaming.
    expect(call.tools).toBe(tools)
    expect(call.tool_choice).toBe('none')
    expect(call.purpose).toBe('standard')
    expect(call.stream).toBe(false)
    // Tail message is the compaction instruction.
    const tail = call.request.messages.at(-1)
    expect(tail?.role).toBe('user')
    expect(typeof tail?.content === 'string' && tail.content).toContain(
      'COMPACTION MODE',
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

  it('injects focusInstruction into the instruction message', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
      focusInstruction: 'keep the API contract details',
    })

    const tail =
      mockedExecuteSingleTurn.mock.calls[0][0].request.messages.at(-1)
    const content = typeof tail?.content === 'string' ? tail.content : ''
    expect(content).toContain(
      '<focus_instruction>keep the API contract details</focus_instruction>',
    )
  })

  it('omits the focus_instruction block when none is provided', async () => {
    mockedExecuteSingleTurn.mockResolvedValueOnce(
      stubSingleTurnResult('<summary>S</summary>'),
    )

    await createConversationCompactionSummary({
      providerClient: fakeProviderClient,
      model: fakeModel,
      requestMessages: prefix,
    })

    const tail =
      mockedExecuteSingleTurn.mock.calls[0][0].request.messages.at(-1)
    const content = typeof tail?.content === 'string' ? tail.content : ''
    expect(content).not.toContain('<focus_instruction>')
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

const baseAutoOptions = {
  autoContextCompactionEnabled: true,
  autoContextCompactionThresholdMode: 'tokens' as const,
  autoContextCompactionThresholdTokens: 100,
  autoContextCompactionThresholdRatio: 0.8,
}

const userMsg = (id: string): ChatMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: 'hi',
  mentionables: [],
})

const assistantMsg = (
  id: string,
  usage?: { prompt_tokens: number },
  model?: Pick<ChatModel, 'maxContextTokens'>,
): ChatMessage => ({
  role: 'assistant',
  id,
  content: 'ok',
  metadata: usage
    ? {
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: 0,
          total_tokens: usage.prompt_tokens,
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

describe('shouldTriggerAutoContextCompaction', () => {
  it('returns false when disabled', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 200 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionEnabled: false,
        },
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('tokens mode: below threshold', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 50 }),
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('tokens mode: at threshold', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 100 }),
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('ratio mode: below ratio', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 70 }, { maxContextTokens: 100 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
          autoContextCompactionThresholdRatio: 0.8,
        },
        maxContextTokens: 100,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('ratio mode: at ratio', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 80 }, { maxContextTokens: 100 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
          autoContextCompactionThresholdRatio: 0.8,
        },
        maxContextTokens: 100,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('ratio mode: missing maxContextTokens', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 99 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
        },
        maxContextTokens: undefined,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('ratio mode: uses the same maxContextTokens source as the header ring', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg(
            'a1',
            { prompt_tokens: 800 },
            { maxContextTokens: 1000 },
          ),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
          autoContextCompactionThresholdRatio: 0.8,
        },
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('still triggers when the latest visible usage comes from an earlier assistant message', () => {
    const emptyArgs = createCompleteToolCallArguments({ value: {} })
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 200 }),
          {
            role: 'tool',
            id: 't1',
            toolCalls: [
              {
                request: {
                  id: 'x',
                  name: 'y',
                  arguments: emptyArgs,
                },
                response: {
                  status: ToolCallResponseStatus.Success,
                  data: { type: 'text', text: '{}' },
                },
              },
            ],
          },
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('assistant missing prompt_tokens', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [userMsg('u1'), assistantMsg('a1')],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('run active', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 200 }),
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: true,
      }),
    ).toBe(false)
  })

  it('does not repeat compaction for same assistant anchor', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 200 }),
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [
          {
            anchorMessageId: 'a1',
            summary: 's',
            compactedAt: 1,
          },
        ],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })
})

describe('buildManualCompactionState loadedDeferredToolSchemas persistence', () => {
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

    const state = await buildManualCompactionState({
      messages,
      summary: 'short summary',
    })
    expect(state?.loadedDeferredToolNames).toEqual(['server__tool_a'])
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

    const state = await buildManualCompactionState({
      messages,
      summary: 's',
    })
    expect(state?.loadedDeferredToolSchemas ?? []).toEqual([])
    // Loaded names list still tracks the tool by name, since the model is told
    // to re-disclose it via load_tool_schemas.
    expect(state?.loadedDeferredToolNames).toEqual(['server__big_tool'])
  })
})

describe('getLatestAssistantContextUsage', () => {
  it('matches the header ring data source by using the latest assistant with prompt tokens', () => {
    const contextUsage = getLatestAssistantContextUsage({
      messages: [
        userMsg('u1'),
        assistantMsg('a1', { prompt_tokens: 100 }),
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
