import { backOff } from 'exponential-backoff'
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'
import { App, TFile } from 'obsidian'

import { IndexProgress } from '../../../components/chat-view/QueryProgress'
import { isWithinYoloBaseDir } from '../../../core/paths/yoloPaths'
import {
  RagIndexFailureKind,
  RagIndexIncompleteError,
  classifyRagIndexError,
  isTransientRagIndexError,
} from '../../../core/rag/ragIndexErrors'
import {
  type DesiredChunk,
  type ReconcileScope,
  planReconcile,
} from '../../../core/rag/reconciler'
import type {
  VectorInsert,
  VectorMetaData,
  VectorSelect,
  VectorStore,
} from '../../../core/runtime-components'
import {
  EmbeddingDbStats,
  EmbeddingModelClient,
} from '../../../types/embedding'
import { sha256HexPrefix16 } from '../../../utils/common/content-hash'
import {
  createYieldController,
  yieldToMain,
} from '../../../utils/common/yield-to-main'
import {
  PDF_INDEX_MAX_BYTES,
  PDF_INDEX_MAX_PAGES,
  extractPdfText,
} from '../../../utils/pdf/extractPdfText'
import { matchesIncludeExcludeScope } from '../../../utils/scope-match'

const PDF_PAGE_CHUNK_CHAR_THRESHOLD = 1500

// Bounded file-batch sizing for streaming reconcile: a batch of files is
// chunkified, diffed, and embedded together, then the next batch starts.
// This caps the number of DesiredChunk objects (full chunk text + metadata)
// resident in memory at once to one batch instead of the whole vault.
const FILE_BATCH_MAX_CHUNKS = 256
const FILE_BATCH_MAX_FILES = 64
// Removed paths are deleted ahead of the file-batch loop, in batches of this
// many paths per listChunksForPaths/planReconcile/deleteVectorsByIds round.
const REMOVED_PATHS_BATCH_SIZE = 256

/** Opaque handle for the YOLO-root-aware PDF text cache. */
type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

export type ReconcileConfig = {
  chunkSize: number
  /**
   * Normalized vault-relative paths (folder or file, no glob syntax) — the
   * knowledge base's `include`/`exclude` rules, matched with the same
   * semantics as `components/settings/scope/scopeRules.ts`: any exclude hit
   * wins; an empty `include` means everything; otherwise the path must hit
   * an include rule. See `matchesIncludeExcludeScope`.
   */
  include: string[]
  exclude: string[]
  /** When false, PDFs are excluded from the desired set (and existing PDF rows are removed). */
  indexPdf: boolean
  /**
   * Max parallel embedding requests. Clamped to [1, 24]. Default 10. Lower
   * this when the embedding provider returns 429 (e.g. Azure S0 tier).
   */
  embeddingConcurrency?: number
  /** Optional YOLO-root-aware settings handle; enables the PDF text cache. */
  settings?: YoloSettingsLike | null
}

export type ReconcileOptions = {
  scope: ReconcileScope
  /** When true, wipe the model namespace before reconciling (rebuild semantics). */
  truncate?: boolean
  signal?: AbortSignal
  onProgress?: (progress: IndexProgress) => void
}

/**
 * Structured outcome of a reconcile pass. Hard failures still throw; this only
 * carries the soft (non-throwing) per-file failures so the UI layer can decide
 * how to surface them by trigger.
 *
 * - `permanentFailedPaths`: files whose embedding failed permanently (e.g. 400
 *   bad request). Their successful chunks are kept; they are NOT retried
 *   automatically → need user intervention.
 * - `chunkifyFailedPaths`: files that failed to chunkify (e.g. transient I/O).
 *   Excluded from the diff, old index preserved, mtime not advanced → self-heals
 *   on the next reconcile.
 */
export type ReconcileResult = {
  permanentFailedPaths: string[]
  chunkifyFailedPaths: string[]
}

export class VectorManager {
  private app: App
  private repository: VectorStore
  private acceptingOperations = true
  private activeOperations = 0
  private readonly idleWaiters = new Set<() => void>()
  // Per-model write serialization: every write entry point (`reconcile`,
  // `clearAllVectors`, `clearVectorsByModelIds`) chains onto this instead of
  // running concurrently against the same model namespace. Without this, the
  // management modal's manual rebuild/remove could overlap an automatic or
  // queued `RAGEngine` run against the same model and interleave writes
  // (duplicate rows, or one run deleting rows the other just inserted) — see
  // Codex finding 1.3. `RAGEngine`'s own `indexUpdateQueue` still exists
  // separately (it also carries UI progress-serialization semantics); this
  // map is the lower-level guarantee that holds even when a caller bypasses
  // that queue entirely.
  private readonly modelOpChains = new Map<string, Promise<unknown>>()

  constructor(app: App, repository: VectorStore) {
    this.app = app
    this.repository = repository
  }

  /** Chains `fn` after any write already in flight for `modelId`, so same-model writes never overlap. */
  private enqueueForModel<T>(
    modelId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.modelOpChains.get(modelId) ?? Promise.resolve()
    const chained = previous.catch(() => undefined).then(fn)
    // Store a rejection-swallowing tail for future chaining only; the
    // rejection itself still propagates to this call's own caller via the
    // returned `chained` promise.
    this.modelOpChains.set(
      modelId,
      chained.catch(() => undefined),
    )
    return chained
  }

