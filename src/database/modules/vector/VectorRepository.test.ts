import { VectorRepository } from './VectorRepository'
import { VectorBackend } from './backend/VectorBackend'

const createBackendMock = (): jest.Mocked<VectorBackend> =>
  ({
    kind: 'pglite',
    getFileMtimes: jest.fn(),
    listChunksForPaths: jest.fn(),
    deleteVectorsByIds: jest.fn(),
    deleteVectorsByPaths: jest.fn(),
    bumpMtimeByIds: jest.fn(),
    insertVectors: jest.fn(),
    truncateModel: jest.fn(),
    clearVectorsByModelIds: jest.fn(),
    vacuum: jest.fn(),
    performSimilaritySearch: jest.fn(),
    getEmbeddingStats: jest.fn(),
  }) as jest.Mocked<VectorBackend>

describe('VectorRepository', () => {
  it('defaults to the legacy pglite backend when no backend is configured', () => {
    const repo = new VectorRepository({
      app: {} as never,
      db: null,
    })

    expect(repo.getBackendKind()).toBe('pglite')
  })

  it('delegates similarity search to the selected backend', async () => {
    const backend = createBackendMock()
    backend.performSimilaritySearch.mockResolvedValue([{ id: 1 }] as never)

    const repo = new VectorRepository({
      app: {} as never,
      db: null,
      backend,
    })

    await expect(
      repo.performSimilaritySearch([] as never, {} as never, {
        minSimilarity: 0,
        limit: 5,
      }),
    ).resolves.toEqual([{ id: 1 }])

    expect(backend.performSimilaritySearch).toHaveBeenCalledTimes(1)
  })

  it('delegates vacuum mode to the selected backend', async () => {
    const backend = createBackendMock()
    const repo = new VectorRepository({
      app: {} as never,
      db: null,
      backend,
    })

    await repo.vacuum('full')

    expect(backend.vacuum).toHaveBeenCalledWith('full')
  })
})
