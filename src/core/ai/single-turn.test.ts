import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestBase,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import { createCompleteToolCallArguments } from '../../types/tool-call.types'
import { BaseLLMProvider } from '../llm/base'

import { executeSingleTurn } from './single-turn'

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

const TEST_REQUEST: LLMRequestBase = {
  model: TEST_MODEL.model,
  messages: [{ role: 'user', content: 'hi' }],
}

const completeArgs = (value: Record<string, unknown>, rawText: string) =>
  createCompleteToolCallArguments({ value, rawText })

async function* toAsyncIterable(
  chunks: LLMResponseStreaming[],
): AsyncIterable<LLMResponseStreaming> {
  for (const chunk of chunks) {
    yield chunk
  }
}

describe('executeSingleTurn', () => {
  const consoleWarnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation(() => undefined)

  afterEach(() => {
    consoleWarnSpy.mockClear()
  })

  afterAll(() => {
    consoleWarnSpy.mockRestore()
  })

  it('applies lightweight policy without clearing reasoningType', async () => {
    const provider = new MockProvider()
    provider.generateResponseMock.mockResolvedValue({
      id: 'aux-1',
      model: TEST_MODEL.model,
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Title' },
        },
      ],
    })

    await executeSingleTurn({
      providerClient: provider,
      model: {
        ...TEST_MODEL,
        reasoningType: 'gemini',
        builtinToolProvider: 'openrouter',
        builtinTools: {
          openrouter: { webSearch: { enabled: true, engine: 'native' } },
        },
        customParameters: [
          { key: 'tools', value: '[{"type":"openrouter:web_search"}]' },
        ],
      },
      request: {
        ...TEST_REQUEST,
        reasoningLevel: 'off',
      },
      stream: false,
      purpose: 'lightweight',
      geminiTools: { useWebSearch: true, useUrlContext: true },
    })

    expect(provider.generateResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningType: 'gemini',
        builtinToolProvider: 'none',
        builtinTools: undefined,
        customParameters: [],
      }),
      expect.objectContaining({
        reasoningLevel: 'off',
      }),
      expect.objectContaining({
        geminiTools: undefined,
      }),
    )
  })

  it('uses streamed write tool calls without forcing non-stream refresh', async () => {
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
                      name: 'yolo_local__fs_move',
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
    provider.generateResponseMock.mockResolvedValue({
      id: 'non-stream-1',
      model: TEST_MODEL.model,
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tool-2',
                type: 'function',
                function: {
                  name: 'yolo_local__fs_move',
                  arguments: '{"oldPath":"x.md","newPath":"y.md"}',
                },
              },
            ],
          },
        },
      ],
    })

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).not.toHaveBeenCalled()
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-1',
        name: 'yolo_local__fs_move',
        arguments: completeArgs(
          { oldPath: 'a.md', newPath: 'b.md' },
          '{"oldPath":"a.md","newPath":"b.md"}',
        ),
        metadata: undefined,
      },
    ])
    expect(result.finishReason).toBe('tool_calls')
  })

  it('accepts streamed fs_write arguments without fallback', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-write',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-write',
                    type: 'function',
                    function: {
                      name: 'yolo_local__fs_write',
                      arguments: '{"path":"a.md","content":"hello"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-write',
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

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).not.toHaveBeenCalled()
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-write',
        name: 'yolo_local__fs_write',
        arguments: completeArgs(
          { path: 'a.md', content: 'hello' },
          '{"path":"a.md","content":"hello"}',
        ),
        metadata: undefined,
      },
    ])
  })

  it('preserves streamed nested object chunks that begin with "{\\"', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-nested-object',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-read-1',
                    type: 'function',
                    function: {
                      name: 'yolo_local__fs_read',
                      arguments: '{"paths":["foo.md"],"operation":',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-nested-object',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: '{"type":"lines","startLine":1,"endLine":80}}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-nested-object',
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

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).not.toHaveBeenCalled()
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-read-1',
        name: 'yolo_local__fs_read',
        arguments: completeArgs(
          {
            paths: ['foo.md'],
            operation: {
              type: 'lines',
              startLine: 1,
              endLine: 80,
            },
          },
          '{"paths":["foo.md"],"operation":{"type":"lines","startLine":1,"endLine":80}}',
        ),
        metadata: undefined,
      },
    ])
  })

  it('falls back to non-stream request on streaming protocol errors', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockRejectedValue(new Error('unexpected EOF'))
    provider.generateResponseMock.mockResolvedValue({
      id: 'non-stream-2',
      model: TEST_MODEL.model,
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'ok',
          },
        },
      ],
    })

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('ok')
    expect(result.toolCalls).toEqual([])
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[YOLO] Streaming tool-call recovery triggered.',
      expect.objectContaining({
        reason: 'stream_protocol_error',
        error: 'unexpected EOF',
      }),
    )
  })

  it('does not recover with non-stream fallback when automatic recovery is disabled', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockRejectedValue(new Error('unexpected EOF'))

    await expect(
      executeSingleTurn({
        providerClient: provider,
        model: TEST_MODEL,
        request: TEST_REQUEST,
        stream: true,
        streamFallbackRecoveryEnabled: false,
      }),
    ).rejects.toThrow('unexpected EOF')

    expect(provider.generateResponseMock).not.toHaveBeenCalled()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('falls back to non-stream when streamed local write arguments are invalid', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-2',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-invalid',
                    type: 'function',
                    function: {
                      name: 'yolo_local__fs_edit',
                      arguments: '{"path":"note.md","newText":"x"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-2',
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
    provider.generateResponseMock.mockResolvedValue({
      id: 'non-stream-3',
      model: TEST_MODEL.model,
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tool-valid',
                type: 'function',
                function: {
                  name: 'yolo_local__fs_edit',
                  arguments:
                    '{"path":"note.md","oldText":"world","newText":"ok"}',
                },
              },
            ],
          },
        },
      ],
    })

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-valid',
        name: 'yolo_local__fs_edit',
        arguments: completeArgs(
          {
            path: 'note.md',
            oldText: 'world',
            newText: 'ok',
          },
          '{"path":"note.md","oldText":"world","newText":"ok"}',
        ),
        metadata: undefined,
      },
    ])
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[YOLO] Streaming tool-call recovery triggered.',
      expect.objectContaining({
        reason: 'invalid_write_args',
        finishReason: 'tool_calls',
        toolNames: ['yolo_local__fs_edit'],
      }),
    )
  })

  it('keeps invalid streamed write arguments when automatic recovery is disabled', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-no-recovery',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-invalid',
                    type: 'function',
                    function: {
                      name: 'yolo_local__fs_edit',
                      arguments: '{"path":"note.md","newText":"x"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-no-recovery',
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

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
      streamFallbackRecoveryEnabled: false,
    })

    expect(provider.generateResponseMock).not.toHaveBeenCalled()
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-invalid',
        name: 'yolo_local__fs_edit',
        arguments: completeArgs(
          {
            path: 'note.md',
            newText: 'x',
          },
          '{"path":"note.md","newText":"x"}',
        ),
        metadata: undefined,
      },
    ])
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('falls back to non-stream when streamed write arguments fail schema checks', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-4',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-invalid-schema',
                    type: 'function',
                    function: {
                      name: 'yolo_local__fs_edit',
                      arguments: '{"newText":"missing path and locator"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-4',
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
    provider.generateResponseMock.mockResolvedValue({
      id: 'non-stream-4',
      model: TEST_MODEL.model,
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tool-valid-2',
                type: 'function',
                function: {
                  name: 'yolo_local__fs_edit',
                  arguments:
                    '{"path":"note.md","oldText":"world","newText":"ok"}',
                },
              },
            ],
          },
        },
      ],
    })

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-valid-2',
        name: 'yolo_local__fs_edit',
        arguments: completeArgs(
          {
            path: 'note.md',
            oldText: 'world',
            newText: 'ok',
          },
          '{"path":"note.md","oldText":"world","newText":"ok"}',
        ),
        metadata: undefined,
      },
    ])
  })

  it('falls back when fs_edit uses the removed operations array shape', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-legacy-shape',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-invalid-legacy-shape',
                    type: 'function',
                    function: {
                      name: 'yolo_local__fs_edit',
                      arguments:
                        '{"path":"note.md","operations":[{"type":"append","content":"legacy"}]}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-legacy-shape',
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
    provider.generateResponseMock.mockResolvedValue({
      id: 'non-stream-legacy-shape',
      model: TEST_MODEL.model,
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tool-valid-legacy-retry',
                type: 'function',
                function: {
                  name: 'yolo_local__fs_edit',
                  arguments:
                    '{"path":"note.md","oldText":"world","newText":"ok"}',
                },
              },
            ],
          },
        },
      ],
    })

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-valid-legacy-retry',
        name: 'yolo_local__fs_edit',
        arguments: completeArgs(
          {
            path: 'note.md',
            oldText: 'world',
            newText: 'ok',
          },
          '{"path":"note.md","oldText":"world","newText":"ok"}',
        ),
        metadata: undefined,
      },
    ])
  })

  it('preserves invalid streamed write calls when non-stream recovery fails', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-3',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-invalid-2',
                    type: 'function',
                    function: {
                      name: 'yolo_local__fs_edit',
                      arguments: '{"path":"note.md","newText":"x"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-3',
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
    provider.generateResponseMock.mockRejectedValue(new Error('network error'))

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-invalid-2',
        name: 'yolo_local__fs_edit',
        arguments: completeArgs(
          {
            path: 'note.md',
            newText: 'x',
          },
          '{"path":"note.md","newText":"x"}',
        ),
        metadata: undefined,
      },
    ])
  })

  it('falls back when fs_edit replace oldText is empty', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-5',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-invalid-empty-oldText',
                    type: 'function',
                    function: {
                      name: 'yolo_local__fs_edit',
                      arguments:
                        '{"path":"note.md","oldText":"","newText":"x"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-5',
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
    provider.generateResponseMock.mockResolvedValue({
      id: 'non-stream-5',
      model: TEST_MODEL.model,
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tool-valid-3',
                type: 'function',
                function: {
                  name: 'yolo_local__fs_edit',
                  arguments:
                    '{"path":"note.md","oldText":"world","newText":"ok"}',
                },
              },
            ],
          },
        },
      ],
    })

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-valid-3',
        name: 'yolo_local__fs_edit',
        arguments: completeArgs(
          {
            path: 'note.md',
            oldText: 'world',
            newText: 'ok',
          },
          '{"path":"note.md","oldText":"world","newText":"ok"}',
        ),
        metadata: undefined,
      },
    ])
  })

  it('accepts streamed fs_edit replace_lines arguments without fallback', async () => {
    const provider = new MockProvider()
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-replace-lines',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-replace-lines',
                    type: 'function',
                    function: {
                      name: 'yolo_local__fs_edit',
                      arguments:
                        '{"path":"note.md","startLine":2,"endLine":4,"newText":"x\\ny"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stream-replace-lines',
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

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(provider.generateResponseMock).not.toHaveBeenCalled()
    expect(result.toolCalls).toEqual([
      {
        id: 'tool-replace-lines',
        name: 'yolo_local__fs_edit',
        arguments: completeArgs(
          {
            path: 'note.md',
            startLine: 2,
            endLine: 4,
            newText: 'x\ny',
          },
          '{"path":"note.md","startLine":2,"endLine":4,"newText":"x\\ny"}',
        ),
        metadata: undefined,
      },
    ])
  })

  it('throws when the stream completes without any content, reasoning, tool calls, or finish reason', async () => {
    const provider = new MockProvider()
    // Simulate a misconfigured base URL where the proxy returns an empty SSE
    // stream (zero chunks). Without the guard this would silently return an
    // empty result and surface as a blank assistant bubble.
    provider.streamResponseMock.mockResolvedValue(toAsyncIterable([]))

    await expect(
      executeSingleTurn({
        providerClient: provider,
        model: TEST_MODEL,
        request: TEST_REQUEST,
        stream: true,
      }),
    ).rejects.toThrow(/No content received from the model/)

    // Must not silently fall back to non-stream — the empty-stream symptom
    // would reproduce there too, so retrying it just hides the real cause.
    expect(provider.generateResponseMock).not.toHaveBeenCalled()
  })

  it('does not throw when the stream is empty but provides a finish_reason', async () => {
    const provider = new MockProvider()
    // A legitimate empty completion: the model chose to stop without emitting
    // tokens but did report a terminal finish_reason. This must NOT trip the
    // empty-stream guard.
    provider.streamResponseMock.mockResolvedValue(
      toAsyncIterable([
        {
          id: 'stream-empty-stop',
          model: TEST_MODEL.model,
          object: 'chat.completion.chunk',
          choices: [
            {
              finish_reason: 'stop',
              delta: {},
            },
          ],
        },
      ]),
    )

    const result = await executeSingleTurn({
      providerClient: provider,
      model: TEST_MODEL,
      request: TEST_REQUEST,
      stream: true,
    })

    expect(result.content).toBe('')
    expect(result.finishReason).toBe('stop')
    expect(result.toolCalls).toEqual([])
  })
})
