const errorModalCtor = jest.fn()
jest.mock('../../../components/modals/ErrorModal', () => ({
  ErrorModal: class {
    constructor(...args: unknown[]) {
      errorModalCtor(...args)
    }
    open() {
      return this
    }
  },
}))

// Run the embed fn once with no real backoff delays. Faithful for these tests:
// success returns the value; failure rethrows immediately (the chunk-level
// retry policy itself is not what these reconcile-level tests exercise).
jest.mock('exponential-backoff', () => ({
  backOff: (fn: () => Promise<unknown>) => fn(),
}))

jest.mock('../../../utils/pdf/extractPdfText', () => ({
  PDF_INDEX_MAX_BYTES: 50_000_000,
  PDF_INDEX_MAX_PAGES: 1000,
  extractPdfText: jest.fn(),
}))

import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'

import { sha256HexPrefix16 } from '../../../utils/common/content-hash'

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
    deleteVectorsByPaths: jest.fn().mockResolvedValue(undefined),
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
    const result = await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })
    expect(result).toEqual({
      permanentFailedPaths: [],
      chunkifyFailedPaths: [],
    })
    expect(errorModalCtor).not.toHaveBeenCalled()
    expect(repository.insertVectors).toHaveBeenCalledTimes(1)
    expect(repository.deleteVectorsByIds).not.toHaveBeenCalled()
    expect(inserted.rows.length).toBeGreaterThan(0)
  })

  it('returns chunkifyFailedPaths (no throw, no modal) when a file fails to chunkify', async () => {
    const { manager, repository, app } = setupManager(
      [
        { path: 'good.md', mtime: 100, content: 'hello world' },
        { path: 'bad.md', mtime: 100, content: 'will throw' },
      ],
      [],
    )
    // Make reading bad.md throw a non-abort error so chunkify fails for it only.
    app.vault.cachedRead = jest.fn(async (file: { path: string }) => {
      if (file.path === 'bad.md') {
        throw new Error('I/O error')
      }
      return 'hello world'
    })

    const result = await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })

    expect(result).toEqual({
      permanentFailedPaths: [],
      chunkifyFailedPaths: ['bad.md'],
    })
    expect(errorModalCtor).not.toHaveBeenCalled()
    // bad.md is excluded from the diff → its (absent) rows are not deleted, and
    // good.md is still embedded.
    expect(repository.insertVectors).toHaveBeenCalled()
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

  it('skips 0-byte files so they do not flicker as "new" forever', async () => {
    // Regression: empty files would chunkify into 0 chunks and never write a
    // DB row, which made mtime-based partition flag them as new on every
    // sync — visible to the user as a stray file flashing through the
    // progress UI when they only changed unrelated settings.
    const fileObjects = [
      { path: 'empty.md', extension: 'md', stat: { mtime: 100, size: 0 } },
    ]
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue(fileObjects),
        cachedRead: jest.fn(),
      },
    }
    const manager = new VectorManager(app as never, {} as never)
    const repository = {
      getFileMtimes: jest.fn().mockResolvedValue(new Map()),
      listChunksForPaths: jest.fn().mockResolvedValue([]),
      deleteVectorsByIds: jest.fn().mockResolvedValue(undefined),
      bumpMtimeByIds: jest.fn().mockResolvedValue(undefined),
      insertVectors: jest.fn().mockResolvedValue(undefined),
      truncateModel: jest.fn().mockResolvedValue(undefined),
    }
    ;(manager as unknown as { repository: typeof repository }).repository =
      repository
    manager.setSaveCallback(async () => undefined)
    manager.setVacuumCallback(async () => undefined)

    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })

    expect(app.vault.cachedRead).not.toHaveBeenCalled()
    expect(repository.insertVectors).not.toHaveBeenCalled()
    expect(repository.deleteVectorsByIds).not.toHaveBeenCalled()
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

  it('rolls back a file with a transient embedding failure and throws RagIndexIncompleteError', async () => {
    const { manager, repository } = setupManager(
      [{ path: 'a.md', mtime: 100, content: 'hello world' }],
      [],
    )
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('service unavailable'), { status: 503 }),
        )

    await expect(
      manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } }),
    ).rejects.toMatchObject({ name: 'RagIndexIncompleteError' })

    expect(repository.deleteVectorsByPaths).toHaveBeenCalledWith('test-model', [
      'a.md',
    ])
    expect(repository.insertVectors).not.toHaveBeenCalled()
  })

  it('rolls back a file with mixed transient + permanent failures (no silent gap)', async () => {
    // A file that splits into multiple chunks: one chunk hits a transient
    // failure, another a permanent one. The whole file must be rolled back so
    // the transient gap is not frozen by the surviving permanent/success rows.
    const longContent = `${'A'.repeat(900)}\n\n${'B'.repeat(900)}\n\n${'C'.repeat(900)}`
    const { manager, repository } = setupManager(
      [{ path: 'a.md', mtime: 100, content: longContent }],
      [],
    )
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (content: string) => {
        if (content.includes('A')) {
          throw Object.assign(new Error('network error'), { status: 503 })
        }
        if (content.includes('B')) {
          throw Object.assign(new Error('bad request'), { status: 400 })
        }
        return [0.1, 0.2, 0.3]
      })

    await expect(
      manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } }),
    ).rejects.toMatchObject({ name: 'RagIndexIncompleteError' })

    expect(repository.deleteVectorsByPaths).toHaveBeenCalledWith('test-model', [
      'a.md',
    ])
  })

  it('keeps successful chunks and does not throw for permanent-only failures', async () => {
    const longContent = `${'A'.repeat(900)}\n\n${'B'.repeat(900)}`
    const { manager, repository, inserted } = setupManager(
      [{ path: 'a.md', mtime: 100, content: longContent }],
      [],
    )
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (content: string) => {
        if (content.includes('A')) {
          throw Object.assign(new Error('bad request'), { status: 400 })
        }
        return [0.1, 0.2, 0.3]
      })

    const result = await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })

    // Permanent-only failure → returned (not thrown, no modal) so the UI layer
    // can surface it by trigger.
    expect(result).toEqual({
      permanentFailedPaths: ['a.md'],
      chunkifyFailedPaths: [],
    })
    expect(errorModalCtor).not.toHaveBeenCalled()
    expect(repository.deleteVectorsByPaths).not.toHaveBeenCalled()
    // The successful (B) chunk is kept.
    expect(repository.insertVectors).toHaveBeenCalled()
    expect(inserted.rows.length).toBeGreaterThan(0)
  })

  it('throws a transient RagIndexIncompleteError (not a generic Error) on full outage', async () => {
    const { manager, repository } = setupManager(
      [{ path: 'a.md', mtime: 100, content: 'hello world' }],
      [],
    )
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }),
        )

    await expect(
      manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } }),
    ).rejects.toMatchObject({ name: 'RagIndexIncompleteError' })

    expect(repository.deleteVectorsByPaths).toHaveBeenCalledWith('test-model', [
      'a.md',
    ])
  })

  it('does not roll back or throw when a whole batch fails transiently on attempt 1 but succeeds on attempt 2', async () => {
    // Regression (source fix 1): the inner `while (attempt < 2)` retry must
    // discard attempt 1's failure records once attempt 2 succeeds. A single
    // chunk that throws a transient error on its first embed call and succeeds
    // on the second must end up inserted, with no rollback and no throw.
    const { manager, repository, inserted } = setupManager(
      [{ path: 'a.md', mtime: 100, content: 'hello world' }],
      [],
    )
    let calls = 0
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async () => {
        calls += 1
        if (calls === 1) {
          // Transient on the first attempt only.
          throw Object.assign(new Error('service unavailable'), { status: 503 })
        }
        return [0.1, 0.2, 0.3]
      })

    await expect(
      manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } }),
    ).resolves.toEqual({ permanentFailedPaths: [], chunkifyFailedPaths: [] })

    expect(repository.deleteVectorsByPaths).not.toHaveBeenCalled()
    expect(repository.insertVectors).toHaveBeenCalledTimes(1)
    expect(inserted.rows.length).toBe(1)
  })

  it('throws (no silent success) when an entire batch fails permanently and later batches are left unprocessed', async () => {
    // Regression (source fix 2): with embeddingConcurrency=1 each chunk is its
    // own batch. The first batch fails purely permanently (invalid API key),
    // so the loop breaks (wholeBatchFailed) and the second file's batch is
    // never attempted. The run MUST throw so it is recorded as failed, and the
    // partial "the rest is indexed" warning modal MUST be suppressed.
    const { manager, repository, inserted } = setupManager(
      [
        { path: 'a.md', mtime: 100, content: 'first file' },
        { path: 'b.md', mtime: 100, content: 'second file' },
      ],
      [],
    )
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('invalid api key'), { status: 400 }),
        )

    await expect(
      manager.reconcile(
        embeddingModel,
        { ...baseConfig, embeddingConcurrency: 1 },
        { scope: { kind: 'all' } },
      ),
    ).rejects.toThrow(/Embedding halted/)

    // Permanent-only failure → no rollback delete.
    expect(repository.deleteVectorsByPaths).not.toHaveBeenCalled()
    // Nothing was successfully embedded.
    expect(inserted.rows.length).toBe(0)
    // The data layer must never construct a modal — error surfacing is the UI
    // layer's job. For an incomplete (wholeBatchFailed) run the throw above is
    // the only signal; no partial "rest is indexed" report is emitted.
    expect(errorModalCtor).not.toHaveBeenCalled()
  })

  it('rolls back a permanent-failed file too when another file in the same run has a transient failure', async () => {
    // Cross-file regression (source fix 2): in one reconcile pass file A hits a
    // transient failure (→ rollback + RagIndexIncompleteError retry) while file
    // B has a PERMANENT failure on one chunk but other chunks succeed. Because
    // the run is incomplete and will retry, B's partially-successful rows must
    // be rolled back together with A's — otherwise B's surviving success rows
    // would stamp the current mtime and let B be silently skipped on the retry,
    // freezing the permanent gap. Assert deleteVectorsByPaths receives BOTH A
    // and B, and the thrown error's rolledBackPaths carries both.
    //
    // B's content splits into multiple chunks so its permanent failure can
    // coexist with at least one success (keeping validRows.length > 0 so the
    // batch is NOT treated as wholeBatchFailed).
    const bContent = `${'X'.repeat(900)}\n\n${'Y'.repeat(900)}`
    const { manager, repository } = setupManager(
      [
        { path: 'a.md', mtime: 100, content: 'transient file' },
        { path: 'b.md', mtime: 100, content: bContent },
      ],
      [],
    )
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (content: string) => {
        // File A's single chunk → transient (503).
        if (content.includes('transient file')) {
          throw Object.assign(new Error('service unavailable'), { status: 503 })
        }
        // File B's first chunk → permanent (400); B's other chunk(s) succeed.
        if (content.includes('X')) {
          throw Object.assign(new Error('bad request'), { status: 400 })
        }
        return [0.1, 0.2, 0.3]
      })

    let thrown: unknown
    await manager
      .reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } })
      .catch((error: unknown) => {
        thrown = error
      })

    // Incomplete run → throws RagIndexIncompleteError (transient retry).
    expect(thrown).toMatchObject({ name: 'RagIndexIncompleteError' })

    // BOTH the transient file (A) and the permanent-but-partially-successful
    // file (B) are rolled back — no silent gap left on B.
    expect(repository.deleteVectorsByPaths).toHaveBeenCalledTimes(1)
    const [model, paths] = repository.deleteVectorsByPaths.mock.calls[0] as [
      string,
      string[],
    ]
    expect(model).toBe('test-model')
    expect([...paths].sort()).toEqual(['a.md', 'b.md'])

    // The error's rolledBackPaths also carries both files.
    expect(
      [...(thrown as { rolledBackPaths: string[] }).rolledBackPaths].sort(),
    ).toEqual(['a.md', 'b.md'])
  })

  it('deletes ALL rows for a transiently-rolled-back file, including a reused (bumpMtime) row', async () => {
    // A file that splits into two chunks. Its first chunk matches an existing
    // DB row (same line range + content hash) at a STALE mtime → planReconcile
    // reuses it and bumps its mtime in step 7. The second chunk is new and hits
    // a transient embedding failure → the file is rolled back. The rollback
    // must call deleteVectorsByPaths so the reused/bumped row is removed too;
    // otherwise it would survive carrying the fresh mtime and freeze the gap.
    const content = `${'A'.repeat(900)}\n\n${'B'.repeat(900)}`
    const splitter = RecursiveCharacterTextSplitter.fromLanguage('markdown', {
      chunkSize: 1000,
    })
    const docs = await splitter.createDocuments([content])
    expect(docs.length).toBe(2)
    const firstDoc = docs[0]
    const firstHash = await sha256HexPrefix16(firstDoc.pageContent)

    // Seed the existing row to match the FIRST desired chunk's identity and
    // content hash, but with a stale mtime so it is reused via bumpMtime.
    const { manager, repository } = setupManager(
      [{ path: 'a.md', mtime: 200, content }],
      [
        {
          id: 42,
          path: 'a.md',
          mtime: 100,
          content_hash: firstHash,
          metadata: {
            startLine: firstDoc.metadata.loc.lines.from as number,
            endLine: firstDoc.metadata.loc.lines.to as number,
          },
        },
      ],
    )
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (chunkContent: string) => {
        if (chunkContent.includes('B')) {
          throw Object.assign(new Error('service unavailable'), { status: 503 })
        }
        return [0.1, 0.2, 0.3]
      })

    await expect(
      manager.reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } }),
    ).rejects.toMatchObject({ name: 'RagIndexIncompleteError' })

    // Reuse path was exercised (the matching row's mtime was bumped)...
    expect(repository.bumpMtimeByIds).toHaveBeenCalledWith([
      { id: 42, mtime: 200 },
    ])
    // ...and the whole-path delete swept it up on rollback.
    expect(repository.deleteVectorsByPaths).toHaveBeenCalledWith('test-model', [
      'a.md',
    ])
  })
})
