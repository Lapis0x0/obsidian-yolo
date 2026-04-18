import type { QueryProgressState } from '../../components/chat-view/QueryProgress'

import { RAGEngine, dedupeRagQueryResults } from './ragEngine'

jest.mock('./embedding', () => ({
  getEmbeddingModelClient: jest.fn(() => ({
    id: 'test-embedding-model',
    dimension: 3,
    getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  })),
}))

const baseSettings = {
  embeddingModelId: 'test-embedding-model',
  ragOptions: {
    chunkSize: 500,
    excludePatterns: [],
    includePatterns: [],
    minSimilarity: 0.3,
    limit: 20,
  },
}

const waitForNextTick = async () =>
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('RAGEngine', () => {
  it('dedupes duplicate query rows by path and line range', () => {
    const rows = [
      {
        id: 1,
        path: 'a.md',
        mtime: 1,
        content: 'foo',
        content_hash: 'hash-1',
        model: 'test-embedding-model',
        dimension: 3,
        metadata: { startLine: 10, endLine: 20 },
        similarity: 0.5,
      },
      {
        id: 2,
        path: 'a.md',
        mtime: 1,
        content: 'foo newer',
        content_hash: 'hash-2',
        model: 'test-embedding-model',
        dimension: 3,
        metadata: { startLine: 10, endLine: 20 },
        similarity: 0.8,
      },
      {
        id: 3,
        path: 'b.md',
        mtime: 1,
        content: 'bar',
        content_hash: 'hash-3',
        model: 'test-embedding-model',
        dimension: 3,
        metadata: { startLine: 30, endLine: 31 },
        similarity: 0.7,
      },
    ]

    expect(dedupeRagQueryResults(rows)).toEqual([rows[1], rows[2]])
  })

  it('serializes updateVaultIndex calls across shared engine entrypoints', async () => {
    const updateEvents: string[] = []
    const resolvers: Array<() => void> = []
    const vectorManager = {
      updateVaultIndex: jest
        .fn()
        .mockImplementation(
          async (
            _embeddingModel: unknown,
            options: { reindexAll: boolean },
            onProgress?: (progress: unknown) => void,
          ) => {
            updateEvents.push(`start:${options.reindexAll ? 'full' : 'delta'}`)
            onProgress?.({
              completedChunks: 0,
              totalChunks: 1,
              totalFiles: 1,
              completedFiles: 0,
            })

            await new Promise<void>((resolve) => {
              resolvers.push(() => {
                updateEvents.push(
                  `end:${options.reindexAll ? 'full' : 'delta'}`,
                )
                resolve()
              })
            })
          },
        ),
    }

    const engine = new RAGEngine(
      {} as never,
      baseSettings as never,
      vectorManager as never,
    )
    const progressEvents: QueryProgressState[] = []

    const firstRun = engine.updateVaultIndex({ reindexAll: true }, (progress) =>
      progressEvents.push(progress),
    )
    const secondRun = engine.updateVaultIndex(
      { reindexAll: false },
      (progress) => progressEvents.push(progress),
    )

    await waitForNextTick()
    expect(vectorManager.updateVaultIndex).toHaveBeenCalledTimes(1)
    expect(updateEvents).toEqual(['start:full'])

    resolvers[0]?.()
    await firstRun
    await waitForNextTick()

    expect(vectorManager.updateVaultIndex).toHaveBeenCalledTimes(2)
    expect(updateEvents).toEqual(['start:full', 'end:full', 'start:delta'])

    resolvers[1]?.()
    await secondRun

    expect(updateEvents).toEqual([
      'start:full',
      'end:full',
      'start:delta',
      'end:delta',
    ])
    expect(progressEvents).toHaveLength(2)
    expect(progressEvents.every((event) => event.type === 'indexing')).toBe(
      true,
    )
  })
})
