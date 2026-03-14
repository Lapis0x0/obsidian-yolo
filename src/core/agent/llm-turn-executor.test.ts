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
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { BaseLLMProvider } from '../llm/base'
import type { McpManager } from '../mcp/mcpManager'

jest.mock('../mcp/mcpManager', () => {
  class MockedMcpManager {
    static TOOL_NAME_DELIMITER = '__'
  }

  return { McpManager: MockedMcpManager }
})

import { AgentLlmTurnExecutor } from './llm-turn-executor'

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
      type: 'openai',
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
  providerType: 'openai',
  providerId: 'provider-1',
  id: 'model-1',
  model: 'gpt-4.1',
}

async function* toAsyncIterable(
  chunks: LLMResponseStreaming[],
): AsyncIterable<LLMResponseStreaming> {
  for (const chunk of chunks) {
    yield chunk
  }
}

describe('AgentLlmTurnExecutor', () => {
  it('keeps streaming arguments for local write tool previews', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
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
        {
          id: 'stream-1',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: 'tool_calls',
              delta: {},
            },
          ],
        },
      ]),
    )

    const promptGenerator = {
      generateRequestMessages: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'hello' }]),
    } as unknown as PromptGenerator

    const mcpManager = {
      listAvailableTools: jest.fn().mockResolvedValue([
        {
          name: 'yolo_local__fs_move',
          description: 'Move path',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ]),
    } as unknown as McpManager

    const observedAssistantMessages: ChatAssistantMessage[] = []
    const executor = new AgentLlmTurnExecutor({
      providerClient: provider,
      model: TEST_MODEL,
      promptGenerator,
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
      arguments: '{"oldPath":"a.md","newPath":"b.md"}',
      metadata: undefined,
    })

    expect(result.toolCallRequests[0]).toEqual({
      id: 'tool-1',
      name: 'yolo_local__fs_move',
      arguments: '{"oldPath":"a.md","newPath":"b.md"}',
      metadata: undefined,
    })
  })
})
