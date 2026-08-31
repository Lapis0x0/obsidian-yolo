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

// Installs IDBKeyRange (used by the real store's compound-key ranges) as a
// global, for the "real store" describe block below (Codex finding 1.2/3.1
// coverage: rollback must be verified against a real repository, not only a
// mocked one — see `09-c3-codex-fixes.md` section B).
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'

import { sha256HexPrefix16 } from '../../../utils/common/content-hash'
import { IndexedDbVectorStore } from '../../vector-store/IndexedDbVectorStore'
import {
  openVectorDatabase,
  vectorDatabaseName,
} from '../../vector-store/vectorDatabase'

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
  // `IndexedDbVectorStore.getFileMtimes` returns a plain Record, not a Map —
  // match that shape here so this mock stays a faithful stand-in.
  const mtimeRecord = Object.fromEntries(
    existingRows.map((r) => [r.path, r.mtime]),
  )
  const repository = {
    getFileMtimes: jest.fn().mockResolvedValue(mtimeRecord),
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
  return { manager, repository, app, inserted }
}

const embeddingModel = {
  id: 'test-model',
  dimension: 3,
  getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
} as never

const baseConfig = {
  chunkSize: 1000,
  include: [],
  exclude: [],
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
      { ...baseConfig, exclude: ['docs'] },
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
      getFileMtimes: jest.fn().mockResolvedValue({}),
      listChunksForPaths: jest.fn().mockResolvedValue([]),
      deleteVectorsByIds: jest.fn().mockResolvedValue(undefined),
      bumpMtimeByIds: jest.fn().mockResolvedValue(undefined),
      insertVectors: jest.fn().mockResolvedValue(undefined),
      truncateModel: jest.fn().mockResolvedValue(undefined),
    }
    ;(manager as unknown as { repository: typeof repository }).repository =
      repository

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

  // ---- Streaming reconcile: bounded file-batch behavior ----
  //
  // These files cut into two file batches: the first FILE_BATCH_MAX_FILES
  // (64) files land in batch 1, the remaining 6 in batch 2. Content is a
  // short unique string per file so each chunkifies to exactly one chunk,
  // keeping the FILE_BATCH_MAX_CHUNKS (256) threshold irrelevant here.
  const manyFiles = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      path: `f${i}.md`,
      mtime: 100,
      content: `content ${i}`,
    }))

  it('lists chunks per file batch, not once for the whole run', async () => {
    const files = manyFiles(70)
    const { manager, repository } = setupManager(files, [])

    await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
    })

    expect(repository.listChunksForPaths).toHaveBeenCalledTimes(2)
    const [, batch1Paths] = repository.listChunksForPaths.mock.calls[0] as [
      string,
      string[],
    ]
    const [, batch2Paths] = repository.listChunksForPaths.mock.calls[1] as [
      string,
      string[],
    ]
    expect(batch1Paths).toEqual(files.slice(0, 64).map((f) => f.path))
    expect(batch2Paths).toEqual(files.slice(64).map((f) => f.path))
  })

  it('rolls back a permanent-only file from batch 1 when batch 2 hits a transient failure', async () => {
    const files = manyFiles(70)
    const { manager, repository } = setupManager(files, [])
    // f10 (batch 1) fails permanently; f66 (batch 2) fails transiently; all
    // other files embed successfully.
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest.fn(async (content: string) => {
        if (content === 'content 10') {
          throw Object.assign(new Error('bad request'), { status: 400 })
        }
        if (content === 'content 66') {
          throw Object.assign(new Error('service unavailable'), {
            status: 503,
          })
        }
        return [0.1, 0.2, 0.3]
      })

    let thrown: unknown
    await manager
      .reconcile(embeddingModel, baseConfig, { scope: { kind: 'all' } })
      .catch((error: unknown) => {
        thrown = error
      })

    expect(thrown).toMatchObject({ name: 'RagIndexIncompleteError' })
    expect(repository.deleteVectorsByPaths).toHaveBeenCalledTimes(1)
    const [model, paths] = repository.deleteVectorsByPaths.mock.calls[0] as [
      string,
      string[],
    ]
    expect(model).toBe('test-model')
    // Both the batch-1 permanent-only file and the batch-2 transient file are
    // rolled back together, even though they were embedded in different
    // file-batch calls.
    expect([...paths].sort()).toEqual(['f10.md', 'f66.md'])
  })

  it('leaves the second file batch un-chunkified and un-embedded when batch 1 wholly fails', async () => {
    const files = manyFiles(70)
    const { manager, repository, app } = setupManager(files, [])
    ;(embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding =
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('service unavailable'), { status: 503 }),
        )

    await expect(
      manager.reconcile(
        embeddingModel,
        { ...baseConfig, embeddingConcurrency: 1 },
        { scope: { kind: 'all' } },
      ),
    ).rejects.toMatchObject({ name: 'RagIndexIncompleteError' })

    // Only batch 1's 64 files were ever read; batch 2 (f64..f69) was never
    // chunkified because the run stopped after batch 1's whole-batch failure.
    expect(app.vault.cachedRead).toHaveBeenCalledTimes(64)
    const readPaths = (app.vault.cachedRead as jest.Mock).mock.calls.map(
      (call) => (call[0] as { path: string }).path,
    )
    expect(readPaths).not.toContain('f64.md')
    // With embeddingConcurrency=1 the first chunk (f0) is its own sub-batch;
    // it is attempted twice (the outer attempt<2 retry) before the call is
    // treated as a whole-batch failure and embedding stops — no other chunk
    // in batch 1 (f1..f63) or batch 2 is ever attempted.
    expect(
      (embeddingModel as unknown as { getEmbedding: jest.Mock }).getEmbedding,
    ).toHaveBeenCalledTimes(2)
    expect(repository.insertVectors).not.toHaveBeenCalled()
  })

  it('reports completedFiles monotonically via onProgress, ending at totalFiles', async () => {
    const files = manyFiles(70)
    const { manager } = setupManager(files, [])
    const completedFilesSeen: number[] = []
    const totalFilesSeen: number[] = []

    const result = await manager.reconcile(embeddingModel, baseConfig, {
      scope: { kind: 'all' },
      onProgress: (progress) => {
        completedFilesSeen.push(progress.completedFiles ?? 0)
        totalFilesSeen.push(progress.totalFiles)
      },
    })

    expect(result).toEqual({
      permanentFailedPaths: [],
      chunkifyFailedPaths: [],
    })
    expect(completedFilesSeen.length).toBeGreaterThan(0)
    for (let i = 1; i < completedFilesSeen.length; i++) {
      expect(completedFilesSeen[i]).toBeGreaterThanOrEqual(
        completedFilesSeen[i - 1],
      )
    }
    expect(completedFilesSeen[completedFilesSeen.length - 1]).toBe(
      totalFilesSeen[totalFilesSeen.length - 1],
    )
    expect(completedFilesSeen[completedFilesSeen.length - 1]).toBe(70)
  })
})

