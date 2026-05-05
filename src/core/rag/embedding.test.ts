import { getEmbeddingModelClient } from './embedding'

const mockGetEmbedding = jest.fn()

jest.mock('../llm/manager', () => ({
  getProviderClient: jest.fn(() => ({
    getEmbedding: mockGetEmbedding,
  })),
}))

const baseModel = {
  id: 'test/model',
  providerId: 'test-provider',
  model: 'text-embedding-test',
  name: 'Test Model',
  dimension: 1536,
}

const baseSettings: any = {
  providers: [{ id: 'test-provider' }],
  embeddingModels: [baseModel],
}

describe('getEmbeddingModelClient', () => {
  beforeEach(() => {
    mockGetEmbedding.mockReset()
  })

  it('(a) nativeDimension absent: calls provider without dimensions option', async () => {
    mockGetEmbedding.mockResolvedValue(new Array(1536).fill(0))

    const client = getEmbeddingModelClient({
      settings: baseSettings,
      embeddingModelId: 'test/model',
    })
    await client.getEmbedding('hello')

    expect(mockGetEmbedding).toHaveBeenCalledWith(
      'text-embedding-test',
      'hello',
      undefined,
    )
  })

  it('(b) dimension === nativeDimension: calls provider without dimensions option', async () => {
    const settings: any = {
      ...baseSettings,
      embeddingModels: [{ ...baseModel, nativeDimension: 1536 }],
    }

    mockGetEmbedding.mockResolvedValue(new Array(1536).fill(0))

    const client = getEmbeddingModelClient({
      settings,
      embeddingModelId: 'test/model',
    })
    await client.getEmbedding('hello')

    expect(mockGetEmbedding).toHaveBeenCalledWith(
      'text-embedding-test',
      'hello',
      undefined,
    )
  })

  it('(c) dimension !== nativeDimension: calls provider with { dimensions } option (also covers legacy data after EditEmbeddingModelModal backfills nativeDimension)', async () => {
    const settings: any = {
      ...baseSettings,
      embeddingModels: [
        { ...baseModel, dimension: 512, nativeDimension: 1536 },
      ],
    }

    mockGetEmbedding.mockResolvedValue(new Array(512).fill(0))

    const client = getEmbeddingModelClient({
      settings,
      embeddingModelId: 'test/model',
    })
    await client.getEmbedding('hello')

    expect(mockGetEmbedding).toHaveBeenCalledWith(
      'text-embedding-test',
      'hello',
      { dimensions: 512 },
    )
  })

  it('(d) throws when provider returns wrong vector length', async () => {
    mockGetEmbedding.mockResolvedValue(new Array(768).fill(0))

    const client = getEmbeddingModelClient({
      settings: baseSettings,
      embeddingModelId: 'test/model',
    })

    await expect(client.getEmbedding('hello')).rejects.toThrow(
      /returned 768-dimensional vector/,
    )
  })
})
