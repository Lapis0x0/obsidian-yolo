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
  LLMRateLimitExceededException,
} from '../../../core/llm/exception'
import {
  InsertEmbedding,
  SelectEmbedding,
  VectorMetaData,
} from '../../../database/schema'
import {
  EmbeddingDbStats,
  EmbeddingModelClient,
} from '../../../types/embedding'
import { chunkArray } from '../../../utils/common/chunk-array'
import {
  createYieldController,
  yieldToMain,
} from '../../../utils/common/yield-to-main'

import { VectorRepository } from './VectorRepository'

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

  async updateVaultIndex(
    embeddingModel: EmbeddingModelClient,
    options: {
      chunkSize: number
      excludePatterns: string[]
      includePatterns: string[]
      reindexAll?: boolean
    },
    updateProgress?: (indexProgress: IndexProgress) => void,
  ): Promise<void> {
    let filesToIndex: TFile[]
    let newFilesCount = 0
    let updatedFilesCount = 0
    const removedFilesCount = 0

    if (options.reindexAll) {
      filesToIndex = this.getFilteredMarkdownFiles(
        options.excludePatterns,
        options.includePatterns,
      )
      await this.repository.clearAllVectors(embeddingModel)
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

      // 批量删除需要重新索引的文件的向量
      if (filesToIndex.length > 0) {
        await this.repository.deleteVectorsForMultipleFiles(
          filesToIndex.map((file) => file.path),
          embeddingModel,
        )
      }
    }

    if (filesToIndex.length === 0) {
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
        // TODO: Use token-based chunking after migrating to WebAssembly-based tiktoken
        // Current token counting method is too slow for practical use
        // lengthFunction: async (text) => {
        //   return await tokenCount(text)
        // },
      },
    )

    const failedFiles: { path: string; error: string }[] = []
    let completedFilesCount = 0

    // 处理文件并生成chunks
    const contentChunks: Omit<InsertEmbedding, 'model' | 'dimension'>[] = []

    // 创建让步控制器，每处理 10 个文件让步一次给主线程
    const maybeYield = createYieldController(10)

    for (const file of filesToIndex) {
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
        const fileContent = await this.app.vault.cachedRead(file)
        // Remove null bytes from the content
        const sanitizedContent = fileContent.split('\u0000').join('')

        const fileDocuments = await textSplitter.createDocuments([
          sanitizedContent,
        ])

        const fileChunks = fileDocuments.map(
          (chunk): Omit<InsertEmbedding, 'model' | 'dimension'> => {
            return {
              path: file.path,
              mtime: file.stat.mtime,
              content: chunk.pageContent,
              metadata: {
                startLine: chunk.metadata.loc.lines.from as number,
                endLine: chunk.metadata.loc.lines.to as number,
              },
            }
          },
        )

        contentChunks.push(...fileChunks)

        // 更新文件夹进度（自身 + 父级聚合）
        folderProgress[currentFolder].completedFiles++
        folderProgress[currentFolder].totalChunks += fileChunks.length
        for (const anc of getSelfAndAncestors(currentFolder).slice(1)) {
          if (folderProgress[anc]) {
            folderProgress[anc].totalChunks += fileChunks.length
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
      const hasExistingVectors =
        await this.repository.hasVectorsForModel(embeddingModel)
      if (!hasExistingVectors) {
        throw new Error(
          'All files failed to process. Stopping indexing process.',
        )
      }
      console.warn(
        '[Smart Composer] Vector indexing skipped because all pending files failed. Using existing embeddings.',
      )
      return
    }

    // 初始进度更新，包含文件夹信息
    updateProgress?.({
      completedChunks: 0,
      totalChunks: contentChunks.length,
      totalFiles: filesToIndex.length,
      completedFiles: completedFilesCount,
      folderProgress: folderProgress,
      newFilesCount,
      updatedFilesCount,
      removedFilesCount,
    })

    let completedChunks = 0
    const batchChunks = chunkArray(contentChunks, 100)
    const failedChunks: {
      path: string
      metadata: VectorMetaData
      error: string
    }[] = []

    try {
      for (const batchChunk of batchChunks) {
        // 每个批次开始前让步给主线程，防止 UI 冻结
        await yieldToMain()

        const embeddingChunks: (InsertEmbedding | null)[] = await Promise.all(
          batchChunk.map(async (chunk) => {
            try {
              return await backOff(
                async () => {
                  if (chunk.content.length === 0) {
                    throw new Error(
                      `Chunk content is empty in file: ${chunk.path}`,
                    )
                  }
                  if (chunk.content.includes('\x00')) {
                    // this should never happen because we remove null bytes from the content
                    throw new Error(
                      `Chunk content contains null bytes in file: ${chunk.path}`,
                    )
                  }

                  const embedding = await embeddingModel.getEmbedding(
                    chunk.content,
                  )
                  completedChunks += 1

                  updateProgress?.({
                    completedChunks,
                    totalChunks: contentChunks.length,
                    totalFiles: filesToIndex.length,
                    completedFiles: completedFilesCount,
                    folderProgress: folderProgress,
                    newFilesCount,
                    updatedFilesCount,
                    removedFilesCount,
                  })

                  return {
                    path: chunk.path,
                    mtime: chunk.mtime,
                    content: chunk.content,
                    model: embeddingModel.id,
                    dimension: embeddingModel.dimension,
                    embedding,
                    metadata: chunk.metadata,
                  }
                },
                {
                  numOfAttempts: 8,
                  startingDelay: 2000,
                  timeMultiple: 2,
                  maxDelay: 60000,
                  retry: (error) => {
                    if (
                      error instanceof LLMRateLimitExceededException ||
                      error.status === 429
                    ) {
                      updateProgress?.({
                        completedChunks,
                        totalChunks: contentChunks.length,
                        totalFiles: filesToIndex.length,
                        completedFiles: completedFilesCount,
                        folderProgress: folderProgress,
                        newFilesCount,
                        updatedFilesCount,
                        removedFilesCount,
                        waitingForRateLimit: true,
                      })
                      return true
                    }
                    return false
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
          }),
        )

        const validEmbeddingChunks = embeddingChunks.filter(
          (chunk) => chunk !== null,
        )
        // If all chunks in this batch failed, stop processing
        if (validEmbeddingChunks.length === 0 && batchChunk.length > 0) {
          throw new Error(
            'All chunks in batch failed to embed. Stopping indexing process.',
          )
        }
        await this.repository.insertVectors(validEmbeddingChunks)

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
        updateProgress?.({
          completedChunks,
          totalChunks: contentChunks.length,
          totalFiles: filesToIndex.length,
          completedFiles: completedFilesCount,
          folderProgress: folderProgress,
          newFilesCount,
          updatedFilesCount,
          removedFilesCount,
          waitingForRateLimit: false,
        })
      }
    } catch (error) {
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
    } finally {
      await this.requestSave()
    }
  }

  async clearAllVectors(embeddingModel: EmbeddingModelClient) {
    await this.repository.clearAllVectors(embeddingModel)
    await this.requestVacuum()
    await this.requestSave()
  }

  private async deleteVectorsForDeletedFiles(
    embeddingModel: EmbeddingModelClient,
  ) {
    const indexedFilePaths =
      await this.repository.getIndexedFilePaths(embeddingModel)
    for (const filePath of indexedFilePaths) {
      if (!this.app.vault.getAbstractFileByPath(filePath)) {
        await this.repository.deleteVectorsForMultipleFiles(
          [filePath],
          embeddingModel,
        )
      }
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
