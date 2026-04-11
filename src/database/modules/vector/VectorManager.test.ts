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
    )

    expect(repository.updateVectorMetadataById).toHaveBeenCalledTimes(1)
    expect(repository.deleteVectorsByIds).toHaveBeenCalledWith([])
    expect(result.chunks.some((chunk) => chunk.content.includes('same body'))).toBe(
      false,
    )
  })
})
