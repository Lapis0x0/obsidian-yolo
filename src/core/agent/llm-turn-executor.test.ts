import { ChatAssistantMessage } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import {
  createCompleteToolCallArguments,
  createPartialToolCallArguments,
} from '../../types/tool-call.types'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { executeSingleTurn } from '../ai/single-turn'
import { BaseLLMProvider } from '../llm/base'
import type { McpManager } from '../mcp/mcpManager'

jest.mock('../mcp/mcpManager', () => {
  class MockedMcpManager {
    static TOOL_NAME_DELIMITER = '__'
  }

  return { McpManager: MockedMcpManager }
})

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

import { AgentLlmTurnExecutor } from './llm-turn-executor'

const mockExecuteSingleTurn = jest.mocked(executeSingleTurn)

class MockProvider extends BaseLLMProvider<LLMProvider> {
  public readonly generateResponseMock = jest.fn<
    Promise<LLMResponseNonStreaming>,
    [ChatModel, LLMRequestNonStreaming, LLMOptions?]
  >()
  public readonly streamResponseMock = jest.fn<
    Promise<AsyncIterable<LLMResponseStreaming>>,
    [ChatModel, LLMRequestStreaming, LLMOptions?]
  >()

  constructor() {
    super({
      presetType: 'openai',
      apiType: 'openai-responses',
      id: 'provider-1',
    })
  }

  generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    return this.generateResponseMock(model, request, options)
  }

  streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    return this.streamResponseMock(model, request, options)
  }

  getEmbedding(): Promise<number[]> {
    return Promise.resolve([])
  }
}

const TEST_MODEL: ChatModel = {
  providerId: 'provider-1',
  id: 'model-1',
  model: 'gpt-4.1',
}

const createMockMcpManager = (tools: unknown[] = []): McpManager =>
  ({
    listAvailableTools: jest.fn().mockResolvedValue(tools),
    getJsSandboxSettings: jest.fn(() => ({})),
    getSettingsSnapshot: jest.fn(() => ({})),
  }) as unknown as McpManager

