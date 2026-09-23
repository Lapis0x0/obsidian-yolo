import { BedrockProvider } from './bedrockProvider'

const createProvider = () =>
  new BedrockProvider({
    id: 'bedrock',
    presetType: 'amazon-bedrock',
    apiType: 'amazon-bedrock',
    apiKey: 'token',
    additionalSettings: { awsRegion: 'us-east-1' },
  })

const createAsyncIterable = <T>(values: T[]): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: async function* () {
    for (const value of values) {
      yield value
    }
  },
})

describe('BedrockProvider', () => {
  it('returns native embeddings through InvokeModel', async () => {
    const provider = createProvider()
    ;(provider as unknown as { client: { send: jest.Mock } }).client = {
      send: jest.fn().mockResolvedValue({
        body: JSON.stringify({
          embedding: [0.1, 0.2, 0.3],
        }),
      }),
    }

    await expect(
      provider.getEmbedding('amazon.titan-embed-text-v2:0', 'hello'),
    ).resolves.toEqual([0.1, 0.2, 0.3])
  })

  it('emits a final finish_reason chunk for Converse streams', async () => {
    const provider = createProvider()
    ;(provider as unknown as { client: { send: jest.Mock } }).client = {
      send: jest.fn().mockResolvedValue({
        stream: createAsyncIterable([
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { text: 'hello' },
            },
          },
          {
            messageStop: {
              stopReason: 'tool_use',
            },
          },
          {
            metadata: {
              usage: {
                inputTokens: 3,
                outputTokens: 5,
                totalTokens: 8,
              },
            },
          },
        ]),
      }),
    }

    const stream = await provider.streamResponse(
      {
        providerId: 'bedrock',
        id: 'model-1',
        model: 'anthropic.claude-3-7-sonnet',
      },
      {
        model: 'anthropic.claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
    )

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    expect(chunks[0]?.choices?.[0]?.delta?.content).toBe('hello')
    expect(chunks[chunks.length - 1]?.choices?.[0]?.finish_reason).toBe(
      'tool_calls',
    )
    expect(chunks[chunks.length - 1]?.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 5,
      total_tokens: 8,
    })
  })

  it('rejects unsupported Bedrock embedding model families clearly', async () => {
    const provider = createProvider()

    await expect(
      provider.getEmbedding('unknown.embedding-model', 'hello'),
    ).rejects.toThrow('Embedding is not yet supported')
  })
})

describe('BedrockProvider Claude reply replay', () => {
  const nativeReply = [
    { type: 'thinking', thinking: 'Look it up.', signature: 'sig-1' },
    { type: 'redacted_thinking', data: 'AQID' },
    { type: 'text', text: 'Reading.' },
    { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.md' } },
  ]

  const streamWith = async (events: unknown[], model: string) => {
    const provider = createProvider()
    ;(provider as unknown as { client: { send: jest.Mock } }).client = {
      send: jest
        .fn()
        .mockResolvedValue({ stream: createAsyncIterable(events) }),
    }
    const stream = await provider.streamResponse(
      { providerId: 'bedrock', id: 'model-1', model },
      { model, messages: [{ role: 'user', content: 'hi' }], stream: true },
    )
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks.at(-1)?.choices?.[0]?.delta?.providerMetadata
  }

  const toolTurn = [
    {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { reasoningContent: { text: 'Look it ' } },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { reasoningContent: { text: 'up.' } },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { reasoningContent: { signature: 'sig-1' } },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 1,
        delta: {
          reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) },
        },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 2,
        delta: { text: 'Reading.' },
      },
    },
    {
      contentBlockStart: {
        contentBlockIndex: 3,
        start: { toolUse: { toolUseId: 'call_1', name: 'read' } },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 3,
        delta: { toolUse: { input: '{"path":"a.md"}' } },
      },
    },
    { contentBlockStop: { contentBlockIndex: 3 } },
    { messageStop: { stopReason: 'tool_use' } },
  ]

  it('assembles the streamed reply with its signature and redacted blocks', async () => {
    expect(
      await streamWith(toolTurn, 'us.anthropic.claude-opus-5-5-v1:0'),
    ).toEqual({ anthropic: { content: nativeReply } })
  })

  it('keeps nothing from a stream that never finished', async () => {
    expect(
      await streamWith(
        toolTurn.slice(0, -1),
        'us.anthropic.claude-opus-5-5-v1:0',
      ),
    ).toBeUndefined()
  })

  it('keeps nothing for a model that is not Claude', async () => {
    expect(await streamWith(toolTurn, 'amazon.nova-pro-v1:0')).toBeUndefined()
  })

  it('sends the reply back as Converse blocks', () => {
    expect(
      BedrockProvider.convertMessages([
        {
          role: 'assistant',
          content: 'Reading.',
          providerMetadata: { anthropic: { content: nativeReply } },
          tool_calls: [
            {
              id: 'call_1',
              name: 'read',
              arguments: '{"path":"a.md"}',
            } as never,
          ],
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: [
          {
            reasoningContent: {
              reasoningText: { text: 'Look it up.', signature: 'sig-1' },
            },
          },
          {
            reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) },
          },
          { text: 'Reading.' },
          {
            toolUse: {
              toolUseId: 'call_1',
              name: 'read',
              input: { path: 'a.md' },
            },
          },
        ],
      },
    ])
  })
})
