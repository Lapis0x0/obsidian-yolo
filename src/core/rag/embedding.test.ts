import { getEmbeddingModelClient } from './embedding'
import { LOCAL_EMBEDDING_PROVIDER_ID } from './local-embedding/constants'

const mockGetEmbedding = jest.fn()

jest.mock('../llm/manager', () => ({
  getProviderClient: jest.fn(() => ({
    getEmbedding: mockGetEmbedding,
  })),
}))

const mockLocalGetEmbedding = jest.fn()
const mockLocalDispose = jest.fn()
const mockCreateLocalEmbeddingClient = jest.fn((..._args: unknown[]) => ({
  getEmbedding: mockLocalGetEmbedding,
  dispose: mockLocalDispose,
}))
const mockGetLocalEmbeddingModelManager = jest.fn()

jest.mock('./local-embedding/client', () => ({
  createLocalEmbeddingClient: (...args: unknown[]) =>
    mockCreateLocalEmbeddingClient(...args),
}))
jest.mock('./local-embedding/access', () => ({
  getLocalEmbeddingModelManager: () => mockGetLocalEmbeddingModelManager(),
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

  describe('yolo-local routing', () => {
    const localModel = {
      id: 'local/bge-small-en-v1.5',
      providerId: LOCAL_EMBEDDING_PROVIDER_ID,
      model: 'bge-small-en-v1.5',
      name: 'BGE Small (English)',
      dimension: 384,
    }
    const localSettings: any = {
      providers: [],
      embeddingModels: [localModel],
    }

    beforeEach(() => {
      mockLocalGetEmbedding.mockReset()
      mockLocalDispose.mockReset()
      mockCreateLocalEmbeddingClient.mockClear()
      mockGetLocalEmbeddingModelManager.mockReset()
      mockGetLocalEmbeddingModelManager.mockReturnValue({ fakeManager: true })
    })

    it('routes providerId=yolo-local to createLocalEmbeddingClient instead of getProviderClient', async () => {
      mockLocalGetEmbedding.mockResolvedValue(new Array(384).fill(0))

      const client = getEmbeddingModelClient({
        settings: localSettings,
        embeddingModelId: 'local/bge-small-en-v1.5',
      })
      await client.getEmbedding('hello', { kind: 'query' })

      expect(mockGetEmbedding).not.toHaveBeenCalled()
      expect(mockCreateLocalEmbeddingClient).toHaveBeenCalledWith(
        expect.objectContaining({
          catalogEntry: expect.objectContaining({ id: 'bge-small-en-v1.5' }),
          manager: { fakeManager: true },
        }),
      )
      expect(mockLocalGetEmbedding).toHaveBeenCalledWith('hello', {
        kind: 'query',
      })
    })

    it('applies the same hard dimension check to local results as remote ones', async () => {
      mockLocalGetEmbedding.mockResolvedValue(new Array(111).fill(0))

      const client = getEmbeddingModelClient({
        settings: localSettings,
        embeddingModelId: 'local/bge-small-en-v1.5',
      })

      await expect(client.getEmbedding('hello')).rejects.toThrow(
        /returned 111-dimensional vector/,
      )
    })

    it('exposes dispose() that delegates to the local client', async () => {
      const client = getEmbeddingModelClient({
        settings: localSettings,
        embeddingModelId: 'local/bge-small-en-v1.5',
      })

      await client.dispose?.()

      expect(mockLocalDispose).toHaveBeenCalledTimes(1)
    })

    it('throws a clear error when the catalog entry is unknown', () => {
      const settings: any = {
        providers: [],
        embeddingModels: [{ ...localModel, model: 'does-not-exist' }],
      }

      expect(() =>
        getEmbeddingModelClient({
          settings,
          embeddingModelId: 'local/bge-small-en-v1.5',
        }),
      ).toThrow(/catalog entry "does-not-exist" not found/)
    })

    it('throws a clear error when the local embedding manager is unavailable (mobile)', () => {
      mockGetLocalEmbeddingModelManager.mockReturnValue(null)

      expect(() =>
        getEmbeddingModelClient({
          settings: localSettings,
          embeddingModelId: 'local/bge-small-en-v1.5',
        }),
      ).toThrow(/not available on this platform/)
    })
  })
})
