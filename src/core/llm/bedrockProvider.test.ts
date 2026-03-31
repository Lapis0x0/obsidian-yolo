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