// ---- Real-store coverage for the C3 Codex fixes (sections B and C of
// 09-c3-codex-fixes.md) — a mocked repository can't prove "no row survives"
// or "no duplicate row", so these exercise the real IndexedDB-backed store.
async function openRealStore(
  namespaceId: string,
): Promise<IndexedDbVectorStore> {
  const indexedDB = new IDBFactory()
  const db = await openVectorDatabase(
    indexedDB,
    vectorDatabaseName(namespaceId, 'test-kb'),
  )
  return new IndexedDbVectorStore(db)
}

describe('VectorManager.reconcile — file-batch rollback against a real store (Codex 1.2 / 3.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('leaves no row behind for a file whose second sub-batch is interrupted by abort', async () => {
    // File "a.md" splits into two chunks (A-run, B-run). embeddingConcurrency
    // 1 forces each chunk into its own adaptive sub-batch, so the first
    // chunk's row is actually committed via insertVectors before the second
    // chunk's abort is observed — exactly the "half a file written" scenario
    // finding 1.2 describes.
    const store = await openRealStore('rollback-abort')
    try {
      const controller = new AbortController()
      const content = `${'A'.repeat(900)}\n\n${'B'.repeat(900)}`
      const app = {
        vault: {
          getFiles: jest.fn().mockReturnValue([
            {
              path: 'a.md',
              extension: 'md',
              stat: { mtime: 100, size: content.length },
            },
          ]),
          cachedRead: jest.fn().mockResolvedValue(content),
        },
      }
      const manager = new VectorManager(app as never, store)
      const model = {
        id: 'rollback-model',
        dimension: 3,
        getEmbedding: jest.fn(async (text: string) => {
          if (text.includes('B')) {
            // Simulates the abort landing while the second sub-batch's
            // request is in flight, after the first sub-batch already
            // committed its row.
            controller.abort()
          }
          return [0.1, 0.2, 0.3]
        }),
      }

      await expect(
        manager.reconcile(
          model as never,
          { ...baseConfig, embeddingConcurrency: 1 },
          { scope: { kind: 'all' }, signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' })

      expect(
        await store.listChunksForPaths('rollback-model', ['a.md']),
      ).toEqual([])
    } finally {
      store.close()
    }
  })

  it('leaves no row behind for a file when insertVectors throws on a later sub-batch', async () => {
    const store = await openRealStore('rollback-insert-error')
    try {
      const content = `${'A'.repeat(900)}\n\n${'B'.repeat(900)}`
      const app = {
        vault: {
          getFiles: jest.fn().mockReturnValue([
            {
              path: 'a.md',
              extension: 'md',
              stat: { mtime: 100, size: content.length },
            },
          ]),
          cachedRead: jest.fn().mockResolvedValue(content),
        },
      }
      const manager = new VectorManager(app as never, store)
      const model = {
        id: 'rollback-model-2',
        dimension: 3,
        getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      }

      const originalInsert = store.insertVectors.bind(store)
      let insertCalls = 0
      jest.spyOn(store, 'insertVectors').mockImplementation(async (rows) => {
        insertCalls += 1
        if (insertCalls === 2) {
          throw new Error('quota exceeded')
        }
        return originalInsert(rows)
      })

      await expect(
        manager.reconcile(
          model as never,
          { ...baseConfig, embeddingConcurrency: 1 },
          { scope: { kind: 'all' } },
        ),
      ).rejects.toThrow(/quota exceeded/)

      expect(
        await store.listChunksForPaths('rollback-model-2', ['a.md']),
      ).toEqual([])
    } finally {
      store.close()
    }
  })

  it('does not roll back an earlier, already-completed file batch when a later batch aborts', async () => {
    // 70 single-chunk files split into two file batches (64 + 6, per
    // FILE_BATCH_MAX_FILES). Batch 1 fully commits; batch 2 aborts partway
    // through. Only batch 2's files should be rolled back.
    const store = await openRealStore('rollback-batch-scope')
    try {
      const controller = new AbortController()
      const files = Array.from({ length: 70 }, (_, i) => ({
        path: `f${i}.md`,
        content: `content ${i}`,
      }))
      const fileContent = new Map(files.map((f) => [f.path, f.content]))
      const app = {
        vault: {
          getFiles: jest.fn().mockReturnValue(
            files.map((f) => ({
              path: f.path,
              extension: 'md',
              stat: { mtime: 100, size: f.content.length },
            })),
          ),
          cachedRead: jest.fn(
            async (file: { path: string }) => fileContent.get(file.path) ?? '',
          ),
        },
      }
      const manager = new VectorManager(app as never, store)
      const model = {
        id: 'rollback-batch-scope-model',
        dimension: 3,
        getEmbedding: jest.fn(async (text: string) => {
          // f65 is the second file of batch 2 (f64..f69); abort mid-batch-2,
          // after f64 already committed.
          if (text === 'content 65') {
            controller.abort()
          }
          return [0.1, 0.2, 0.3]
        }),
      }

      await expect(
        manager.reconcile(
          model as never,
          { ...baseConfig, embeddingConcurrency: 1 },
          { scope: { kind: 'all' }, signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' })

      // Batch 1 (f0..f63) is untouched by batch 2's rollback.
      const batch1Paths = files.slice(0, 64).map((f) => f.path)
      const batch1Rows = await store.listChunksForPaths(
        'rollback-batch-scope-model',
        batch1Paths,
      )
      expect(batch1Rows).toHaveLength(64)

      // Batch 2 (f64..f69) was rolled back wholesale, including f64 which had
      // already committed before the abort was observed.
      const batch2Paths = files.slice(64).map((f) => f.path)
      const batch2Rows = await store.listChunksForPaths(
        'rollback-batch-scope-model',
        batch2Paths,
      )
      expect(batch2Rows).toEqual([])
    } finally {
      store.close()
    }
  })
})

describe('VectorManager write serialization across models (Codex 1.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('makes a second reconcile for the same model wait for the first, avoiding a duplicate row', async () => {
    const store = await openRealStore('serialize-test')
    try {
      const app = {
        vault: {
          getFiles: jest
            .fn()
            .mockReturnValue([
              { path: 'a.md', extension: 'md', stat: { mtime: 100, size: 11 } },
            ]),
          cachedRead: jest.fn().mockResolvedValue('hello world'),
        },
      }
      const manager = new VectorManager(app as never, store)

      let releaseGate: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      let firstStarted: () => void = () => undefined
      const firstStartedPromise = new Promise<void>((resolve) => {
        firstStarted = resolve
      })
      const order: string[] = []
      let embedCalls = 0
      const model = {
        id: 'serialize-model',
        dimension: 3,
        getEmbedding: jest.fn(async () => {
          embedCalls += 1
          if (embedCalls === 1) {
            order.push('first-start')
            firstStarted()
            await gate
            order.push('first-end')
          } else {
            order.push(`embed-${embedCalls}`)
          }
          return [0.1, 0.2, 0.3]
        }),
      }

      const firstRun = manager.reconcile(model as never, baseConfig, {
        scope: { kind: 'all' },
      })
      // Queued synchronously behind `firstRun` by `enqueueForModel` — this
      // call cannot start its own work until `firstRun`'s promise settles,
      // regardless of when the gate below is released.
      const secondRun = manager.reconcile(model as never, baseConfig, {
        scope: { kind: 'all' },
      })

      await firstStartedPromise
      // At this point only the first reconcile has done any work; the
      // second is still fully blocked on the first's chain.
      expect(order).toEqual(['first-start'])

      releaseGate()
      await firstRun
      await secondRun

      // The second reconcile only ran after the first committed, so it saw
      // the file as already indexed (matching mtime) and never re-embedded
      // it — no duplicate row, and only one embedding call total.
      expect(order).toEqual(['first-start', 'first-end'])
      expect(embedCalls).toBe(1)
      const rows = await store.listChunksForPaths('serialize-model', ['a.md'])
      expect(rows).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})