describe('AgentLlmTurnExecutor', () => {
  beforeEach(() => {
    mockExecuteSingleTurn.mockReset()
  })

  it('passes primary timeout and recovery settings to single turn execution', async () => {
    const provider = new MockProvider()
    mockExecuteSingleTurn.mockResolvedValue({
      content: 'done',
      reasoning: undefined,
      annotations: undefined,
      usage: undefined,
      providerMetadata: undefined,
      toolCalls: [],
    })

    const requestContextBuilder = {
      generateRequestMessages: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'hello' }]),
    } as unknown as RequestContextBuilder

    const mcpManager = createMockMcpManager()

    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder,
      mcpManager,
      conversationId: 'conv-1',
      messages: [],
      enableTools: false,
      includeBuiltinTools: false,
      requestParams: {
        stream: true,
        primaryRequestTimeoutMs: 20000,
        streamFallbackRecoveryEnabled: false,
      },
      onAssistantMessage: () => {},
    })

    await executor.run()

    expect(mockExecuteSingleTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryRequestTimeoutMs: 20000,
        streamFallbackRecoveryEnabled: false,
      }),
    )
  })

  it('keeps streaming arguments for local write tool previews', async () => {
    const provider = new MockProvider()
    mockExecuteSingleTurn.mockImplementation(async ({ onStreamDelta }) => {
      onStreamDelta?.({
        contentDelta: '',
        reasoningDelta: '',
        chunk: {
          id: 'stream-1',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-1',
                    type: 'function',
                    function: {
                      name: 'fs_move',
                      arguments: '{"oldPath":"a.md","newPath":"b.md"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        toolCalls: [
          {
            index: 0,
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'fs_move',
              arguments: createPartialToolCallArguments(
                '{"oldPath":"a.md","newPath":"b.md"}',
              ),
            },
          },
        ],
      })

      return {
        content: '',
        reasoning: '',
        annotations: undefined,
        usage: undefined,
        toolCalls: [
          {
            id: 'tool-1',
            name: 'fs_move',
            arguments: createCompleteToolCallArguments({
              value: { oldPath: 'a.md', newPath: 'b.md' },
              rawText: '{"oldPath":"a.md","newPath":"b.md"}',
            }),
            metadata: undefined,
          },
        ],
      }
    })

    const requestContextBuilder = {
      generateRequestMessages: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'hello' }]),
    } as unknown as RequestContextBuilder

    const mcpManager = createMockMcpManager([
      {
        name: 'yolo_local__fs_move',
        description: 'Move path',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ])

    const observedAssistantMessages: ChatAssistantMessage[] = []
    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder,
      mcpManager,
      conversationId: 'conv-1',
      messages: [],
      enableTools: true,
      includeBuiltinTools: true,
      requestParams: {
        stream: true,
      },
      onAssistantMessage: (message) => {
        observedAssistantMessages.push({
          ...message,
          toolCallRequests: message.toolCallRequests
            ? [...message.toolCallRequests]
            : undefined,
          metadata: message.metadata
            ? {
                ...message.metadata,
              }
            : undefined,
        })
      },
    })

    const result = await executor.run()

    const streamingPreview = observedAssistantMessages.find(
      (message) =>
        message.metadata?.generationState === 'streaming' &&
        (message.toolCallRequests?.length ?? 0) > 0,
    )

    expect(streamingPreview?.toolCallRequests?.[0]).toEqual({
      id: 'tool-1',
      name: 'yolo_local__fs_move',
      arguments: createPartialToolCallArguments(
        '{"oldPath":"a.md","newPath":"b.md"}',
      ),
      metadata: undefined,
    })

    expect(result.toolCallRequests[0]).toEqual({
      id: 'tool-1',
      name: 'yolo_local__fs_move',
      arguments: createCompleteToolCallArguments({
        value: { oldPath: 'a.md', newPath: 'b.md' },
        rawText: '{"oldPath":"a.md","newPath":"b.md"}',
      }),
      metadata: undefined,
    })
  })

  it('marks assistant message error when single turn fails', async () => {
    const provider = new MockProvider()
    const requestContextBuilder = {
      generateRequestMessages: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'hello' }]),
    } as unknown as RequestContextBuilder

    const mcpManager = createMockMcpManager()

    mockExecuteSingleTurn.mockRejectedValue(new Error('network exploded'))

    const observedAssistantMessages: ChatAssistantMessage[] = []
    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder,
      mcpManager,
      conversationId: 'conv-1',
      messages: [],
      enableTools: false,
      includeBuiltinTools: false,
      requestParams: {
        stream: true,
      },
      onAssistantMessage: (message) => {
        observedAssistantMessages.push({
          ...message,
          metadata: message.metadata
            ? {
                ...message.metadata,
              }
            : undefined,
        })
      },
    })

    await expect(executor.run()).rejects.toThrow('network exploded')

    expect(observedAssistantMessages).toHaveLength(2)
    expect(observedAssistantMessages[0].metadata?.generationState).toBe(
      'streaming',
    )
    expect(observedAssistantMessages[1].metadata?.generationState).toBe('error')
    expect(observedAssistantMessages[1].metadata?.errorMessage).toBe(
      'network exploded',
    )
    expect(observedAssistantMessages[1].metadata?.durationMs).toEqual(
      expect.any(Number),
    )
  })

  it('includes nested cause details in assistant error messages', async () => {
    const provider = new MockProvider()
    const requestContextBuilder = {
      generateRequestMessages: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'hello' }]),
    } as unknown as RequestContextBuilder

    const mcpManager = createMockMcpManager()

    const wrappedError = new Error('Connection error.') as Error & {
      cause?: unknown
    }
    wrappedError.cause = new Error(
      'LLM debug capture failed while reading request body.',
    )
    mockExecuteSingleTurn.mockRejectedValue(wrappedError)

    const observedAssistantMessages: ChatAssistantMessage[] = []
    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder,
      mcpManager,
      conversationId: 'conv-1',
      messages: [],
      enableTools: false,
      includeBuiltinTools: false,
      requestParams: {
        stream: true,
      },
      onAssistantMessage: (message) => {
        observedAssistantMessages.push({
          ...message,
          metadata: message.metadata
            ? {
                ...message.metadata,
              }
            : undefined,
        })
      },
    })

    await expect(executor.run()).rejects.toThrow('Connection error.')

    expect(observedAssistantMessages.at(-1)?.metadata?.errorMessage).toBe(
      [
        'Connection error.',
        'Caused by: LLM debug capture failed while reading request body.',
      ].join('\n'),
    )
  })

  it('marks assistant message aborted on abort errors', async () => {
    const provider = new MockProvider()
    const requestContextBuilder = {
      generateRequestMessages: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'hello' }]),
    } as unknown as RequestContextBuilder

    const mcpManager = createMockMcpManager()
    const abortController = new AbortController()
    abortController.abort()

    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    mockExecuteSingleTurn.mockRejectedValue(abortError)

    const observedAssistantMessages: ChatAssistantMessage[] = []
    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder,
      mcpManager,
      conversationId: 'conv-1',
      messages: [],
      enableTools: false,
      includeBuiltinTools: false,
      abortSignal: abortController.signal,
      requestParams: {
        stream: true,
      },
      onAssistantMessage: (message) => {
        observedAssistantMessages.push({
          ...message,
          metadata: message.metadata
            ? {
                ...message.metadata,
              }
            : undefined,
        })
      },
    })

    await expect(executor.run()).rejects.toThrow('aborted')

    expect(observedAssistantMessages.at(-1)?.metadata?.generationState).toBe(
      'aborted',
    )
    expect(
      observedAssistantMessages.at(-1)?.metadata?.errorMessage,
    ).toBeUndefined()
  })

  it('does not treat reasoning-only turns as completed output', async () => {
    const provider = new MockProvider()
    const requestContextBuilder = {
      generateRequestMessages: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'hello' }]),
    } as unknown as RequestContextBuilder

    const mcpManager = createMockMcpManager()

    mockExecuteSingleTurn.mockImplementation(async ({ onStreamDelta }) => {
      onStreamDelta?.({
        contentDelta: '',
        reasoningDelta: 'thinking only',
        chunk: {
          id: 'stream-2',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {},
            },
          ],
        },
      })

      return {
        content: '',
        reasoning: 'thinking only',
        annotations: undefined,
        usage: undefined,
        toolCalls: [],
      }
    })

    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder,
      mcpManager,
      conversationId: 'conv-1',
      messages: [],
      enableTools: false,
      includeBuiltinTools: false,
      requestParams: {
        stream: true,
      },
      onAssistantMessage: () => {},
    })

    const result = await executor.run()

    expect(result.assistantMessage.reasoning).toBe('thinking only')
    expect(result.assistantMessage.content).toBe('')
    expect(result.toolCallRequests).toEqual([])
    expect(result.hasAssistantOutput).toBe(false)
  })

  it('passes hasMemoryTools when memory tools are available', async () => {
    const provider = new MockProvider()
    const requestContextBuilder = {
      generateRequestMessages: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'hello' }]),
    } as unknown as RequestContextBuilder

    const mcpManager = createMockMcpManager([
      {
        name: 'yolo_local__memory_add',
        description: 'Add memory',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ])

    mockExecuteSingleTurn.mockResolvedValue({
      content: 'done',
      reasoning: '',
      annotations: undefined,
      usage: undefined,
      toolCalls: [],
    })

    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder,
      mcpManager,
      conversationId: 'conv-1',
      messages: [],
      enableTools: true,
      includeBuiltinTools: true,
      requestParams: {
        stream: false,
      },
      onAssistantMessage: () => {},
    })

    await executor.run()

    const generateRequestMessagesMock =
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
      requestContextBuilder.generateRequestMessages
    expect(generateRequestMessagesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hasTools: true,
        hasMemoryTools: true,
      }),
    )
  })

  it('does not pass hasMemoryTools for non-memory tools', async () => {
    const provider = new MockProvider()
    const requestContextBuilder = {
      generateRequestMessages: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'hello' }]),
    } as unknown as RequestContextBuilder

    const mcpManager = createMockMcpManager([
      {
        name: 'yolo_local__fs_read',
        description: 'Read file',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ])

    mockExecuteSingleTurn.mockResolvedValue({
      content: 'done',
      reasoning: '',
      annotations: undefined,
      usage: undefined,
      toolCalls: [],
    })

    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder,
      mcpManager,
      conversationId: 'conv-1',
      messages: [],
      enableTools: true,
      includeBuiltinTools: true,
      requestParams: {
        stream: false,
      },
      onAssistantMessage: () => {},
    })

    await executor.run()

    const generateRequestMessagesMock =
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
      requestContextBuilder.generateRequestMessages
    expect(generateRequestMessagesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hasTools: true,
        hasMemoryTools: false,
      }),
    )
  })
})
