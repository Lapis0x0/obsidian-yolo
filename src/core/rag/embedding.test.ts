import { getEmbeddingModelClient } from './embedding'

jest.mock('../llm/manager', () => ({
  getProviderClient: jest.fn(),
}))

import { getProviderClient } from '../llm/manager'

describe('getEmbeddingModelClient', () => {
  const settings = {
    providers: [{ id: 'provider-a' }],
    embeddingModels: [
      {
        id: 'embed-a',
        providerId: 'provider-a',
        model: 'text-embedding-3-small',
        dimension: 1536,
      },
    ],
  } as never

  beforeEach(() => {
    jest.resetAllMocks()
  })

  it('passes the configured dimensions to the provider embedding call', async () => {
    const getEmbedding = jest.fn().mockResolvedValue(new Array(1536).fill(0))
    ;(getProviderClient as jest.Mock).mockReturnValue({
      getEmbedding,
    })

    const client = getEmbeddingModelClient({
      settings,
      embeddingModelId: 'embed-a',
    })

    await client.getEmbedding('hello')

    expect(getEmbedding).toHaveBeenCalledWith(
      'text-embedding-3-small',
      'hello',
      { dimensions: 1536 },
    )
  })

  it('keeps the dimension mismatch guard after provider returns a fallback-sized vector', async () => {
    const getEmbedding = jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
    ;(getProviderClient as jest.Mock).mockReturnValue({
      getEmbedding,
    })

    const client = getEmbeddingModelClient({
      settings,
      embeddingModelId: 'embed-a',
    })

    await expect(client.getEmbedding('hello')).rejects.toThrow(
      'returned 3-dimensional vector, but it is configured as 1536-dimensional',
    )
    expect(getEmbedding).toHaveBeenNthCalledWith(
      1,
      'text-embedding-3-small',
      'hello',
      { dimensions: 1536 },
    )
  })
})
