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
  ProviderExecutedToolCall,
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

  describe('provider tool runs', () => {
    const chunkWith = (
      delta: LLMResponseStreaming['choices'][number]['delta'],
    ): LLMResponseStreaming => ({
      id: 'chunk',
      model: 'gpt-4.1',
      object: 'chat.completion.chunk',
      choices: [{ finish_reason: null, delta }],
    })

    const run = (
      id: string,
      status: 'running' | 'success',
    ): ProviderExecutedToolCall[] => [{ id, name: 'Bash', status }]

    const runExecutor = async (
      stream: (
        emit: (delta: LLMResponseStreaming['choices'][number]['delta']) => void,
      ) => void,
      turnContent: string,
    ) => {
      const log: string[] = []
      mockExecuteSingleTurn.mockImplementation(async (input) => {
        stream((delta) => {
          void input.onStreamDelta?.({
            contentDelta: delta.content ?? '',
            reasoningDelta: '',
            chunk: chunkWith(delta),
          })
        })
        return {
          content: turnContent,
          reasoning: undefined,
          annotations: undefined,
          usage: undefined,
          providerMetadata: undefined,
          toolCalls: [],
        }
      })

      const result = await new AgentLlmTurnExecutor({
        providerClient: new MockProvider(),
        model: TEST_MODEL,
        requestContextBuilder: {
          generateRequestMessages: jest
            .fn()
            .mockResolvedValue([{ role: 'user', content: 'hello' }]),
        } as unknown as RequestContextBuilder,
        mcpManager: createMockMcpManager(),
        conversationId: 'conv-1',
        messages: [],
        enableTools: false,
        includeBuiltinTools: false,
        onAssistantMessage: (message) => {
          log.push(
            `assistant:${message.id}:${message.content}:${message.metadata?.generationState}`,
          )
        },
        onProviderToolRun: (calls) => {
          log.push(`run:${calls[0].id}:${calls[0].status}`)
        },
      }).run()

      return { log, result }
    }

    it('seals the answer before the run and continues after it', async () => {
      const { log, result } = await runExecutor((emit) => {
        emit({ content: 'before' })
        emit({ providerToolRun: run('t1', 'running') })
        emit({ providerToolRun: run('t1', 'success') })
        emit({ content: 'after' })
      }, 'beforeafter')

      // The run has to land between the two halves of the answer: the first
      // message is finished before it, the second opens after it.
      expect(log).toEqual(
        [
          'assistant:$id::streaming',
          'assistant:$id:before:streaming',
          // Every chunk republishes the open message, changed or not; the
          // run-bearing chunk is no exception, and the seal follows it.
          'assistant:$id:before:streaming',
          'assistant:$id:before:completed',
          'run:t1:running',
          'assistant:$id#1::streaming',
          'assistant:$id#1::streaming',
          'run:t1:success',
          'assistant:$id#1:after:streaming',
          'assistant:$id#1:after:completed',
        ].map((entry) =>
          entry.replace('$id', result.assistantMessage.id.split('#')[0]),
        ),
      )
    })

    it('does not split again while the same run is still reporting', async () => {
      const { log } = await runExecutor((emit) => {
        emit({ providerToolRun: run('t1', 'running') })
        emit({ providerToolRun: run('t1', 'success') })
        emit({ providerToolRun: run('t2', 'running') })
      }, '')

      const openedMessages = new Set(
        log
          .filter((entry) => entry.startsWith('assistant:'))
          .map((entry) => entry.split(':')[1]),
      )
      expect(openedMessages.size).toBe(3)
      expect(log.filter((entry) => entry.startsWith('run:'))).toHaveLength(3)
    })

    it('does not replay the turn into a message opened after the last run', async () => {
      // The trailing message is empty because the turn ended on a tool run,
      // not because no delta ever arrived — the non-streaming fallback must
      // not treat it as the latter and paste the whole answer back in.
      const { result } = await runExecutor((emit) => {
        emit({ content: 'all of the answer' })
        emit({ providerToolRun: run('t1', 'success') })
      }, 'all of the answer')

      expect(result.assistantMessage.content).toBe('')
      expect(result.hasAssistantOutput).toBe(true)
    })
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

    const generateRequestMessages = jest
      .fn()
      .mockResolvedValue([{ role: 'user', content: 'hello' }])
    const requestContextBuilder = {
      generateRequestMessages,
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
        deliveryMode: 'incremental',
        primaryRequestTimeoutMs: 20000,
        streamFallbackRecoveryEnabled: false,
      },
      onAssistantMessage: () => {},
    })

    await executor.run()

    expect(generateRequestMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeModePrompt: expect.stringContaining(
          'file editing, path operations, and terminal commands',
        ),
      }),
    )
    expect(mockExecuteSingleTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryRequestTimeoutMs: 20000,
        streamFallbackRecoveryEnabled: false,
      }),
    )
  })

  it('publishes the streaming placeholder before preparing the request', async () => {
    const observed: ChatAssistantMessage[] = []
    const requestContextBuilder = {
      generateRequestMessages: jest.fn(async () => {
        expect(observed).toHaveLength(1)
        expect(observed[0].metadata?.generationState).toBe('streaming')
        return [{ role: 'user' as const, content: 'hello' }]
      }),
    } as unknown as RequestContextBuilder
    mockExecuteSingleTurn.mockResolvedValue({
      content: 'done',
      reasoning: undefined,
      annotations: undefined,
      usage: undefined,
      providerMetadata: undefined,
      toolCalls: [],
    })

    await new AgentLlmTurnExecutor({
      providerClient: new MockProvider(),
      model: TEST_MODEL,
      requestContextBuilder,
      mcpManager: createMockMcpManager(),
      conversationId: 'conv-1',
      messages: [],
      enableTools: false,
      includeBuiltinTools: false,
      onAssistantMessage: (message) => {
        observed.push({
          ...message,
          metadata: message.metadata ? { ...message.metadata } : undefined,
        })
      },
    }).run()

    expect(observed.at(-1)?.metadata?.generationState).toBe('completed')
  })

  it('moves preparation failures onto the visible assistant placeholder', async () => {
    const observed: ChatAssistantMessage[] = []
    const requestContextBuilder = {
      generateRequestMessages: jest
        .fn()
        .mockRejectedValue(new Error('attachment unavailable')),
    } as unknown as RequestContextBuilder

    await expect(
      new AgentLlmTurnExecutor({
        providerClient: new MockProvider(),
        model: TEST_MODEL,
        requestContextBuilder,
        mcpManager: createMockMcpManager(),
        conversationId: 'conv-1',
        messages: [],
        enableTools: false,
        includeBuiltinTools: false,
        onAssistantMessage: (message) => {
          observed.push({
            ...message,
            metadata: message.metadata ? { ...message.metadata } : undefined,
          })
        },
      }).run(),
    ).rejects.toThrow('attachment unavailable')

    expect(observed.at(-1)?.metadata).toMatchObject({
      generationState: 'error',
      errorMessage: 'attachment unavailable',
    })
    expect(mockExecuteSingleTurn).not.toHaveBeenCalled()
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
                      name: 'fs_write',
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
              name: 'fs_write',
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
            name: 'fs_write',
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
        name: 'yolo_local__fs_write',
        description: 'Write file',
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
        deliveryMode: 'incremental',
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
      name: 'yolo_local__fs_write',
      arguments: createPartialToolCallArguments(
        '{"oldPath":"a.md","newPath":"b.md"}',
      ),
      metadata: undefined,
    })

    expect(result.toolCallRequests[0]).toEqual({
      id: 'tool-1',
      name: 'yolo_local__fs_write',
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
        deliveryMode: 'incremental',
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

  it('appends continuation content while preserving the original reasoning', async () => {
    const provider = new MockProvider()
    const interruptedMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-interrupted',
      content: 'Hello',
      reasoning: 'Initial thought. ',
      toolCallRequests: [
        {
          id: 'partial-tool',
          name: 'fs_read',
          arguments: createPartialToolCallArguments('{"path"'),
        },
      ],
      metadata: {
        model: TEST_MODEL,
        generationState: 'error',
        errorMessage: 'Premature close',
        sourceUserMessageId: 'user-1',
      },
    }
    mockExecuteSingleTurn.mockImplementation(async ({ onStreamDelta }) => {
      onStreamDelta?.({
        contentDelta: ' world',
        reasoningDelta: 'Continued thought.',
        chunk: {
          id: 'stream-continue',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [{ finish_reason: null, delta: {} }],
        },
      })
      return {
        content: ' world',
        reasoning: 'Continued thought.',
        annotations: undefined,
        usage: undefined,
        toolCalls: [],
      }
    })

    const observed: ChatAssistantMessage[] = []
    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder: {
        generateRequestMessages: jest
          .fn()
          .mockResolvedValue([{ role: 'user', content: 'continue' }]),
      } as unknown as RequestContextBuilder,
      mcpManager: createMockMcpManager(),
      conversationId: 'conv-1',
      messages: [],
      sourceUserMessageId: 'user-1',
      enableTools: false,
      includeBuiltinTools: false,
      resumeAssistantMessage: interruptedMessage,
      onAssistantMessage: (message) => {
        observed.push({
          ...message,
          metadata: message.metadata ? { ...message.metadata } : undefined,
          toolCallRequests: message.toolCallRequests
            ? [...message.toolCallRequests]
            : undefined,
        })
      },
    })

    const result = await executor.run()

    expect(observed[0]).toEqual(
      expect.objectContaining({
        id: interruptedMessage.id,
        content: 'Hello',
        toolCallRequests: undefined,
        metadata: expect.objectContaining({
          generationState: 'streaming',
          errorMessage: undefined,
        }),
      }),
    )
    expect(result.assistantMessage).toEqual(
      expect.objectContaining({
        id: interruptedMessage.id,
        content: 'Hello world',
        reasoning: 'Initial thought. ',
        toolCallRequests: undefined,
        metadata: expect.objectContaining({ generationState: 'completed' }),
      }),
    )
  })

  it('keeps cumulative continuation text when the resumed stream fails again', async () => {
    const provider = new MockProvider()
    mockExecuteSingleTurn.mockImplementation(async ({ onStreamDelta }) => {
      onStreamDelta?.({
        contentDelta: ' more',
        reasoningDelta: '',
        chunk: {
          id: 'stream-failed-again',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [{ finish_reason: null, delta: {} }],
        },
      })
      throw new Error('socket hang up')
    })

    const observed: ChatAssistantMessage[] = []
    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      requestContextBuilder: {
        generateRequestMessages: jest
          .fn()
          .mockResolvedValue([{ role: 'user', content: 'continue' }]),
      } as unknown as RequestContextBuilder,
      mcpManager: createMockMcpManager(),
      conversationId: 'conv-1',
      messages: [],
      sourceUserMessageId: 'user-1',
      enableTools: false,
      includeBuiltinTools: false,
      resumeAssistantMessage: {
        role: 'assistant',
        id: 'assistant-interrupted',
        content: 'partial',
        metadata: {
          model: TEST_MODEL,
          generationState: 'error',
          errorMessage: 'Premature close',
        },
      },
      onAssistantMessage: (message) => {
        observed.push({
          ...message,
          metadata: message.metadata ? { ...message.metadata } : undefined,
        })
      },
    })

    await expect(executor.run()).rejects.toThrow('socket hang up')
    expect(observed.at(-1)).toEqual(
      expect.objectContaining({
        id: 'assistant-interrupted',
        content: 'partial more',
        metadata: expect.objectContaining({
          generationState: 'error',
          errorMessage: 'socket hang up',
        }),
      }),
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
        deliveryMode: 'incremental',
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
        deliveryMode: 'incremental',
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
        deliveryMode: 'incremental',
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
        deliveryMode: 'buffered',
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
        deliveryMode: 'buffered',
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
