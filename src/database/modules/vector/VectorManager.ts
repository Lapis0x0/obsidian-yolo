import { PgliteDatabase } from 'drizzle-orm/pglite'
import { backOff } from 'exponential-backoff'
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'
import { minimatch } from 'minimatch'
import { App, TFile } from 'obsidian'

import { IndexProgress } from '../../../components/chat-view/QueryProgress'
import { ErrorModal } from '../../../components/modals/ErrorModal'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
} from '../../../core/llm/exception'
import { isTransientRagIndexError } from '../../../core/rag/ragIndexErrors'
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

export class VectorManager {
  private app: App
  private repository: VectorRepository
  private saveCallback: (() => Promise<void>) | null = null
  private vacuumCallback: (() => Promise<void>) | null = null

  private async requestSave() {
    try {
      if (this.saveCallback) {
        await this.saveCallback()
      } else {
        throw new Error('No save callback set')
      }
    } catch (error) {
      new ErrorModal(
        this.app,
        'Error: save failed',
        'Failed to save the vector database changes. Please report this issue to the developer.',
        error instanceof Error ? error.message : 'Unknown error',
        {
          showReportBugButton: true,
        },
      ).open()
      throw error instanceof Error ? error : new Error(String(error))
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
  ): Promise<void> {
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
    const filesToChunkify: TFile[] = []
    let newFilesCount = 0
    let updatedFilesCount = 0
    for (const file of candidateFiles) {
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
      return
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

    if (failedFiles.length > 0) {
      const errorDetails =
        `Failed to process ${failedFiles.length} file(s):\n\n` +
        failedFiles
          .map(({ path, error }) => `File: ${path}\nError: ${error}`)
          .join('\n\n')
      new ErrorModal(
        this.app,
        'Error: chunk embedding failed',
        `Some files failed to process. Please report this issue to the developer if it persists.`,
        `[Error Log]\n\n${errorDetails}`,
        { showReportBugButton: true },
      ).open()
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
      return
    }

    // 8. Embed in batches with rate-limit aware retry.
    await this.embedAndInsertBatches(plan.toEmbed, embeddingModel, {
      signal,
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
    })
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
      const trimmed = text.trim()
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
      onProgress?: (snapshot: {
        completedChunks: number
        totalChunks: number
        currentFile?: string
        waitingForRateLimit?: boolean
      }) => void
    },
  ): Promise<void> {
    const { signal, onProgress } = options
    const totalChunks = toEmbed.length
    let completedChunks = 0
    const failedChunks: {
      path: string
      metadata: VectorMetaData
      error: string
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

    let currentBatchSize = 24
    const MIN_BATCH_SIZE = 10
    const MAX_BATCH_SIZE = 24
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
        })
        return null
      }
    }

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
          throw new Error(
            'All chunks in batch failed to embed. Stopping indexing process.',
          )
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
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }
      if (
        error instanceof LLMAPIKeyNotSetException ||
        error instanceof LLMAPIKeyInvalidException ||
        error instanceof LLMBaseUrlNotSetException
      ) {
        new ErrorModal(this.app, 'Error', error.message, undefined, {
          showSettingsButton: true,
        }).open()
      } else {
        const errorDetails =
          `Failed to process ${failedChunks.length} chunk(s):\n\n` +
          failedChunks
            .map((chunk) => `File: ${chunk.path}\nError: ${chunk.error}`)
            .join('\n\n')
        new ErrorModal(
          this.app,
          'Error: embedding failed',
          `The indexing process was interrupted because several files couldn't be processed.
Please report this issue to the developer if it persists.`,
          `[Error Log]\n\n${errorDetails}`,
          { showReportBugButton: true },
        ).open()
      }
      throw error
    } finally {
      await this.requestSave()
    }
  }
}
