jest.mock('../../../components/modals/ErrorModal', () => ({
  ErrorModal: class {
    open() {
      return this
    }
  },
}))

jest.mock('../../../utils/pdf/extractPdfText', () => ({
  PDF_INDEX_MAX_BYTES: 50_000_000,
  PDF_INDEX_MAX_PAGES: 1000,
  extractPdfText: jest.fn(),
}))

import { VectorManager } from './VectorManager'

type ManagerInternals = {
  repository: Record<string, jest.Mock>
}

const setupManager = (
  files: Array<{ path: string; mtime: number; content: string }>,
  existingRows: Array<{
    id: number
    path: string
    mtime: number
    content_hash: string | null
    metadata: { startLine: number; endLine: number; page?: number }
  }>,
  inserted: { rows: unknown[] } = { rows: [] },
) => {
  const fileObjects = files.map((f) => ({
    path: f.path,
    extension: 'md',
    stat: { mtime: f.mtime, size: f.content.length },
  }))
  const fileContent = new Map(files.map((f) => [f.path, f.content]))
  const app = {
    vault: {
      getFiles: jest.fn().mockReturnValue(fileObjects),
      cachedRead: jest.fn(
        async (file: { path: string }) => fileContent.get(file.path) ?? '',
      ),
    },
  }
  const manager = new VectorManager(app as never, {} as never)
  const mtimeMap = new Map(existingRows.map((r) => [r.path, r.mtime]))
  const repository = {
    getFileMtimes: jest.fn().mockResolvedValue(mtimeMap),
    listChunksForPaths: jest.fn(async (_modelId: string, paths: string[]) => {
      const set = new Set(paths)
      return existingRows.filter((r) => set.has(r.path))
    }),
    deleteVectorsByIds: jest.fn().mockResolvedValue(undefined),
    bumpMtimeByIds: jest.fn().mockResolvedValue(undefined),
    insertVectors: jest.fn(async (rows: unknown[]) => {
      inserted.rows.push(...rows)
    }),
    truncateModel: jest.fn().mockResolvedValue(undefined),
  }
  ;(manager as unknown as ManagerInternals).repository =
    repository as unknown as ManagerInternals['repository']
  manager.setSaveCallback(async () => undefined)
  manager.setVacuumCallback(async () => undefined)
  return { manager, repository, app, inserted }
}

const embeddingModel = {
  id: 'test-model',
  dimension: 3,
  getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
} as never

const baseConfig = {
  chunkSize: 1000,
  includePatterns: [],
  excludePatterns: [],
  indexPdf: false,
}

describe('VectorManager.reconcile', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
  })

  it('embeds new files when index is empty', async () => {
    const { manager, repository, inserted } = setupManager(
      [{ path: 'a.md', mtime: 100, content: 'hello world' }],
      [],
    )
    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })
    expect(repository.insertVectors).toHaveBeenCalledTimes(1)
    expect(repository.deleteVectorsByIds).not.toHaveBeenCalled()
    expect(inserted.rows.length).toBeGreaterThan(0)
  })

  it('skips unchanged files (mtime equal) without re-embedding', async () => {
    const { manager, repository } = setupManager(
      [{ path: 'a.md', mtime: 100, content: 'hello' }],
      [
        {
          id: 1,
          path: 'a.md',
          mtime: 100,
          content_hash: 'h',
          metadata: { startLine: 1, endLine: 1 },
        },
      ],
    )
    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })
    expect(repository.insertVectors).not.toHaveBeenCalled()
    expect(repository.deleteVectorsByIds).not.toHaveBeenCalled()
  })

  it('deletes vectors for files removed from the vault (scope=all)', async () => {
    const { manager, repository } = setupManager(
      [],
      [
        {
          id: 7,
          path: 'gone.md',
          mtime: 100,
          content_hash: 'h',
          metadata: { startLine: 1, endLine: 1 },
        },
      ],
    )
    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })
    expect(repository.deleteVectorsByIds).toHaveBeenCalledWith([7])
    expect(repository.insertVectors).not.toHaveBeenCalled()
  })

  it('deletes vectors for files newly excluded by patterns', async () => {
    const { manager, repository } = setupManager(
      [{ path: 'docs/a.md', mtime: 100, content: 'hello' }],
      [
        {
          id: 9,
          path: 'docs/a.md',
          mtime: 100,
          content_hash: 'h',
          metadata: { startLine: 1, endLine: 1 },
        },
      ],
    )
    await manager.reconcile(
      embeddingModel,
      { ...baseConfig, excludePatterns: ['docs/**'] },
      { scope: { kind: 'all' } },
    )
    expect(repository.deleteVectorsByIds).toHaveBeenCalledWith([9])
    expect(repository.insertVectors).not.toHaveBeenCalled()
  })

  it('limits effects to scope=paths and ignores rows outside that scope', async () => {
    const { manager, repository } = setupManager(
      [
        { path: 'a.md', mtime: 200, content: 'updated' },
        { path: 'b.md', mtime: 100, content: 'unchanged' },
      ],
      [
        {
          id: 1,
          path: 'a.md',
          mtime: 100,
          content_hash: 'old',
          metadata: { startLine: 1, endLine: 1 },
        },
        {
          id: 2,
          path: 'b.md',
          mtime: 100,
          content_hash: 'h',
          metadata: { startLine: 1, endLine: 1 },
        },
      ],
    )
    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'paths', paths: ['a.md'] },
    })
    // Only a.md should be touched. b.md (out of scope) untouched.
    const deleted = repository.deleteVectorsByIds.mock.calls.flatMap(
      (call) => call[0] as number[],
    )
    expect(deleted).toEqual([1])
    expect(repository.insertVectors).toHaveBeenCalledTimes(1)
  })

  it('truncates the model when truncate=true and embeds everything fresh', async () => {
    const { manager, repository } = setupManager(
      [{ path: 'a.md', mtime: 100, content: 'hello' }],
      [
        {
          id: 1,
          path: 'a.md',
          mtime: 100,
          content_hash: 'h',
          metadata: { startLine: 1, endLine: 1 },
        },
      ],
    )
    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
      truncate: true,
    })
    expect(repository.truncateModel).toHaveBeenCalledWith('test-model')
    // After truncate, mtime map is empty so the file is treated as new.
    expect(repository.insertVectors).toHaveBeenCalledTimes(1)
  })

  it('treats a single-path delete as a file-removal event', async () => {
    const { manager, repository } = setupManager(
      [],
      [
        {
          id: 5,
          path: 'a.md',
          mtime: 100,
          content_hash: 'h',
          metadata: { startLine: 1, endLine: 1 },
        },
      ],
    )
    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'paths', paths: ['a.md'] },
    })
    expect(repository.deleteVectorsByIds).toHaveBeenCalledWith([5])
  })

  it('does not delete existing vectors when chunkify throws (transient I/O error)', async () => {
    // Regression: a failed cachedRead must NOT be interpreted as "file is empty
    // → delete its actual rows". Otherwise a transient error wipes the user's
    // index. The retry path will pick up these files on the next reconcile.
    const { manager, repository, app } = setupManager(
      [{ path: 'a.md', mtime: 200, content: 'updated' }],
      [
        {
          id: 1,
          path: 'a.md',
          mtime: 100,
          content_hash: 'h',
          metadata: { startLine: 1, endLine: 1 },
        },
      ],
    )
    ;(app.vault.cachedRead as jest.Mock).mockRejectedValueOnce(
      new Error('disk hiccup'),
    )
    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })
    expect(repository.deleteVectorsByIds).not.toHaveBeenCalled()
    expect(repository.insertVectors).not.toHaveBeenCalled()
  })
})
