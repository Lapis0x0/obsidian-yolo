import OpenAI from 'openai'

import { OpenAICompatibleProvider } from './openaiCompatibleProvider'

const apiError = (status: number, message: string) =>
  OpenAI.APIError.generate(
    status,
    { error: { message } },
    undefined,
    {} as never,
  )

describe('OpenAICompatibleProvider dimensions fallback', () => {
  const createProvider = () =>
    new OpenAICompatibleProvider({
      id: 'test-openai-compatible',
      name: 'Test OpenAI Compatible',
      presetType: 'openai-compatible',
      apiType: 'openai-compatible',
      apiKey: 'token',
      baseUrl: 'https://example.com/v1',
      enable: true,
      models: [],
      customHeaders: [],
      additionalSettings: {
        requestTransportMode: 'node',
      },
    } as never)

  beforeEach(() => {
    ;(
      OpenAICompatibleProvider as unknown as {
        clearEmbeddingDimensionsSupportCache?: () => void
      }
    ).clearEmbeddingDimensionsSupportCache?.()
  })

  it('retries embeddings without dimensions when the provider rejects the parameter', async () => {
    const provider = createProvider()
    const nodeCreate = jest
      .fn()
      .mockRejectedValueOnce(apiError(400, 'provider rejected request'))
      .mockResolvedValueOnce({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      })

    ;(
      provider as unknown as {
        nodeClient: { embeddings: { create: typeof nodeCreate } }
        browserClient: { embeddings: { create: jest.Mock } }
        obsidianClient: { embeddings: { create: jest.Mock } }
      }
    ).nodeClient = {
      embeddings: { create: nodeCreate },
    }
    ;(
      provider as unknown as {
        browserClient: { embeddings: { create: jest.Mock } }
      }
    ).browserClient = {
      embeddings: { create: jest.fn() },
    }
    ;(
      provider as unknown as {
        obsidianClient: { embeddings: { create: jest.Mock } }
      }
    ).obsidianClient = {
      embeddings: { create: jest.fn() },
    }

    await expect(
      provider.getEmbedding('text-embedding-3-small', 'hello', {
        dimensions: 1536,
      }),
    ).resolves.toEqual([0.1, 0.2, 0.3])

    expect(nodeCreate).toHaveBeenNthCalledWith(1, {
      model: 'text-embedding-3-small',
      input: 'hello',
      encoding_format: 'float',
      dimensions: 1536,
    })
    expect(nodeCreate).toHaveBeenNthCalledWith(2, {
      model: 'text-embedding-3-small',
      input: 'hello',
      encoding_format: 'float',
    })
  })

  it('rethrows non-dimension errors without retrying', async () => {
    const provider = createProvider()
    const nodeCreate = jest
      .fn()
      .mockRejectedValueOnce(apiError(401, 'invalid api key'))

    ;(
      provider as unknown as {
        nodeClient: { embeddings: { create: typeof nodeCreate } }
        browserClient: { embeddings: { create: jest.Mock } }
        obsidianClient: { embeddings: { create: jest.Mock } }
      }
    ).nodeClient = {
      embeddings: { create: nodeCreate },
    }
    ;(
      provider as unknown as {
        browserClient: { embeddings: { create: jest.Mock } }
      }
    ).browserClient = {
      embeddings: { create: jest.fn() },
    }
    ;(
      provider as unknown as {
        obsidianClient: { embeddings: { create: jest.Mock } }
      }
    ).obsidianClient = {
      embeddings: { create: jest.fn() },
    }

    await expect(
      provider.getEmbedding('text-embedding-3-small', 'hello', {
        dimensions: 1536,
      }),
    ).rejects.toThrow('invalid api key')
    expect(nodeCreate).toHaveBeenCalledTimes(1)
  })

  it('shares dimensions fallback knowledge across provider instances', async () => {
    const firstProvider = createProvider()
    const firstNodeCreate = jest
      .fn()
      .mockRejectedValueOnce(apiError(422, 'provider rejected dimensions'))
      .mockResolvedValueOnce({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      })

    ;(
      firstProvider as unknown as {
        nodeClient: { embeddings: { create: typeof firstNodeCreate } }
        browserClient: { embeddings: { create: jest.Mock } }
        obsidianClient: { embeddings: { create: jest.Mock } }
      }
    ).nodeClient = {
      embeddings: { create: firstNodeCreate },
    }
    ;(
      firstProvider as unknown as {
        browserClient: { embeddings: { create: jest.Mock } }
      }
    ).browserClient = {
      embeddings: { create: jest.fn() },
    }
    ;(
      firstProvider as unknown as {
        obsidianClient: { embeddings: { create: jest.Mock } }
      }
    ).obsidianClient = {
      embeddings: { create: jest.fn() },
    }

    await expect(
      firstProvider.getEmbedding('text-embedding-3-small', 'hello', {
        dimensions: 1536,
      }),
    ).resolves.toEqual([0.1, 0.2, 0.3])

    const secondProvider = createProvider()
    const secondNodeCreate = jest.fn().mockResolvedValue({
      data: [{ embedding: [0.4, 0.5, 0.6] }],
    })

    ;(
      secondProvider as unknown as {
        nodeClient: { embeddings: { create: typeof secondNodeCreate } }
        browserClient: { embeddings: { create: jest.Mock } }
        obsidianClient: { embeddings: { create: jest.Mock } }
      }
    ).nodeClient = {
      embeddings: { create: secondNodeCreate },
    }
    ;(
      secondProvider as unknown as {
        browserClient: { embeddings: { create: jest.Mock } }
      }
    ).browserClient = {
      embeddings: { create: jest.fn() },
    }
    ;(
      secondProvider as unknown as {
        obsidianClient: { embeddings: { create: jest.Mock } }
      }
    ).obsidianClient = {
      embeddings: { create: jest.fn() },
    }

    await expect(
      secondProvider.getEmbedding('text-embedding-3-small', 'hello', {
        dimensions: 1536,
      }),
    ).resolves.toEqual([0.4, 0.5, 0.6])

    expect(secondNodeCreate).toHaveBeenCalledTimes(1)
    expect(secondNodeCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'hello',
      encoding_format: 'float',
    })
  })
})
