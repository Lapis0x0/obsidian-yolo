jest.mock('../../../components/modals/ErrorModal', () => ({
  ErrorModal: class {
    open() {
      return this
    }
  },
}))

import { VectorManager } from './VectorManager'

describe('VectorManager incremental chunk reuse', () => {
  it('reuses unchanged chunks by content hash even when line numbers shift', async () => {
    const app = {
      vault: {
        cachedRead: jest
          .fn()
          .mockResolvedValue('intro line\nsame body line 1\nsame body line 2'),
      },
    }
    const manager = new VectorManager(app as never, {} as never)
    const repository = {
      getChunkMetaForFile: jest.fn().mockResolvedValue([
        {
          id: 7,
          mtime: 1,
          content: 'same body line 1\nsame body line 2',
          content_hash: null,
          metadata: { startLine: 1, endLine: 2 },
        },
      ]),
      deleteVectorsByIds: jest.fn().mockResolvedValue(undefined),
      updateVectorsMtimeByIds: jest.fn().mockResolvedValue(undefined),
      updateVectorMetadataById: jest.fn().mockResolvedValue(undefined),
    }
    ;(manager as unknown as { repository: typeof repository }).repository =
      repository

    const splitter = {
      createDocuments: jest.fn().mockResolvedValue([
        {
          pageContent: 'intro line',
          metadata: { loc: { lines: { from: 1, to: 1 } } },
        },
        {
          pageContent: 'same body line 1\nsame body line 2',
          metadata: { loc: { lines: { from: 2, to: 3 } } },
        },
      ]),
    }
    const embeddingModel = {
      id: 'test-model',
      dimension: 3,
    }

    const result = await (
      manager as unknown as {
        collectChunksForFile: (
          file: { path: string; stat: { mtime: number } },
          textSplitter: {
            createDocuments: () => Promise<
              Array<{
                pageContent: string
                metadata: { loc: { lines: { from: number; to: number } } }
              }>
            >
          },
          embeddingModel: { id: string; dimension: number },
          reindexAll: boolean,
          chunkSize: number,
          stagingModelId?: string | null,
          stagedFingerprints?: Set<string>,
          signal?: AbortSignal,
        ) => Promise<{
          chunks: Array<{ content: string }>
          totalChunkLines: number
        }>
      }
    ).collectChunksForFile(
      {
        path: 'foo.md',
        stat: { mtime: 2 },
      },
      splitter,
      embeddingModel,
      false,
      1000,
    )

    expect(repository.updateVectorMetadataById).toHaveBeenCalledTimes(1)
    expect(repository.deleteVectorsByIds).toHaveBeenCalledWith([])
    expect(
      result.chunks.some((chunk) => chunk.content.includes('same body')),
    ).toBe(false)
  })

  it('uses staging model ids for full rebuilds before promoting results', async () => {
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([
          {
            path: 'foo.md',
            extension: 'md',
            stat: { mtime: 3 },
          },
        ]),
        cachedRead: jest.fn().mockResolvedValue('hello world'),
      },
    }
    const manager = new VectorManager(app as never, {} as never)
    const repository = {
      clearStagingVectorsForModel: jest.fn().mockResolvedValue(undefined),
      clearAllVectors: jest.fn().mockResolvedValue(undefined),
      insertVectors: jest.fn().mockResolvedValue(undefined),
      replaceModelContents: jest.fn().mockResolvedValue(undefined),
      hasVectorsForModelId: jest.fn().mockResolvedValue(false),
      deleteStagingRowsOutsideScope: jest.fn().mockResolvedValue(undefined),
      deleteStagingRowsForFileExceptFingerprints: jest
        .fn()
        .mockResolvedValue(undefined),
      getStagingFingerprints: jest.fn().mockResolvedValue(new Map()),
    }
    ;(
      manager as unknown as {
        repository: typeof repository
        requestSave: () => Promise<void>
        requestVacuum: () => Promise<void>
      }
    ).repository = repository
    ;(manager as unknown as { requestSave: jest.Mock }).requestSave = jest
      .fn()
      .mockResolvedValue(undefined)
    ;(manager as unknown as { requestVacuum: jest.Mock }).requestVacuum = jest
      .fn()
      .mockResolvedValue(undefined)
    ;(
      manager as unknown as {
        collectChunksForFile: () => Promise<{
          chunks: Array<{
            path: string
            mtime: number
            content: string
            content_hash: string
            metadata: { startLine: number; endLine: number }
          }>
          totalChunkLines: number
        }>
      }
    ).collectChunksForFile = jest.fn().mockResolvedValue({
      chunks: [
        {
          path: 'foo.md',
          mtime: 3,
          content: 'hello world',
          content_hash: 'hash',
          metadata: { startLine: 1, endLine: 1 },
        },
      ],
      totalChunkLines: 1,
    })

    await manager.updateVaultIndex(
      {
        id: 'test-model',
        dimension: 3,
        getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      },
      {
        chunkSize: 500,
        excludePatterns: [],
        includePatterns: [],
        reindexAll: true,
        indexRunId: 'run-123',
      },
    )

    // Resumable rebuild: default path scope-filters staging and does NOT wipe it.
    expect(repository.clearStagingVectorsForModel).not.toHaveBeenCalled()
    expect(repository.deleteStagingRowsOutsideScope).toHaveBeenCalledWith(
      'test-model::staging:run-123',
      ['foo.md'],
    )
    expect(repository.insertVectors).toHaveBeenCalledWith([
      expect.objectContaining({
        model: 'test-model::staging:run-123',
      }),
    ])
    expect(repository.replaceModelContents).toHaveBeenCalledWith({
      activeModelId: 'test-model',
      stagingModelId: 'test-model::staging:run-123',
    })
  })

  it('drops stale staging chunks for changed files before promoting a resumed rebuild', async () => {
    const app = {
      vault: {
        cachedRead: jest.fn().mockResolvedValue('updated content'),
      },
    }
    const manager = new VectorManager(app as never, {} as never)
    const repository = {
      deleteStagingRowsForFileExceptFingerprints: jest
        .fn()
        .mockResolvedValue(undefined),
    }
    ;(manager as unknown as { repository: typeof repository }).repository =
      repository

    const splitter = {
      createDocuments: jest.fn().mockResolvedValue([
        {
          pageContent: 'updated content',
          metadata: { loc: { lines: { from: 1, to: 1 } } },
        },
      ]),
    }

    const result = await (
      manager as unknown as {
        collectChunksForFile: (
          file: { path: string; stat: { mtime: number } },
          textSplitter: {
            createDocuments: () => Promise<
              Array<{
                pageContent: string
                metadata: { loc: { lines: { from: number; to: number } } }
              }>
            >
          },
          embeddingModel: { id: string; dimension: number },
          reindexAll: boolean,
          chunkSize: number,
          stagingModelId?: string | null,
          stagedFingerprints?: Set<string>,
          signal?: AbortSignal,
        ) => Promise<{
          chunks: Array<{ content: string }>
          totalChunkLines: number
        }>
      }
    ).collectChunksForFile(
      {
        path: 'foo.md',
        stat: { mtime: 4 },
      },
      splitter,
      {
        id: 'test-model',
        dimension: 3,
      },
      true,
      1000,
      'test-model::staging:run-123',
      new Set(['1:1:oldhash']),
    )

    expect(
      repository.deleteStagingRowsForFileExceptFingerprints,
    ).toHaveBeenCalledWith('test-model::staging:run-123', 'foo.md', [
      expect.stringMatching(/^1:1:/),
    ])
    expect(result.chunks).toEqual([
      expect.objectContaining({ content: 'updated content' }),
    ])
  })

  it('promotes an empty staging rebuild when there are no markdown files', async () => {
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([]),
      },
    }
    const manager = new VectorManager(app as never, {} as never)
    const repository = {
      clearStagingVectorsForModel: jest.fn().mockResolvedValue(undefined),
      clearAllVectors: jest.fn().mockResolvedValue(undefined),
      replaceModelContents: jest.fn().mockResolvedValue(undefined),
      deleteStagingRowsOutsideScope: jest.fn().mockResolvedValue(undefined),
      deleteStagingRowsForFileExceptFingerprints: jest
        .fn()
        .mockResolvedValue(undefined),
      getStagingFingerprints: jest.fn().mockResolvedValue(new Map()),
    }
    ;(
      manager as unknown as {
        repository: typeof repository
        requestSave: () => Promise<void>
        requestVacuum: () => Promise<void>
      }
    ).repository = repository
    ;(manager as unknown as { requestSave: jest.Mock }).requestSave = jest
      .fn()
      .mockResolvedValue(undefined)
    ;(manager as unknown as { requestVacuum: jest.Mock }).requestVacuum = jest
      .fn()
      .mockResolvedValue(undefined)

    await manager.updateVaultIndex(
      {
        id: 'test-model',
        dimension: 3,
        getEmbedding: jest.fn(),
      },
      {
        chunkSize: 500,
        excludePatterns: [],
        includePatterns: [],
        reindexAll: true,
        indexRunId: 'run-empty',
      },
    )

    // Empty-scope rebuild: default path scope-filters (with empty list) and promotes.
    expect(repository.clearStagingVectorsForModel).not.toHaveBeenCalled()
    expect(repository.deleteStagingRowsOutsideScope).toHaveBeenCalledWith(
      'test-model::staging:run-empty',
      [],
    )
    expect(repository.replaceModelContents).toHaveBeenCalledWith({
      activeModelId: 'test-model',
      stagingModelId: 'test-model::staging:run-empty',
    })
  })
})
