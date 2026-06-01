import { PgliteDatabase } from 'drizzle-orm/pglite'
import { backOff } from 'exponential-backoff'
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'
import { minimatch } from 'minimatch'
import { App, TFile } from 'obsidian'

import { IndexProgress } from '../../../components/chat-view/QueryProgress'
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
import { InsertEmbedding, SelectEmbedding, VectorMetaData } from '../../schema'

import { VectorRepository } from './VectorRepository'

const PDF_PAGE_CHUNK_CHAR_THRESHOLD = 1500

/** Opaque handle for the YOLO-root-aware PDF text cache. */
type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

export type ReconcileConfig = {
  chunkSize: number
  includePatterns: string[]
  excludePatterns: string[]
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
  private repository: VectorRepository
  private saveCallback: (() => Promise<void>) | null = null
  private vacuumCallback: (() => Promise<void>) | null = null

  private async requestSave() {
    if (this.saveCallback) {
      await this.saveCallback()
    } else {
      throw new Error('No save callback set')
    }
  }

  private async requestVacuum() {
    if (this.vacuumCallback) {
      await this.vacuumCallback()
    }
  }

  constructor(app: App, db: PgliteDatabase) {
    this.app = app
    this.repository = new VectorRepository(app, db)
  }

  setSaveCallback(callback: () => Promise<void>) {
    this.saveCallback = callback
  }

  setVacuumCallback(callback: () => Promise<void>) {
    this.vacuumCallback = callback
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
      }
    },
  ): Promise<
    (Omit<SelectEmbedding, 'embedding'> & {
      similarity: number
    })[]
  > {
    return await this.repository.performSimilaritySearch(
      queryVector,
      embeddingModel,
      options,
    )
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
   * chunks that didn't make it to the DB before.
   */
  async reconcile(
    embeddingModel: EmbeddingModelClient,
    config: ReconcileConfig,
    options: ReconcileOptions,
  ): Promise<ReconcileResult> {
    const { signal, scope, truncate, onProgress } = options

    if (truncate) {
      await this.repository.truncateModel(embeddingModel.id)
      await this.requestVacuum()
    }

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
    const mtimeMap = truncate
      ? new Map<string, number>()
      : await this.repository.getFileMtimes(embeddingModel.id)

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

    // 4. Removed paths: in actual but no longer a candidate (and within scope).
    const removedPaths: string[] = []
    if (!truncate) {
      const inScope = (path: string): boolean =>
        scope.kind === 'all' ? true : scope.paths.includes(path)
      for (const path of mtimeMap.keys()) {
        if (!candidateSet.has(path) && inScope(path)) {
          removedPaths.push(path)
        }
      }
    }
    const removedFilesCount = removedPaths.length

    // 5. Chunkify and read actual for the diff scope.
    const diffPaths = [...filesToChunkify.map((f) => f.path), ...removedPaths]

    if (filesToChunkify.length === 0 && removedPaths.length === 0) {
      // Nothing to do (everything is stable). Persist any truncate effect.
      if (truncate) await this.requestSave()
      return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
    }

    const textSplitter = RecursiveCharacterTextSplitter.fromLanguage(
      'markdown',
      { chunkSize: config.chunkSize },
    )

    const desired: DesiredChunk[] = []
    const failedFiles: { path: string; error: string }[] = []
    let completedFilesCount = 0
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

    const maybeYield = createYieldController(10)
    for (const file of filesToChunkify) {
      if (signal?.aborted) {
        await this.requestSave()
        throw new DOMException('Indexing cancelled by user', 'AbortError')
      }
      await maybeYield()

      const folder = folderOf(file.path)
      onProgress?.({
        completedChunks: 0,
        totalChunks: 0,
        totalFiles: filesToChunkify.length,
        completedFiles: completedFilesCount,
        currentFile: file.path,
        currentFolder: folder,
        folderProgress,
        newFilesCount,
        updatedFilesCount,
        removedFilesCount,
      })

      try {
        const fileChunks = await this.chunkifyFile(
          file,
          textSplitter,
          config.chunkSize,
          signal,
          config.settings ?? null,
        )
        desired.push(...fileChunks)
        folderProgress[folder].completedFiles += 1
        folderProgress[folder].totalChunks += fileChunks.length
        for (const anc of ancestorsOf(folder).slice(1)) {
          folderProgress[anc].totalChunks += fileChunks.length
        }
        completedFilesCount += 1
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          await this.requestSave()
          throw error
        }
        failedFiles.push({
          path: file.path,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    // Chunkify failures are soft (self-healing): the files are excluded from the
    // diff (their old index is preserved and mtime not advanced), so the next
    // reconcile retries them. We log details for diagnostics and report the
    // paths up to the caller, but never throw or pop a modal here.
    const chunkifyFailedPaths = failedFiles.map((f) => f.path)
    if (failedFiles.length > 0) {
      const errorDetails = failedFiles
        .map(({ path, error }) => `File: ${path}\nError: ${error}`)
        .join('\n\n')
      console.warn(
        `[YOLO] Failed to chunkify ${failedFiles.length} file(s) (will retry next reconcile):\n\n${errorDetails}`,
      )
    }

    // 6. Read actual rows over the diff scope and plan.
    //
    // Critical: exclude failed-to-chunkify paths from the diff. Their `desired`
    // is empty (chunking threw) but their existing rows must NOT be treated as
    // "no longer desired" — that would silently delete a user's index after a
    // transient I/O error. Skip them; next reconcile will retry.
    const failedPaths = new Set(failedFiles.map((f) => f.path))
    const safeDiffPaths = diffPaths.filter((p) => !failedPaths.has(p))
    const actualRows = truncate
      ? []
      : await this.repository.listChunksForPaths(
          embeddingModel.id,
          safeDiffPaths,
        )
    const actual = actualRows.map((row) => ({
      id: row.id,
      path: row.path,
      contentHash: row.content_hash,
      metadata: row.metadata,
      mtime: row.mtime,
    }))
    const plan = planReconcile(desired, actual)

    // 7. Apply deletions and mtime bumps before embedding so that on-disk
    //    state converges monotonically toward `desired`.
    if (plan.toDeleteIds.length > 0) {
      await this.repository.deleteVectorsByIds(plan.toDeleteIds)
    }
    if (plan.toBumpMtime.length > 0) {
      await this.repository.bumpMtimeByIds(plan.toBumpMtime)
    }

    if (plan.toEmbed.length === 0) {
      await this.requestSave()
      onProgress?.({
        completedChunks: 0,
        totalChunks: 0,
        totalFiles: filesToChunkify.length,
        completedFiles: completedFilesCount,
        folderProgress,
        newFilesCount,
        updatedFilesCount,
        removedFilesCount,
      })
      return { permanentFailedPaths: [], chunkifyFailedPaths }
    }

    // 8. Embed in batches with rate-limit aware retry.
    const { permanentFailedPaths } = await this.embedAndInsertBatches(
      plan.toEmbed,
      embeddingModel,
      {
        signal,
        maxConcurrency: config.embeddingConcurrency,
        onProgress: (snapshot) =>
          onProgress?.({
            ...snapshot,
            totalFiles: filesToChunkify.length,
            completedFiles: completedFilesCount,
            folderProgress,
            newFilesCount,
            updatedFilesCount,
            removedFilesCount,
          }),
      },
    )

    return { permanentFailedPaths, chunkifyFailedPaths }
  }

  /** Truncate one model's namespace (used by manual "remove index" actions). */
  async clearAllVectors(embeddingModel: EmbeddingModelClient) {
    await this.repository.truncateModel(embeddingModel.id)
    await this.requestVacuum()
    await this.requestSave()
  }

  async clearVectorsByModelIds(modelIds: string[]) {
    await this.repository.clearVectorsByModelIds(modelIds)
    await this.requestVacuum()
    await this.requestSave()
  }

  async getEmbeddingStats(): Promise<EmbeddingDbStats[]> {
    return await this.repository.getEmbeddingStats()
  }

  // ---------- internals ----------

  private listIndexableFiles(config: ReconcileConfig): TFile[] {
    let files = this.app.vault.getFiles().filter((f) => {
      const ext = f.extension.toLowerCase()
      if (ext === 'md') return true
      if (config.indexPdf && ext === 'pdf') return true
      return false
    })
    files = files.filter(
      (file) =>
        !config.excludePatterns.some((pattern) =>
          minimatch(file.path, pattern),
        ),
    )
    if (config.includePatterns.length > 0) {
      files = files.filter((file) =>
        config.includePatterns.some((pattern) => minimatch(file.path, pattern)),
      )
    }
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

  private async embedAndInsertBatches(
    toEmbed: DesiredChunk[],
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
        currentFile?: string
        waitingForRateLimit?: boolean
      }) => void
    },
  ): Promise<{ permanentFailedPaths: string[] }> {
    const { signal, onProgress } = options
    const totalChunks = toEmbed.length
    let completedChunks = 0
    const failedChunks: {
      path: string
      metadata: VectorMetaData
      error: string
      kind: RagIndexFailureKind
    }[] = []
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
    let lastReportedFile: string | null = null
    const currentFile = () => {
      while (
        fileCursor < fileBoundaries.length - 1 &&
        completedChunks > fileBoundaries[fileCursor].endChunk
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

    const MAX_BATCH_SIZE = Math.max(
      1,
      Math.min(24, Math.floor(options.maxConcurrency ?? 10)),
    )
    // Keep the adaptive floor at 10 when the ceiling allows, otherwise collapse
    // to the ceiling so user-configured low values aren't auto-scaled up.
    const MIN_BATCH_SIZE = Math.min(10, MAX_BATCH_SIZE)
    let currentBatchSize = MAX_BATCH_SIZE
    // Full DB snapshot checkpoint interval (chunks). requestSave() triggers
    // a full pgClient.dumpDataDir + writeBinary, whose cost scales with total
    // DB size — not with the 1500-chunk delta — so lowering this knob has
    // O(DB size) write amplification and is not a sound way to bound the
    // "embeddings already paid for but not yet persisted" loss. If that loss
    // ever needs a real bound, do it with an incremental segment log, not by
    // shortening this interval.
    const INCREMENTAL_SAVE_THRESHOLD = 1500
    let chunksSinceLastSave = 0

    const embedOne = async (
      chunk: DesiredChunk,
    ): Promise<InsertEmbedding | null> => {
      if (signal?.aborted) return null
      try {
        return await backOff(
          async () => {
            if (signal?.aborted) {
              throw new DOMException('Indexing cancelled by user', 'AbortError')
            }
            if (chunk.content.length === 0) {
              throw new Error(`Chunk content is empty in file: ${chunk.path}`)
            }
            if (chunk.content.includes('\x00')) {
              throw new Error(
                `Chunk content contains null bytes in file: ${chunk.path}`,
              )
            }
            const embedding = await embeddingModel.getEmbedding(chunk.content)
            completedChunks += 1
            onProgress?.({
              completedChunks,
              totalChunks,
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

    // Set when a whole batch fails to embed and we stop early, leaving later
    // batches unattempted. Such a run is NOT complete and must never be treated
    // as success (see the post-loop handling below).
    let wholeBatchFailed = false
    // Soft permanent failures (files whose successful chunks are kept, but which
    // can never index fully and are not retried). Surfaced to the caller via the
    // return value — never thrown, never popped as a modal.
    const softPermanentFailedPaths: string[] = []
    try {
      for (
        let batchStart = 0;
        batchStart < toEmbed.length;
        batchStart += currentBatchSize
      ) {
        const batch = toEmbed.slice(batchStart, batchStart + currentBatchSize)
        if (signal?.aborted) {
          await this.requestSave()
          throw new DOMException('Indexing cancelled by user', 'AbortError')
        }
        await yieldToMain()

        let validRows: InsertEmbedding[] = []
        let attempt = 0
        while (attempt < 2) {
          attempt += 1
          // Record where this attempt's failures begin. If the whole attempt
          // fails and we retry, we discard them (below) so only the FINAL
          // attempt's failures drive rollback/warning — otherwise a batch that
          // fails attempt 1 but succeeds attempt 2 would still be rolled back.
          const failureStart = failedChunks.length
          const results = await Promise.all(batch.map((c) => embedOne(c)))
          validRows = results.filter((r): r is InsertEmbedding => r !== null)
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
          if (validRows.length > 0) {
            await this.repository.insertVectors(validRows)
          }
          await this.requestSave()
          throw new DOMException('Indexing cancelled by user', 'AbortError')
        }

        if (validRows.length === 0 && batch.length > 0) {
          // Whole batch failed (e.g. full network outage or invalid API key).
          // Stop embedding and fall through to the unified failure aggregation
          // below: if the failures are transient it throws RagIndexIncomplete-
          // Error (→ retry); if purely permanent/unknown the post-loop guard
          // throws so the run is recorded as failed rather than silently
          // succeeding with later batches left unprocessed.
          wholeBatchFailed = true
          break
        }
        await this.repository.insertVectors(validRows)
        chunksSinceLastSave += validRows.length
        if (chunksSinceLastSave >= INCREMENTAL_SAVE_THRESHOLD) {
          await this.requestSave()
          chunksSinceLastSave = 0
        }
        onProgress?.({
          completedChunks,
          totalChunks,
          waitingForRateLimit: false,
        })

        batchStart += batch.length - currentBatchSize
      }

      // ---- Failure aggregation + classification-based routing ----
      //
      // Aggregate per-chunk failures by file. A file is rolled back if it has
      // ANY transient failure (even mixed transient+permanent): keeping its
      // successful/reused chunks would stamp the current mtime and let the
      // transient gap be frozen forever (MAX-mtime skip). Files whose failures
      // are exclusively permanent/unknown can never index fully, so we keep
      // their successful chunks (stable mtime, no flapping) and surface a
      // persistent, actionable warning instead of retrying forever.
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
          //   mtime and let the file be silently skipped on the retry, freezing
          //   the gap. Re-evaluate it next run; a permanent-only file is then
          //   surfaced (below) once a clean run completes.
          // Delete each file's ENTIRE row set (incl. reused/bumped chunks from
          // step 7), so no surviving row carries the current mtime.
          // (rollbackPaths and permanentFailedPaths are disjoint by construction.)
          await this.repository.deleteVectorsByPaths(embeddingModel.id, [
            ...rollbackPaths,
            ...permanentFailedPaths,
          ])
        }

        // Persistent "keep + warn" is valid ONLY for a fully-processed run with
        // no transient retry in flight. On an early stop (wholeBatchFailed) the
        // run is incomplete and surfaces via the throw below; on a transient
        // retry the permanent files were just rolled back for re-evaluation.
        // Either way, suppress the partial report here to avoid a misleading
        // "the rest is indexed" message / a frozen gap.
        if (
          permanentFailedPaths.length > 0 &&
          rollbackPaths.length === 0 &&
          !wholeBatchFailed
        ) {
          softPermanentFailedPaths.push(...permanentFailedPaths)
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
      // permanent/unknown (e.g. invalid API key) and later batches were never
      // attempted. Throw so the run is recorded as failed (no false success,
      // no retry for a permanent cause); the catch below surfaces the details.
      if (wholeBatchFailed) {
        throw new Error(
          'Embedding halted: an entire batch failed to embed and indexing was stopped before completing all chunks.',
        )
      }
    } finally {
      // Always persist whatever made it into the DB, on both the success path
      // and any throw (AbortError, RagIndexIncompleteError, wholeBatchFailed
      // halt, etc.) — those errors propagate unchanged to the caller.
      await this.requestSave()
    }

    return { permanentFailedPaths: softPermanentFailedPaths }
  }
}