  /** Like `enqueueForModel`, but `fn` is gated on every model id's chain and installs itself as the new chain for all of them. */
  private enqueueForModels<T>(
    modelIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const previousChains = modelIds.map(
      (id) => this.modelOpChains.get(id) ?? Promise.resolve(),
    )
    const chained = Promise.all(
      previousChains.map((p) => p.catch(() => undefined)),
    ).then(fn)
    const tail = chained.catch(() => undefined)
    for (const id of modelIds) {
      this.modelOpChains.set(id, tail)
    }
    return chained
  }

  async performSimilaritySearch(
    queryVector: number[],
    embeddingModel: EmbeddingModelClient,
    options: {
      minSimilarity: number
      limit: number
      scope?: {
        files: string[]
        folders: string[]
        exclude?: string[]
      }
    },
  ): Promise<
    (VectorSelect & {
      similarity: number
    })[]
  > {
    const release = this.enterOperation()
    try {
      return await this.repository.performSimilaritySearch(
        queryVector,
        embeddingModel,
        options,
      )
    } finally {
      release()
    }
  }

  /**
   * Background similarity level for this knowledge base — what "unrelated"
   * scores here, so a raw cosine can be read as a strength. See
   * {@link VectorStore.getSimilarityBaseline}.
   */
  async getSimilarityBaseline(
    embeddingModel: EmbeddingModelClient,
  ): Promise<{ mean: number; std: number } | null> {
    const release = this.enterOperation()
    try {
      return await this.repository.getSimilarityBaseline(embeddingModel)
    } finally {
      release()
    }
  }

  /**
   * Every stored chunk vector for one file — the source side of
   * "find notes similar to this one", which pools them instead of embedding
   * the note again. See {@link VectorStore.listVectorsForPath}.
   */
  async listVectorsForPath(
    modelId: string,
    path: string,
  ): Promise<Float32Array[]> {
    const release = this.enterOperation()
    try {
      return await this.repository.listVectorsForPath(modelId, path)
    } finally {
      release()
    }
  }

  /**
   * Reconcile the index for one model namespace against the current vault and
   * configuration. Single entry point for all index writes:
   *
   * - "rebuild": pass `truncate: true, scope: { kind: 'all' }`
   * - "sync after settings change": `truncate: false, scope: { kind: 'all' }`
   * - "sync after file events": `truncate: false, scope: { kind: 'paths', paths: [...] }`
   *
   * Idempotent: re-running the same call after a crash will only re-embed
   * chunks that didn't make it to the DB before. Serialized per model via
   * `enqueueForModel` (see its doc) — a second `reconcile`/`clearAllVectors`/
   * `clearVectorsByModelIds` call for the same model waits for this one to
   * finish rather than running concurrently against it.
   */
  async reconcile(
    embeddingModel: EmbeddingModelClient,
    config: ReconcileConfig,
    options: ReconcileOptions,
  ): Promise<ReconcileResult> {
    const releaseOperation = this.enterOperation()
    try {
      return await this.enqueueForModel(embeddingModel.id, () =>
        this.reconcileInternal(embeddingModel, config, options),
      )
    } finally {
      releaseOperation()
    }
  }

  /**
   * Steps shared by `reconcile`'s planning phase and the cheap dry-run
   * `countPendingChanges`: the candidate file universe for `scope`, an
   * mtime-based partition into "needs chunkifying" vs. "stable", and the
   * paths that dropped out of scope entirely. Read-only — no chunkify, no
   * embed, no write.
   */
  private computeCandidateDiff(
    config: ReconcileConfig,
    scope: ReconcileScope,
    storedMtimes: Readonly<Record<string, number>> | null,
  ): {
    candidateFiles: TFile[]
    filesToChunkify: TFile[]
    newFilesCount: number
    updatedFilesCount: number
    removedPaths: string[]
  } {
    // 1. Determine the candidate file universe for this reconcile pass.
    const allCandidates = this.listIndexableFiles(config)
    const candidateFiles =
      scope.kind === 'all'
        ? allCandidates
        : (() => {
            const inScope = new Set(scope.paths)
            return allCandidates.filter((f) => inScope.has(f.path))
          })()
    const candidateSet = new Set(candidateFiles.map((f) => f.path))

    // 2. mtime map (used to skip unchanged files and to find removed paths).
    const mtimeMap =
      storedMtimes === null
        ? new Map<string, number>()
        : new Map(Object.entries(storedMtimes))

    // 3. Partition candidates by mtime.
    //
    // Skip 0-byte files: they would chunkify into 0 chunks → no DB row →
    // mtime-based partition would flag them as "new" forever, wasting a
    // chunkify pass on every sync. Daily-note plugins commonly create empty
    // placeholder notes; without this guard they'd flicker through the
    // progress UI on every config change.
    const filesToChunkify: TFile[] = []
    let newFilesCount = 0
    let updatedFilesCount = 0
    for (const file of candidateFiles) {
      if (file.stat.size === 0) continue
      const existingMtime = mtimeMap.get(file.path)
      if (existingMtime === undefined) {
        filesToChunkify.push(file)
        newFilesCount += 1
      } else if (file.stat.mtime !== existingMtime) {
        filesToChunkify.push(file)
        updatedFilesCount += 1
      }
      // else: stable, leave actual rows alone.
    }

    // 4. Removed paths: in actual but no longer a candidate (and within
    // scope). When `storedMtimes` is null (truncate, or no prior index) the
    // mtime map is empty, so this naturally comes out empty too.
    const removedPaths: string[] = []
    const inScope = (path: string): boolean =>
      scope.kind === 'all' ? true : scope.paths.includes(path)
    for (const path of mtimeMap.keys()) {
      if (!candidateSet.has(path) && inScope(path)) {
        removedPaths.push(path)
      }
    }

    return {
      candidateFiles,
      filesToChunkify,
      newFilesCount,
      updatedFilesCount,
      removedPaths,
    }
  }

