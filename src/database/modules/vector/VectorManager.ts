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
import {
  isTransientRagIndexError,
} from '../../../core/rag/ragIndexErrors'
import {
  InsertEmbedding,
  SelectEmbedding,
  VectorMetaData,
} from '../../../database/schema'
import {
  EmbeddingDbStats,
  EmbeddingModelClient,
} from '../../../types/embedding'
import { sha256HexPrefix16 } from '../../../utils/common/content-hash'
import {
  createYieldController,
  yieldToMain,
} from '../../../utils/common/yield-to-main'

import { VectorRepository } from './VectorRepository'

const createStagingModelId = (embeddingModelId: string, indexRunId: string) =>
  `${embeddingModelId}::staging:${indexRunId}`

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

  private async promoteStagingModel(
    activeModelId: string,
    stagingModelId: string,
  ): Promise<void> {
    await this.repository.replaceModelContents({
      activeModelId,
      stagingModelId,
    })
    await this.requestVacuum()
    await this.requestSave()
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

  async updateVaultIndex(
    embeddingModel: EmbeddingModelClient,
    options: {
      chunkSize: number
      excludePatterns: string[]
      includePatterns: string[]
      reindexAll?: boolean
      /**
       * When true, wipe staging before starting the rebuild (fresh start).
       * When false (default), resume: keep any chunks already embedded into
       * staging from a prior attempt and skip them this run.
       */
      fromScratch?: boolean
      signal?: AbortSignal
      indexRunId?: string
    },
    updateProgress?: (indexProgress: IndexProgress) => void,
  ): Promise<void> {
    const { signal } = options
    const stagingModelId =
      options.reindexAll && options.indexRunId
        ? createStagingModelId(embeddingModel.id, options.indexRunId)
        : null
    const targetModelId = stagingModelId ?? embeddingModel.id
    let filesToIndex: TFile[]
    let newFilesCount = 0
    let updatedFilesCount = 0
    const removedFilesCount = 0
    let stagingFingerprints: Map<string, Set<string>> | null = null
    // Resumed-chunk count: chunks already embedded in staging from a prior
    // attempt. Added to both numerator and denominator of the progress ring
    // so a 5%-resumed rebuild visibly continues from 5% rather than from 0%.
    let resumedChunks = 0

    if (options.reindexAll) {
      filesToIndex = this.getFilteredMarkdownFiles(
        options.excludePatterns,
        options.includePatterns,
      )
      if (stagingModelId) {
        if (options.fromScratch) {
          await this.repository.clearStagingVectorsForModel(embeddingModel.id)
        } else {
          // Scope-shrink guard: drop staging rows whose path is no longer
          // in-scope so promotion doesn't leak them into active.
          await this.repository.deleteStagingRowsOutsideScope(
            stagingModelId,
            filesToIndex.map((f) => f.path),
          )
          stagingFingerprints =
            await this.repository.getStagingFingerprints(stagingModelId)
          for (const set of stagingFingerprints.values()) {
            resumedChunks += set.size
          }
        }
      } else {
        await this.repository.clearAllVectors(embeddingModel)
      }
      newFilesCount = filesToIndex.length // 全量重建时都算新文件
    } else {
      await this.deleteVectorsForDeletedFiles(embeddingModel)

      // 使用批量查询获取所有已索引文件的 mtime，避免 N+1 查询
      const result = await this.getFilesToIndexWithStats({
        embeddingModel,
        excludePatterns: options.excludePatterns,
        includePatterns: options.includePatterns,
      })

      filesToIndex = result.files
      newFilesCount = result.newCount
      updatedFilesCount = result.updatedCount
      // 增量模式：按 chunk 内容 hash 删除/保留，不在此处整文件删除
    }

    if (filesToIndex.length === 0) {
      if (stagingModelId) {
        await this.promoteStagingModel(embeddingModel.id, stagingModelId)
      }
      return
    }

    // 按文件夹分组文件
    const folderGroups: Record<string, TFile[]> = {}
    for (const file of filesToIndex) {
      const folderPath = file.path.includes('/')
        ? file.path.substring(0, file.path.lastIndexOf('/'))
        : ''
      if (!folderGroups[folderPath]) {
        folderGroups[folderPath] = []
      }
      folderGroups[folderPath].push(file)
    }

    // 工具方法：返回当前文件夹及其向上的所有父级（不含根空字符串）
    const getSelfAndAncestors = (folderPath: string): string[] => {
      if (!folderPath) return []
      const parts = folderPath.split('/')
      const list: string[] = []
      for (let i = parts.length; i >= 1; i--) {
        list.push(parts.slice(0, i).join('/'))
      }
      return list
    }

    // 初始化文件夹进度
    const folderProgress: Record<
      string,
      {
        completedFiles: number
        totalFiles: number
        completedChunks: number
        totalChunks: number
      }
    > = {}

    for (const folder in folderGroups) {
      // 自身初始化
      folderProgress[folder] = {
        completedFiles: 0,
        totalFiles: folderGroups[folder].length,
        completedChunks: 0,
        totalChunks: 0, // 将在处理时更新
      }
      // 确保父级节点存在（用于汇总显示）
      for (const anc of getSelfAndAncestors(folder).slice(1)) {
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

    const textSplitter = RecursiveCharacterTextSplitter.fromLanguage(
      'markdown',
      {
        chunkSize: options.chunkSize,
        // TODO: Evaluate token-based chunking when performance is acceptable.
      },
    )

    const failedFiles: { path: string; error: string }[] = []
    let completedFilesCount = 0

    // 处理文件并生成待嵌入的 chunks（增量模式下仅包含变更 chunk）
    const contentChunks: Omit<InsertEmbedding, 'model' | 'dimension'>[] = []

    // 创建让步控制器，每处理 10 个文件让步一次给主线程
    const maybeYield = createYieldController(10)

    for (const file of filesToIndex) {
      // 检查是否被取消
      if (signal?.aborted) {
        // 保存已完成的工作后退出
        await this.requestSave()
        throw new DOMException('Indexing cancelled by user', 'AbortError')
      }

      // 让步给主线程，防止 UI 冻结
      await maybeYield()

      const currentFolder = file.path.includes('/')
        ? file.path.substring(0, file.path.lastIndexOf('/'))
        : ''

      // 更新当前处理的文件和文件夹
      updateProgress?.({
        completedChunks: 0,
        totalChunks: 0, // 将在后面更新
        totalFiles: filesToIndex.length,
        completedFiles: completedFilesCount,
        currentFile: file.path,
        currentFolder: currentFolder,
        folderProgress: folderProgress,
        newFilesCount,
        updatedFilesCount,
        removedFilesCount,
      })

      try {
        const { chunks: fileChunks, totalChunkLines } =
          await this.collectChunksForFile(
            file,
            textSplitter,
            embeddingModel,
            Boolean(options.reindexAll),
            stagingModelId,
            stagingFingerprints?.get(file.path),
          )

        contentChunks.push(...fileChunks)

        // 更新文件夹进度（自身 + 父级聚合）
        folderProgress[currentFolder].completedFiles++
        folderProgress[currentFolder].totalChunks += totalChunkLines
        for (const anc of getSelfAndAncestors(currentFolder).slice(1)) {
          if (folderProgress[anc]) {
            folderProgress[anc].totalChunks += totalChunkLines
          }
        }
        completedFilesCount++
      } catch (error) {
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
        {
          showReportBugButton: true,
        },
      ).open()
    }

    if (contentChunks.length === 0) {
      if (completedFilesCount > 0) {
        if (stagingModelId) {
          await this.promoteStagingModel(embeddingModel.id, stagingModelId)
        } else {
          await this.requestSave()
        }
        return
      }
      if (stagingModelId) {
        await this.requestSave()
        throw new Error(
          'All files failed to process. Stopping indexing process.',
        )
      }
      const hasExistingVectors =
        await this.repository.hasVectorsForModel(embeddingModel)
      if (!hasExistingVectors) {
        throw new Error(
          'All files failed to process. Stopping indexing process.',
        )
      }
      console.warn(
        '[YOLO] Vector indexing skipped because all pending files failed. Using existing embeddings.',
      )
      return
    }

    // 初始进度更新，包含文件夹信息
    updateProgress?.({
      completedChunks: resumedChunks,
      totalChunks: contentChunks.length + resumedChunks,
      totalFiles: filesToIndex.length,
      completedFiles: completedFilesCount,
      folderProgress: folderProgress,
      newFilesCount,
      updatedFilesCount,
      removedFilesCount,
    })

    let completedChunks = 0
    const embeddingFileBoundaries: Array<{ path: string; endChunk: number }> = []
    let embeddingFileCursor = 0
    let cumulativeChunks = 0
    let lastReportedEmbeddingFile: string | null = null

    for (const chunk of contentChunks) {
      cumulativeChunks += 1
      const lastBoundary =
        embeddingFileBoundaries[embeddingFileBoundaries.length - 1]
      if (lastBoundary && lastBoundary.path === chunk.path) {
        lastBoundary.endChunk = cumulativeChunks
      } else {
        embeddingFileBoundaries.push({
          path: chunk.path,
          endChunk: cumulativeChunks,
        })
      }
    }

    const failedChunks: {
      path: string
      metadata: VectorMetaData
      error: string
    }[] = []

    // 增量保存：降低整库 dump 频率（仍于 finally 再保存一次）
    const INCREMENTAL_SAVE_THRESHOLD = 1500
    let chunksSinceLastSave = 0

    const buildProgressPayload = ({
      currentFile,
      waitingForRateLimit,
    }: {
      currentFile?: string
      waitingForRateLimit?: boolean
    } = {}) => ({
      completedChunks: completedChunks + resumedChunks,
      totalChunks: contentChunks.length + resumedChunks,
      totalFiles: filesToIndex.length,
      completedFiles: completedFilesCount,
      folderProgress: folderProgress,
      newFilesCount,
      updatedFilesCount,
      removedFilesCount,
      ...(currentFile ? { currentFile } : {}),
      ...(typeof waitingForRateLimit === 'boolean'
        ? { waitingForRateLimit }
        : {}),
    })

    const getCurrentEmbeddingFile = () => {
      if (embeddingFileBoundaries.length === 0) {
        return undefined
      }
      while (
        embeddingFileCursor < embeddingFileBoundaries.length - 1 &&
        completedChunks > embeddingFileBoundaries[embeddingFileCursor].endChunk
      ) {
        embeddingFileCursor += 1
      }
      return embeddingFileBoundaries[embeddingFileCursor]?.path
    }

    const getNextReportedFile = () => {
      const currentFile = getCurrentEmbeddingFile()
      if (!currentFile || currentFile === lastReportedEmbeddingFile) {
        return undefined
      }
      lastReportedEmbeddingFile = currentFile
      return currentFile
    }

    let currentBatchSize = 24
    const MIN_BATCH_SIZE = 10
    const MAX_BATCH_SIZE = 24
    let shouldPromoteStaging = false
    const embedBatchChunk = async (
      chunk: Omit<InsertEmbedding, 'model' | 'dimension'>,
    ): Promise<InsertEmbedding | null> => {
      if (signal?.aborted) {
        return null
      }

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
            const currentFile = getNextReportedFile()

            updateProgress?.(buildProgressPayload({ currentFile }))

            return {
              path: chunk.path,
              mtime: chunk.mtime,
              content: chunk.content,
              content_hash: chunk.content_hash,
              model: targetModelId,
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
              if (signal?.aborted) {
                return false
              }
              if (!isTransientRagIndexError(error)) {
                return false
              }
              const status =
                typeof error === 'object' &&
                error !== null &&
                'status' in error &&
                typeof (error as { status?: unknown }).status === 'number'
                  ? (error as { status: number }).status
                  : undefined
              const message =
                error instanceof Error ? error.message.toLowerCase() : ''
              const waitingForRateLimit =
                status === 429 || message.includes('rate limit')
              if (waitingForRateLimit) {
                const currentFile = getCurrentEmbeddingFile() ?? chunk.path
                lastReportedEmbeddingFile = currentFile
                updateProgress?.(
                  buildProgressPayload({
                    currentFile,
                    waitingForRateLimit: true,
                  }),
                )
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
        batchStart < contentChunks.length;
        batchStart += currentBatchSize
      ) {
        const batchChunk = contentChunks.slice(
          batchStart,
          batchStart + currentBatchSize,
        )
        // 检查是否被取消
        if (signal?.aborted) {
          // 保存已完成的工作后退出
          await this.requestSave()
          throw new DOMException('Indexing cancelled by user', 'AbortError')
        }

        // 每个批次开始前让步给主线程，防止 UI 冻结
        await yieldToMain()
        let validEmbeddingChunks: InsertEmbedding[] = []
        let batchAttempt = 0

        while (batchAttempt < 2) {
          batchAttempt += 1
          const embeddingChunks = await Promise.all(
            batchChunk.map((chunk) => embedBatchChunk(chunk)),
          )
          validEmbeddingChunks = embeddingChunks.filter(
            (chunk): chunk is InsertEmbedding => chunk !== null,
          )
          if (validEmbeddingChunks.length > 0) {
            if (
              validEmbeddingChunks.length !== batchChunk.length &&
              currentBatchSize > MIN_BATCH_SIZE
            ) {
              currentBatchSize = Math.max(
                MIN_BATCH_SIZE,
                Math.floor(currentBatchSize / 2),
              )
            } else if (
              validEmbeddingChunks.length === batchChunk.length &&
              currentBatchSize < MAX_BATCH_SIZE
            ) {
              currentBatchSize = Math.min(MAX_BATCH_SIZE, currentBatchSize + 4)
            }
            break
          }
          if (batchAttempt < 2) {
            currentBatchSize = Math.max(
              MIN_BATCH_SIZE,
              Math.floor(currentBatchSize / 2),
            )
            await yieldToMain()
          }
        }

        // 如果是因为取消导致的，保存已完成的工作并退出
        if (signal?.aborted) {
          if (validEmbeddingChunks.length > 0) {
            await this.repository.insertVectors(validEmbeddingChunks)
          }
          await this.requestSave()
          throw new DOMException('Indexing cancelled by user', 'AbortError')
        }

        // If all chunks in this batch failed, stop processing
        if (validEmbeddingChunks.length === 0 && batchChunk.length > 0) {
          throw new Error(
            'All chunks in batch failed to embed. Stopping indexing process.',
          )
        }
        await this.repository.insertVectors(validEmbeddingChunks)

        // 增量保存检查：每处理一定数量的 chunks 后保存，防止中断时丢失进度
        chunksSinceLastSave += validEmbeddingChunks.length
        if (chunksSinceLastSave >= INCREMENTAL_SAVE_THRESHOLD) {
          await this.requestSave()
          chunksSinceLastSave = 0
        }

        // 更新文件夹的 chunk 完成进度（全局 completedChunks 已在获取 embedding 时逐个增加）
        // 更新每个文件夹的 chunk 完成进度
        for (const chunk of validEmbeddingChunks) {
          const folderPath = chunk.path.includes('/')
            ? chunk.path.substring(0, chunk.path.lastIndexOf('/'))
            : ''
          const lineage = getSelfAndAncestors(folderPath)
          if (folderProgress[folderPath]) {
            folderProgress[folderPath].completedChunks++
          }
          for (const anc of lineage.slice(1)) {
            if (folderProgress[anc]) {
              folderProgress[anc].completedChunks++
            }
          }
        }

        // 更新进度
        updateProgress?.(buildProgressPayload({ waitingForRateLimit: false }))

        batchStart += batchChunk.length - currentBatchSize
      }
      shouldPromoteStaging = Boolean(stagingModelId)
    } catch (error) {
      // 如果是用户取消操作，直接重新抛出，不显示错误弹窗
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }

      if (
        error instanceof LLMAPIKeyNotSetException ||
        error instanceof LLMAPIKeyInvalidException ||
        error instanceof LLMBaseUrlNotSetException
      ) {
        new ErrorModal(this.app, 'Error', (error as Error).message, undefined, {
          showSettingsButton: true,
        }).open()
      } else {
        const errorDetails =
          `Failed to process ${failedChunks.length} file(s):\n\n` +
          failedChunks
            .map((chunk) => `File: ${chunk.path}\nError: ${chunk.error}`)
            .join('\n\n')

        new ErrorModal(
          this.app,
          'Error: embedding failed',
          `The indexing process was interrupted because several files couldn't be processed.
Please report this issue to the developer if it persists.`,
          `[Error Log]\n\n${errorDetails}`,
          {
            showReportBugButton: true,
          },
        ).open()
      }
      // 重新抛出错误，让调用方知道索引失败了
      throw error
    } finally {
      await this.requestSave()
    }

    if (shouldPromoteStaging && stagingModelId) {
      await this.promoteStagingModel(embeddingModel.id, stagingModelId)
    }
  }

  async clearAllVectors(embeddingModel: EmbeddingModelClient) {
    await this.repository.clearAllVectors(embeddingModel)
    await this.requestVacuum()
    await this.requestSave()
  }

  async clearVectorsByModelIds(modelIds: string[]) {
    await this.repository.clearVectorsByModelIds(modelIds)
    await this.requestVacuum()
    await this.requestSave()
  }

  /**
   * 全量：为每个 chunk 计算 content_hash 并全部嵌入。
   * 增量：按行范围 + hash 跳过未变 chunk，仅删除/更新必要行。
   */
  private async collectChunksForFile(
    file: TFile,
    textSplitter: RecursiveCharacterTextSplitter,
    embeddingModel: EmbeddingModelClient,
    reindexAll: boolean,
    stagingModelId?: string | null,
    stagedFingerprints?: Set<string>,
  ): Promise<{
    chunks: Omit<InsertEmbedding, 'model' | 'dimension'>[]
    totalChunkLines: number
  }> {
    const fileContent = await this.app.vault.cachedRead(file)
    const sanitizedContent = fileContent.split('\u0000').join('')
    const fileDocuments = await textSplitter.createDocuments([sanitizedContent])

    if (reindexAll) {
      const desiredFingerprints: string[] = []
      const chunks: Omit<InsertEmbedding, 'model' | 'dimension'>[] = []
      for (const chunk of fileDocuments) {
        const content = chunk.pageContent
        const startLine = chunk.metadata.loc.lines.from as number
        const endLine = chunk.metadata.loc.lines.to as number
        const content_hash = await sha256HexPrefix16(content)
        desiredFingerprints.push(`${startLine}:${endLine}:${content_hash}`)
        // Resumed rebuilds must remove stale staging chunks for this file before
        // promoting, otherwise outdated rows leak into active on success.
        // Do this after we know the file's full current fingerprint set.
        //
        // The delete runs once per file because the full fingerprint set is only
        // known after chunking.
        // Resumable rebuild: skip chunks already embedded into staging from
        // a prior attempt (matched by line range + content hash).
        if (stagedFingerprints?.has(`${startLine}:${endLine}:${content_hash}`)) {
          continue
        }
        chunks.push({
          path: file.path,
          mtime: file.stat.mtime,
          content,
          content_hash,
          metadata: { startLine, endLine },
        })
      }
      if (stagingModelId) {
        await this.repository.deleteStagingRowsForFileExceptFingerprints(
          stagingModelId,
          file.path,
          desiredFingerprints,
        )
      }
      return { chunks, totalChunkLines: chunks.length }
    }

    const existing = await this.repository.getChunkMetaForFile(
      file.path,
      embeddingModel,
    )
    const existingByLine = new Map<
      string,
      Awaited<ReturnType<VectorRepository['getChunkMetaForFile']>>[0]
    >()
    for (const row of existing) {
      const k = `${row.metadata.startLine}:${row.metadata.endLine}`
      existingByLine.set(k, row)
    }

    const existingByHash = new Map<
      string,
      Awaited<ReturnType<VectorRepository['getChunkMetaForFile']>>
    >()
    for (const row of existing) {
      const rowHash = row.content_hash ?? (await sha256HexPrefix16(row.content))
      const bucket = existingByHash.get(rowHash) ?? []
      bucket.push(row)
      existingByHash.set(rowHash, bucket)
    }

    const idsToDelete: number[] = []
    const idsMtimeOnly: number[] = []
    const chunks: Omit<InsertEmbedding, 'model' | 'dimension'>[] = []
    const reusedIds = new Set<number>()

    for (const chunk of fileDocuments) {
      const content = chunk.pageContent
      const startLine = chunk.metadata.loc.lines.from as number
      const endLine = chunk.metadata.loc.lines.to as number
      const key = `${startLine}:${endLine}`
      const content_hash = await sha256HexPrefix16(content)
      const prev = existingByLine.get(key)
      if (
        prev &&
        (prev.content_hash ?? (await sha256HexPrefix16(prev.content))) ===
          content_hash &&
        !reusedIds.has(prev.id)
      ) {
        idsMtimeOnly.push(prev.id)
        reusedIds.add(prev.id)
        continue
      }
      const reusableByHash = (existingByHash.get(content_hash) ?? []).find(
        (row) => !reusedIds.has(row.id),
      )
      if (reusableByHash) {
        if (prev && prev.id !== reusableByHash.id && !reusedIds.has(prev.id)) {
          idsToDelete.push(prev.id)
        }
        await this.repository.updateVectorMetadataById(reusableByHash.id, {
          mtime: file.stat.mtime,
          metadata: { startLine, endLine },
        })
        reusedIds.add(reusableByHash.id)
        continue
      }
      if (prev) {
        idsToDelete.push(prev.id)
      }
      chunks.push({
        path: file.path,
        mtime: file.stat.mtime,
        content,
        content_hash,
        metadata: { startLine, endLine },
      })
    }

    for (const row of existing) {
      if (!reusedIds.has(row.id)) {
        idsToDelete.push(row.id)
      }
    }

    await this.repository.deleteVectorsByIds([...new Set(idsToDelete)])
    await this.repository.updateVectorsMtimeByIds(
      idsMtimeOnly,
      file.stat.mtime,
    )

    return { chunks, totalChunkLines: fileDocuments.length }
  }

  private async deleteVectorsForDeletedFiles(
    embeddingModel: EmbeddingModelClient,
  ) {
    const indexedFilePaths =
      await this.repository.getIndexedFilePaths(embeddingModel)
    const deletedPaths = indexedFilePaths.filter(
      (filePath) => !this.app.vault.getAbstractFileByPath(filePath),
    )
    if (deletedPaths.length > 0) {
      await this.repository.deleteVectorsForMultipleFiles(
        deletedPaths,
        embeddingModel,
      )
    }
  }

  /**
   * 获取过滤后的 Markdown 文件列表
   * 应用 include/exclude 模式过滤
   */
  private getFilteredMarkdownFiles(
    excludePatterns: string[],
    includePatterns: string[],
  ): TFile[] {
    let files = this.app.vault.getMarkdownFiles()

    files = files.filter((file) => {
      return !excludePatterns.some((pattern) => minimatch(file.path, pattern))
    })

    if (includePatterns.length > 0) {
      files = files.filter((file) => {
        return includePatterns.some((pattern) => minimatch(file.path, pattern))
      })
    }

    return files
  }

  /**
   * 获取需要索引的文件，同时返回新文件和更新文件的统计
   * 使用批量查询优化，避免 N+1 查询问题
   */
  private async getFilesToIndexWithStats({
    embeddingModel,
    excludePatterns,
    includePatterns,
  }: {
    embeddingModel: EmbeddingModelClient
    excludePatterns: string[]
    includePatterns: string[]
  }): Promise<{ files: TFile[]; newCount: number; updatedCount: number }> {
    const allFiles = this.getFilteredMarkdownFiles(
      excludePatterns,
      includePatterns,
    )

    // 批量查询所有已索引文件的 mtime，一次数据库查询替代 N 次查询
    const mtimeMap = await this.repository.getFileMtimes(embeddingModel)

    const filesToIndex: TFile[] = []
    let newCount = 0
    let updatedCount = 0

    // 创建让步控制器，每检查 50 个文件让步一次
    const maybeYield = createYieldController(50)

    for (const file of allFiles) {
      await maybeYield()

      const existingMtime = mtimeMap.get(file.path)

      if (existingMtime === undefined) {
        // 新文件：未被索引过
        const fileContent = await this.app.vault.cachedRead(file)
        if (fileContent.length > 0) {
          filesToIndex.push(file)
          newCount++
        }
      } else if (file.stat.mtime > existingMtime) {
        // 更新的文件：mtime 比索引时更新
        filesToIndex.push(file)
        updatedCount++
      }
      // 否则文件未变化，跳过
    }

    return { files: filesToIndex, newCount, updatedCount }
  }

  async getEmbeddingStats(): Promise<EmbeddingDbStats[]> {
    return await this.repository.getEmbeddingStats()
  }
}