  /**
   * Cheap dry-run count of what a `sync` reconcile would touch for one
   * knowledge base — the same mtime-based candidate/removed diff `reconcile`
   * uses to decide which files to chunkify, but stops there: no chunkify, no
   * embed, no write. Backs the settings UI's "N 个待更新" pill and per-card
   * "N 个文件已修改" line, which recompute this on Tab mount, after each
   * index run, and on a throttled vault-event timer.
   */
  async countPendingChanges(
    embeddingModelId: string,
    config: ReconcileConfig,
  ): Promise<{ changed: number; total: number }> {
    const release = this.enterOperation()
    try {
      const storedMtimes = await this.repository.getFileMtimes(embeddingModelId)
      const { candidateFiles, filesToChunkify, removedPaths } =
        this.computeCandidateDiff(config, { kind: 'all' }, storedMtimes)
      return {
        changed: filesToChunkify.length + removedPaths.length,
        total: candidateFiles.length,
      }
    } finally {
      release()
    }
  }

  private async reconcileInternal(
    embeddingModel: EmbeddingModelClient,
    config: ReconcileConfig,
    options: ReconcileOptions,
  ): Promise<ReconcileResult> {
    const { signal, scope, truncate, onProgress } = options

    if (truncate) {
      await this.repository.truncateModel(embeddingModel.id)
    }

    const storedMtimes = truncate
      ? null
      : await this.repository.getFileMtimes(embeddingModel.id)
    const { filesToChunkify, newFilesCount, updatedFilesCount, removedPaths } =
      this.computeCandidateDiff(config, scope, storedMtimes)
    const removedFilesCount = removedPaths.length

    if (filesToChunkify.length === 0 && removedPaths.length === 0) {
      // Nothing to do (truncateModel above already persisted, if any).
      return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
    }

    // 5. Removed paths are deleted first, in bounded batches so a large
    // removal set never forces one unbounded listChunksForPaths call.
    // planReconcile([], actual) with an empty desired set deletes every
    // actual row for these paths -- same semantics as a combined diff.
    for (let i = 0; i < removedPaths.length; i += REMOVED_PATHS_BATCH_SIZE) {
      if (signal?.aborted) {
        throw new DOMException('Indexing cancelled by user', 'AbortError')
      }
      const batchPaths = removedPaths.slice(i, i + REMOVED_PATHS_BATCH_SIZE)
      const actualRows = await this.repository.listChunksForPaths(
        embeddingModel.id,
        batchPaths,
      )
      const actual = actualRows.map((row) => ({
        id: row.id,
        path: row.path,
        contentHash: row.content_hash,
        metadata: row.metadata,
        mtime: row.mtime,
      }))
      const plan = planReconcile([], actual)
      if (plan.toDeleteIds.length > 0) {
        await this.repository.deleteVectorsByIds(plan.toDeleteIds)
      }
    }

    const textSplitter = RecursiveCharacterTextSplitter.fromLanguage(
      'markdown',
      { chunkSize: config.chunkSize },
    )

    // Chunkify failures are soft (self-healing): the file is excluded from
    // that batch's diff (its old index is preserved and mtime not
    // advanced), so the next reconcile retries it. We log details for
    // diagnostics and report the paths up to the caller, but never throw or
    // pop a modal here.
    const failedFiles: { path: string; error: string }[] = []
    let completedFilesCount = 0
    // Files of the batch currently being embedded that are already settled:
    // those needing no embedding, plus those the embedder has finished
    // (approximated by chunk order — see `completedFilesInCall`). Folded into
    // `completedFiles` so the percentage advances within a file batch instead
    // of jumping once per 64 files.
    let inBatchCompletedFiles = 0
    let totalChunksDiscovered = 0
    const folderProgress: Record<
      string,
      {
        completedFiles: number
        totalFiles: number
        completedChunks: number
        totalChunks: number
      }
    > = {}

    const folderOf = (path: string) =>
      path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : ''
    const ancestorsOf = (folder: string): string[] => {
      if (!folder) return []
      const parts = folder.split('/')
      const out: string[] = []
      for (let i = parts.length; i >= 1; i--) {
        out.push(parts.slice(0, i).join('/'))
      }
      return out
    }

    for (const file of filesToChunkify) {
      const folder = folderOf(file.path)
      if (!folderProgress[folder]) {
        folderProgress[folder] = {
          completedFiles: 0,
          totalFiles: 0,
          completedChunks: 0,
          totalChunks: 0,
        }
      }
      folderProgress[folder].totalFiles += 1
      for (const anc of ancestorsOf(folder).slice(1)) {
        if (!folderProgress[anc]) {
          folderProgress[anc] = {
            completedFiles: 0,
            totalFiles: 0,
            completedChunks: 0,
            totalChunks: 0,
          }
        }
      }
    }

    // Merge the run-level counters into a full IndexProgress snapshot. Used
    // both while chunkifying (currentFile advances per file) and while
    // embedding (currentFile/waitingForRateLimit come from the embedder).
    const reportProgress = (snapshot: {
      completedChunks: number
      totalChunks: number
      currentFile?: string
      currentFolder?: string
      waitingForRateLimit?: boolean
    }) =>
      onProgress?.({
        ...snapshot,
        totalFiles: filesToChunkify.length,
        completedFiles: completedFilesCount + inBatchCompletedFiles,
        folderProgress,
        newFilesCount,
        updatedFilesCount,
        removedFilesCount,
      })

    // 6. Chunkify, diff, and embed in bounded file batches. The embedder is
    // created once so its adaptive batch size, cumulative completedChunks,
    // and classified failedChunks persist across every file batch -- the
    // failure aggregation (rollback / throw) happens once, at the very end
    // of this method, over the failures accumulated across all batches.
    // Files in the current batch with nothing to embed (unchanged or
    // chunkify-failed); set before each `embedder.embed` call.
    let batchSettledFiles = 0
    const embedder = this.createChunkEmbedder(embeddingModel, {
      signal,
      maxConcurrency: config.embeddingConcurrency,
      onProgress: ({ completedFilesInCall, ...snapshot }) => {
        inBatchCompletedFiles = batchSettledFiles + completedFilesInCall
        reportProgress({ ...snapshot, totalChunks: totalChunksDiscovered })
      },
    })

    const maybeYield = createYieldController(10)
    let wholeBatchFailed = false
    let fileIdx = 0
    while (fileIdx < filesToChunkify.length) {
      const batchDesired: DesiredChunk[] = []
      const batchAttemptedPaths: string[] = []
      const batchFailedPaths = new Set<string>()

      while (
        fileIdx < filesToChunkify.length &&
        batchAttemptedPaths.length < FILE_BATCH_MAX_FILES &&
        batchDesired.length < FILE_BATCH_MAX_CHUNKS
      ) {
        const file = filesToChunkify[fileIdx]
        fileIdx += 1
        if (signal?.aborted) {
          throw new DOMException('Indexing cancelled by user', 'AbortError')
        }
        await maybeYield()

        const folder = folderOf(file.path)
        reportProgress({
          completedChunks: embedder.completedChunks,
          totalChunks: totalChunksDiscovered,
          currentFile: file.path,
          currentFolder: folder,
        })

        batchAttemptedPaths.push(file.path)
        try {
          const fileChunks = await this.chunkifyFile(
            file,
            textSplitter,
            config.chunkSize,
            signal,
            config.settings ?? null,
          )
          batchDesired.push(...fileChunks)
          totalChunksDiscovered += fileChunks.length
          folderProgress[folder].completedFiles += 1
          folderProgress[folder].totalChunks += fileChunks.length
          for (const anc of ancestorsOf(folder).slice(1)) {
            folderProgress[anc].totalChunks += fileChunks.length
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw error
          }
          batchFailedPaths.add(file.path)
          failedFiles.push({
            path: file.path,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }

      // Critical: exclude failed-to-chunkify paths from this batch's diff.
      // Their `desired` is empty (chunking threw) but their existing rows
      // must NOT be treated as "no longer desired" -- that would silently
      // delete a user's index after a transient I/O error. Skip them; the
      // next reconcile retries.
      const safeBatchPaths = batchAttemptedPaths.filter(
        (p) => !batchFailedPaths.has(p),
      )

      // The apply (delete/bump) + embed segment below is the only part of
      // this file batch that writes to the repository. Any THROWN error
      // here — user abort, or a repository write failure (e.g. IDB quota)
      // — means some of this batch's files may have been bumped to the
      // current mtime or partially embedded without the rest of their
      // chunks landing (a file's chunks can span multiple adaptive
      // sub-batches inside `embedder.embed`). Left alone, that partial
      // write would carry the current mtime and be silently skipped as
      // "unchanged" on the next reconcile, freezing the gap forever (see
      // Codex findings 1.2 / 3.1). So: on any throw here, roll back every
      // row for every file this batch touched (`batchAttemptedPaths`,
      // including chunkify-failed paths — deleting their absent rows is a
      // no-op) and rethrow. Rollback granularity is one file batch (at
      // most `FILE_BATCH_MAX_FILES`); deleting is safe and idempotent
      // because the next reconcile just treats these paths as new files
      // again. This does NOT cover `wholeBatchFailed` (a soft, non-throwing
      // signal handled by the existing failure aggregation after this
      // loop) or `RagIndexIncompleteError`/`AbortError` re-thrown from a
      // PREVIOUS iteration's aggregation — those never reach this catch.
      try {
        const actualRows = truncate
          ? []
          : await this.repository.listChunksForPaths(
              embeddingModel.id,
              safeBatchPaths,
            )
        const actual = actualRows.map((row) => ({
          id: row.id,
          path: row.path,
          contentHash: row.content_hash,
          metadata: row.metadata,
          mtime: row.mtime,
        }))
        const plan = planReconcile(batchDesired, actual)

        // Apply deletions and mtime bumps before embedding so that on-disk
        // state converges monotonically toward `desired`.
        if (plan.toDeleteIds.length > 0) {
          await this.repository.deleteVectorsByIds(plan.toDeleteIds)
        }
        if (plan.toBumpMtime.length > 0) {
          await this.repository.bumpMtimeByIds(plan.toBumpMtime)
        }

        batchSettledFiles =
          batchAttemptedPaths.length -
          new Set(plan.toEmbed.map((chunk) => chunk.path)).size
        inBatchCompletedFiles = batchSettledFiles
        const { wholeBatchFailed: batchWholeFailed } = await embedder.embed(
          plan.toEmbed,
        )
        completedFilesCount += batchAttemptedPaths.length
        inBatchCompletedFiles = 0
        reportProgress({
          completedChunks: embedder.completedChunks,
          totalChunks: totalChunksDiscovered,
        })

        if (batchWholeFailed) {
          // Stop processing further batches; the failure aggregation below
          // decides whether this surfaces as a transient retry or a hard
          // failure. Later files are left un-chunkified / un-embedded.
          wholeBatchFailed = true
          break
        }
      } catch (error) {
        try {
          await this.repository.deleteVectorsByPaths(
            embeddingModel.id,
            batchAttemptedPaths,
          )
        } catch (rollbackError) {
          console.warn(
            `[YOLO] Failed to roll back partially-written file batch (${batchAttemptedPaths.length} file(s)); the original error is rethrown below`,
            rollbackError,
          )
        }
        throw error
      }
    }

    if (filesToChunkify.length === 0) {
      // Deletion-only run (no files to chunkify): report the resting state
      // once so the UI doesn't see stale in-flight progress from a
      // previous run.
      reportProgress({ completedChunks: 0, totalChunks: 0 })
    }

    // Chunkify failures are soft (self-healing): the file is excluded from
    // that batch's diff (its old index is preserved and mtime not
    // advanced), so the next reconcile retries it. We log details for
    // diagnostics and report the paths up to the caller, but never throw or
    // pop a modal here.
    if (failedFiles.length > 0) {
      const errorDetails = failedFiles
        .map(({ path, error }) => `File: ${path}\nError: ${error}`)
        .join('\n\n')
      console.warn(
        `[YOLO] Failed to chunkify ${failedFiles.length} file(s) (will retry next reconcile):\n\n${errorDetails}`,
      )
    }
    const chunkifyFailedPaths = failedFiles.map((f) => f.path)

    // ---- Failure aggregation + classification-based routing ----
    //
    // Aggregate per-chunk failures (accumulated across every file batch) by
    // file. A file is rolled back if it has ANY transient failure (even
    // mixed transient+permanent): keeping its successful/reused chunks
    // would stamp the current mtime and let the transient gap be frozen
    // forever (MAX-mtime skip). Files whose failures are exclusively
    // permanent/unknown can never index fully, so we keep their successful
    // chunks (stable mtime, no flapping) and surface a persistent,
    // actionable warning instead of retrying forever.
    const failedChunks = embedder.failedChunks
    let softPermanentFailedPaths: string[] = []
    if (failedChunks.length > 0) {
      const failuresByPath = new Map<string, RagIndexFailureKind[]>()
      for (const chunk of failedChunks) {
        const bucket = failuresByPath.get(chunk.path)
        if (bucket) bucket.push(chunk.kind)
        else failuresByPath.set(chunk.path, [chunk.kind])
      }

      const rollbackPaths: string[] = []
      const permanentFailedPaths: string[] = []
      for (const [path, kinds] of failuresByPath) {
        if (kinds.some((kind) => kind === 'transient')) {
          rollbackPaths.push(path)
        } else {
          permanentFailedPaths.push(path)
        }
      }

      if (rollbackPaths.length > 0) {
        // This run is incomplete and will retry (RagIndexIncompleteError
        // below). Roll back BOTH transient AND permanent-failed files:
        // - transient: must be re-embedded;
        // - permanent: leaving its partial success would stamp the current
        //   mtime and let the file be silently skipped on the retry,
        //   freezing the gap. Re-evaluate it next run; a permanent-only
        //   file is then surfaced (below) once a clean run completes.
        // Delete each file's ENTIRE row set (incl. reused/bumped chunks
        // from the apply step above), so no surviving row carries the
        // current mtime. (rollbackPaths and permanentFailedPaths are
        // disjoint by construction.)
        await this.repository.deleteVectorsByPaths(embeddingModel.id, [
          ...rollbackPaths,
          ...permanentFailedPaths,
        ])
      }

      // Persistent "keep + warn" is valid ONLY for a fully-processed run
      // with no transient retry in flight. On an early stop
      // (wholeBatchFailed) the run is incomplete and surfaces via the
      // throw below; on a transient retry the permanent files were just
      // rolled back for re-evaluation. Either way, suppress the partial
      // report here to avoid a misleading "the rest is indexed" message /
      // a frozen gap.
      if (
        permanentFailedPaths.length > 0 &&
        rollbackPaths.length === 0 &&
        !wholeBatchFailed
      ) {
        softPermanentFailedPaths = permanentFailedPaths
        const errorDetails = failedChunks
          .filter(
            (chunk) =>
              !failuresByPath
                .get(chunk.path)
                ?.some((kind) => kind === 'transient'),
          )
          .map((chunk) => `File: ${chunk.path}\nError: ${chunk.error}`)
          .join('\n\n')
        console.warn(
          `[YOLO] ${permanentFailedPaths.length} file(s) could not be indexed (kept partial results, will not retry):\n\n${errorDetails}`,
        )
      }

      if (rollbackPaths.length > 0) {
        throw new RagIndexIncompleteError([
          ...rollbackPaths,
          ...permanentFailedPaths,
        ])
      }
    }

    // Early stop with no transient failures to retry: the cause is
    // permanent/unknown (e.g. invalid API key) and later batches were
    // never attempted. Throw so the run is recorded as failed (no false
    // success, no retry for a permanent cause); the caller surfaces the
    // details.
    if (wholeBatchFailed) {
      // Carry the underlying embedding error with the halt: it is the only
      // place the cause is reported (this branch deliberately skips the
      // per-file warning above), so without it the run surfaces as "failed"
      // with nothing — in the UI or the console — saying why.
      const cause = failedChunks[failedChunks.length - 1]?.error
      throw new Error(
        `Embedding halted: an entire batch failed to embed and indexing was stopped before completing all chunks.${
          cause ? ` Last error: ${cause}` : ''
        }`,
      )
    }

    return {
      permanentFailedPaths: softPermanentFailedPaths,
      chunkifyFailedPaths,
    }
  }

  /**
   * Truncate one model's namespace (used by manual "remove index" actions).
   * Serialized per model, same as `reconcile` — see `enqueueForModel`.
   */
  async clearAllVectors(embeddingModel: EmbeddingModelClient) {
    const release = this.enterOperation()
    try {
      await this.enqueueForModel(embeddingModel.id, () =>
        this.repository.truncateModel(embeddingModel.id),
      )
    } finally {
      release()
    }
  }

  /** Serialized against every affected model, same as `reconcile` — see `enqueueForModels`. */
  async clearVectorsByModelIds(modelIds: string[]) {
    const release = this.enterOperation()
    try {
      await this.enqueueForModels(modelIds, () =>
        this.repository.clearVectorsByModelIds(modelIds),
      )
    } finally {
      release()
    }
  }

  async getEmbeddingStats(): Promise<EmbeddingDbStats[]> {
    const release = this.enterOperation()
    try {
      return await this.repository.getEmbeddingStats()
    } finally {
      release()
    }
  }

  /** Distinct indexed file count for one model — the "文档" number on a
   * knowledge base card, as opposed to `getEmbeddingStats`'s chunk-level
   * `rowCount`. */
  /** Every file path with at least one indexed chunk for this model. */
  async listIndexedPaths(embeddingModelId: string): Promise<string[]> {
    const release = this.enterOperation()
    try {
      const mtimes = await this.repository.getFileMtimes(embeddingModelId)
      return Object.keys(mtimes)
    } finally {
      release()
    }
  }

  async getIndexedFileCount(embeddingModelId: string): Promise<number> {
    const release = this.enterOperation()
    try {
      const mtimes = await this.repository.getFileMtimes(embeddingModelId)
      return Object.keys(mtimes).length
    } finally {
      release()
    }
  }

  async quiesce(): Promise<void> {
    this.acceptingOperations = false
    if (this.activeOperations === 0) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  private enterOperation(): () => void {
    if (!this.acceptingOperations) {
      throw new Error('Vector store is quiescing')
    }
    this.activeOperations += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeOperations -= 1
      if (this.activeOperations === 0) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  // ---------- internals ----------

  private listIndexableFiles(config: ReconcileConfig): TFile[] {
    let files = this.app.vault.getFiles().filter((f) => {
      const ext = f.extension.toLowerCase()
      if (ext === 'md') return true
      if (config.indexPdf && ext === 'pdf') return true
      return false
    })
    // The YOLO base directory is excluded unconditionally — every knowledge
    // base's engine, not a per-base rule the UI can toggle.
    files = files.filter(
      (file) => !isWithinYoloBaseDir(file.path, config.settings),
    )
    files = files.filter((file) =>
      matchesIncludeExcludeScope(file.path, config.include, config.exclude),
    )
    return files
  }

  private async chunkifyFile(
    file: TFile,
    textSplitter: RecursiveCharacterTextSplitter,
    chunkSize: number,
    signal?: AbortSignal,
    settings?: YoloSettingsLike | null,
  ): Promise<DesiredChunk[]> {
    if (file.extension?.toLowerCase() === 'pdf') {
      return this.chunkifyPdf(file, chunkSize, signal, settings)
    }

    const fileContent = await this.app.vault.cachedRead(file)
    const sanitized = fileContent.split('\u0000').join('')
    const docs = await textSplitter.createDocuments([sanitized])

    const chunks: DesiredChunk[] = []
    for (const doc of docs) {
      const startLine = doc.metadata.loc.lines.from as number
      const endLine = doc.metadata.loc.lines.to as number
      const meta: VectorMetaData = { startLine, endLine }
      const contentHash = await sha256HexPrefix16(doc.pageContent)
      chunks.push({
        path: file.path,
        content: doc.pageContent,
        contentHash,
        metadata: meta,
        mtime: file.stat.mtime,
      })
    }
    return chunks
  }

  private async chunkifyPdf(
    file: TFile,
    chunkSize: number,
    signal?: AbortSignal,
    settings?: YoloSettingsLike | null,
  ): Promise<DesiredChunk[]> {
    if (file.stat.size > PDF_INDEX_MAX_BYTES) {
      console.warn(
        `[YOLO] Skipping PDF (>${PDF_INDEX_MAX_BYTES} bytes): ${file.path}`,
      )
      return []
    }

    let pages: { page: number; text: string }[]
    try {
      const extracted = await extractPdfText(this.app, file, {
        signal,
        maxBinaryBytes: PDF_INDEX_MAX_BYTES,
        maxPages: PDF_INDEX_MAX_PAGES,
        settings: settings ?? null,
      })
      pages = extracted.pages
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }
      console.warn(
        `[YOLO] PDF text extraction failed: ${file.path}`,
        error instanceof Error ? error.message : error,
      )
      return []
    }

    const pageSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: Math.min(PDF_PAGE_CHUNK_CHAR_THRESHOLD, chunkSize),
      chunkOverlap: 0,
    })

    const chunks: DesiredChunk[] = []
    for (const { page: pageNum, text } of pages) {
      const trimmed = text.split('\u0000').join('').trim()
      if (!trimmed) continue
      const lineCount = Math.max(1, trimmed.split('\n').length)
      if (trimmed.length <= PDF_PAGE_CHUNK_CHAR_THRESHOLD) {
        const content = `[page ${pageNum}]\n${trimmed}`
        const contentHash = await sha256HexPrefix16(content)
        chunks.push({
          path: file.path,
          content,
          contentHash,
          metadata: { page: pageNum, startLine: 1, endLine: lineCount },
          mtime: file.stat.mtime,
        })
      } else {
        const docs = await pageSplitter.createDocuments([trimmed])
        for (const doc of docs) {
          const from = doc.metadata.loc.lines.from as number
          const to = doc.metadata.loc.lines.to as number
          const content = `[page ${pageNum}]\n${doc.pageContent}`
          const contentHash = await sha256HexPrefix16(content)
          chunks.push({
            path: file.path,
            content,
            contentHash,
            metadata: { page: pageNum, startLine: from, endLine: to },
            mtime: file.stat.mtime,
          })
        }
      }
    }
    return chunks
  }

  /**
   * Create a per-run chunk embedder. Its adaptive batch size, cumulative
   * `completedChunks`, and classified `failedChunks` persist across every
   * `embed()` call, so one reconcile run can process many bounded file
   * batches without losing rate-limit backoff state or double-counting
   * progress. `embed()` never rolls back or throws for per-chunk failures
   * (only for user-initiated abort) — the caller (`reconcile()`) performs the
   * end-of-run failure aggregation over `failedChunks` once, after every
   * batch has been attempted.
   */
  private createChunkEmbedder(
    embeddingModel: EmbeddingModelClient,
    options: {
      signal?: AbortSignal
      /**
       * Max parallel embedding requests. Clamped to [1, 24]. Default 10.
       * The adaptive batch-size shrink/grow stays within [1, maxConcurrency].
       */
      maxConcurrency?: number
      onProgress?: (snapshot: {
        completedChunks: number
        totalChunks: number
        /** Files of this `embed()` call whose chunks are all done, by chunk
         * order — an approximation under concurrency, but monotonic. */
        completedFilesInCall: number
        currentFile?: string
        waitingForRateLimit?: boolean
      }) => void
    },
  ): {
    embed: (toEmbed: DesiredChunk[]) => Promise<{ wholeBatchFailed: boolean }>
    readonly completedChunks: number
    readonly failedChunks: {
      path: string
      metadata: VectorMetaData
      error: string
      kind: RagIndexFailureKind
    }[]
  } {
    const { signal, onProgress } = options

    // Cumulative across every `embed()` call in this run.
    let completedChunks = 0
    const failedChunks: {
      path: string
      metadata: VectorMetaData
      error: string
      kind: RagIndexFailureKind
    }[] = []
    // Persists across calls so a file split across two progress ticks within
    // the same batch isn't re-reported.
    let lastReportedFile: string | null = null

    const MAX_BATCH_SIZE = Math.max(
      1,
      Math.min(24, Math.floor(options.maxConcurrency ?? 10)),
    )
    // Keep the adaptive floor at 10 when the ceiling allows, otherwise collapse
    // to the ceiling so user-configured low values aren't auto-scaled up.
    const MIN_BATCH_SIZE = Math.min(10, MAX_BATCH_SIZE)
    let currentBatchSize = MAX_BATCH_SIZE

    const embed = async (
      toEmbed: DesiredChunk[],
    ): Promise<{ wholeBatchFailed: boolean }> => {
      const totalChunks = toEmbed.length

      // Track which file a given position in `toEmbed` belongs to, so
      // progress can report the currently-embedding file without an O(n)
      // scan per chunk. Scoped to this call: a file batch never splits a
      // single file across two `embed()` calls.
      const fileBoundaries: Array<{ path: string; endChunk: number }> = []
      let cumulative = 0
      for (const chunk of toEmbed) {
        cumulative += 1
        const last = fileBoundaries[fileBoundaries.length - 1]
        if (last && last.path === chunk.path) {
          last.endChunk = cumulative
        } else {
          fileBoundaries.push({ path: chunk.path, endChunk: cumulative })
        }
      }
      let fileCursor = 0
      let completedInCall = 0
      let completedFileCursor = 0
      const completedFilesInCall = () => {
        while (
          completedFileCursor < fileBoundaries.length &&
          fileBoundaries[completedFileCursor].endChunk <= completedInCall
        ) {
          completedFileCursor += 1
        }
        return completedFileCursor
      }
      const currentFile = () => {
        while (
          fileCursor < fileBoundaries.length - 1 &&
          completedInCall > fileBoundaries[fileCursor].endChunk
        ) {
          fileCursor += 1
        }
        return fileBoundaries[fileCursor]?.path
      }
      const nextReportedFile = () => {
        const f = currentFile()
        if (!f || f === lastReportedFile) return undefined
        lastReportedFile = f
        return f
      }

      const embedOne = async (
        chunk: DesiredChunk,
      ): Promise<VectorInsert | null> => {
        if (signal?.aborted) return null
        try {
          return await backOff(
            async () => {
              if (signal?.aborted) {
                throw new DOMException(
                  'Indexing cancelled by user',
                  'AbortError',
                )
              }
              if (chunk.content.length === 0) {
                throw new Error(`Chunk content is empty in file: ${chunk.path}`)
              }
              if (chunk.content.includes('\x00')) {
                throw new Error(
                  `Chunk content contains null bytes in file: ${chunk.path}`,
                )
              }
              const embedding = await embeddingModel.getEmbedding(
                chunk.content,
                { kind: 'document' },
              )
              completedChunks += 1
              completedInCall += 1
              onProgress?.({
                completedChunks,
                totalChunks,
                completedFilesInCall: completedFilesInCall(),
                currentFile: nextReportedFile(),
              })
              return {
                path: chunk.path,
                mtime: chunk.mtime,
                content: chunk.content,
                content_hash: chunk.contentHash,
                model: embeddingModel.id,
                dimension: embeddingModel.dimension,
                embedding,
                metadata: chunk.metadata,
              }
            },
            {
              numOfAttempts: 6,
              startingDelay: 1500,
              timeMultiple: 2,
              maxDelay: 30000,
              retry: (error) => {
                if (signal?.aborted) return false
                if (!isTransientRagIndexError(error)) return false
                const status =
                  typeof error === 'object' &&
                  error !== null &&
                  'status' in error &&
                  typeof (error as { status?: unknown }).status === 'number'
                    ? (error as { status: number }).status
                    : undefined
                const message =
                  error instanceof Error ? error.message.toLowerCase() : ''
                const waiting = status === 429 || message.includes('rate limit')
                if (waiting) {
                  const f = currentFile() ?? chunk.path
                  lastReportedFile = f
                  onProgress?.({
                    completedChunks,
                    totalChunks,
                    completedFilesInCall: completedFilesInCall(),
                    currentFile: f,
                    waitingForRateLimit: true,
                  })
                }
                return true
              },
            },
          )
        } catch (error) {
          failedChunks.push({
            path: chunk.path,
            metadata: chunk.metadata,
            error: error instanceof Error ? error.message : 'Unknown error',
            // Classify the original error object (status/code/instanceof), not a
            // stringified message, so transient vs permanent is reliable.
            kind: classifyRagIndexError(error),
          })
          return null
        }
      }

      // Set when a whole (adaptive) sub-batch fails to embed and we stop
      // early, leaving the rest of this call's chunks (and, per the caller,
      // any later file batches) unattempted. Such a run is NOT complete and
      // must never be treated as success (see reconcile()'s aggregation).
      let wholeBatchFailed = false
      for (
        let batchStart = 0;
        batchStart < toEmbed.length;
        batchStart += currentBatchSize
      ) {
        const batch = toEmbed.slice(batchStart, batchStart + currentBatchSize)
        if (signal?.aborted) {
          throw new DOMException('Indexing cancelled by user', 'AbortError')
        }
        await yieldToMain()

        let validRows: VectorInsert[] = []
        let attempt = 0
        while (attempt < 2) {
          attempt += 1
          // Record where this attempt's failures begin. If the whole attempt
          // fails and we retry, we discard them (below) so only the FINAL
          // attempt's failures drive rollback/warning — otherwise a batch that
          // fails attempt 1 but succeeds attempt 2 would still be rolled back.
          const failureStart = failedChunks.length
          const results = await Promise.all(batch.map((c) => embedOne(c)))
          validRows = results.filter((r): r is VectorInsert => r !== null)
          if (validRows.length > 0) {
            if (
              validRows.length !== batch.length &&
              currentBatchSize > MIN_BATCH_SIZE
            ) {
              currentBatchSize = Math.max(
                MIN_BATCH_SIZE,
                Math.floor(currentBatchSize / 2),
              )
            } else if (
              validRows.length === batch.length &&
              currentBatchSize < MAX_BATCH_SIZE
            ) {
              currentBatchSize = Math.min(MAX_BATCH_SIZE, currentBatchSize + 4)
            }
            break
          }
          if (attempt < 2) {
            // Discard this failed attempt's records before retrying.
            failedChunks.splice(failureStart)
            currentBatchSize = Math.max(
              MIN_BATCH_SIZE,
              Math.floor(currentBatchSize / 2),
            )
            await yieldToMain()
          }
        }

        if (signal?.aborted) {
          // Deliberately does NOT insert `validRows` first: those rows would
          // carry the file's current mtime while the rest of that file's
          // chunks (in a later, now-abandoned sub-batch) never get written —
          // the next reconcile would see the current mtime and skip the file
          // as "unchanged" forever (see Codex finding 1.2). `reconcile`'s
          // caller-side try/catch around this batch's apply+embed segment
          // rolls back every row for every file this batch touched once this
          // throw propagates, so no partial state survives either way.
          throw new DOMException('Indexing cancelled by user', 'AbortError')
        }

        if (validRows.length === 0 && batch.length > 0) {
          // Whole batch failed (e.g. full network outage or invalid API key).
          // Stop embedding and let the caller fall through to the unified
          // failure aggregation at the end of the run: if the failures are
          // transient it throws RagIndexIncompleteError (→ retry); if purely
          // permanent/unknown the caller's post-loop guard throws so the run
          // is recorded as failed rather than silently succeeding with later
          // batches left unprocessed.
          wholeBatchFailed = true
          break
        }
        await this.repository.insertVectors(validRows)
        onProgress?.({
          completedChunks,
          totalChunks,
          completedFilesInCall: completedFilesInCall(),
          waitingForRateLimit: false,
        })

        batchStart += batch.length - currentBatchSize
      }

      return { wholeBatchFailed }
    }

    return {
      embed,
      get completedChunks() {
        return completedChunks
      },
      get failedChunks() {
        return failedChunks
      },
    }
  }
}
