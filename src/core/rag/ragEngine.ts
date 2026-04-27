import { App } from 'obsidian'

import { QueryProgressState } from '../../components/chat-view/QueryProgress'
import { VectorManager } from '../../database/modules/vector/VectorManager'
import { SelectEmbedding } from '../../database/schema'
import { SmartComposerSettings } from '../../settings/schema/setting.types'
import { EmbeddingModelClient } from '../../types/embedding'

import { getEmbeddingModelClient } from './embedding'
import type { ReconcileScope } from './reconciler'

type RagQueryResult = Omit<SelectEmbedding, 'embedding'> & {
  similarity: number
}

export const dedupeRagQueryResults = (
  rows: RagQueryResult[],
): RagQueryResult[] => {
  const deduped = new Map<string, RagQueryResult>()

  for (const row of rows) {
    const key = `${row.path}:${row.metadata.page ?? ''}:${row.metadata.startLine}:${row.metadata.endLine}`
    const existing = deduped.get(key)
    if (!existing || row.similarity > existing.similarity) {
      deduped.set(key, row)
    }
  }

  return [...deduped.values()]
}

// TODO: do we really need this class? It seems like unnecessary abstraction.
export class RAGEngine {
  private app: App
  private settings: SmartComposerSettings
  private vectorManager: VectorManager | null = null
  private embeddingModel: EmbeddingModelClient | null = null
  private indexUpdateQueue: Promise<void> = Promise.resolve()

  constructor(
    app: App,
    settings: SmartComposerSettings,
    vectorManager: VectorManager,
  ) {
    this.app = app
    this.settings = settings
    this.vectorManager = vectorManager
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
  }

  cleanup() {
    this.embeddingModel = null
    this.vectorManager = null
  }

  // TODO: use addSettingsChangeListener
  setSettings(settings: SmartComposerSettings) {
    this.settings = settings
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
  }

  /**
   * Reconcile the vault index against the current settings. The single
   * write entrypoint for indexing — see {@link VectorManager.reconcile}.
   *
   * - `truncate: true, scope: { kind: 'all' }` → "rebuild from scratch"
   * - `truncate: false, scope: { kind: 'all' }` → "sync after settings change"
   * - `truncate: false, scope: { kind: 'paths', paths }` → "sync changed files"
   */
  async updateVaultIndex(
    options: {
      scope: ReconcileScope
      truncate?: boolean
      signal?: AbortSignal
    },
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void,
  ): Promise<void> {
    const run = async () => {
      if (!this.embeddingModel) {
        throw new Error('Embedding model is not set')
      }
      await this.vectorManager?.reconcile(
        this.embeddingModel,
        {
          chunkSize: this.settings.ragOptions.chunkSize,
          excludePatterns: this.settings.ragOptions.excludePatterns,
          includePatterns: this.settings.ragOptions.includePatterns,
          indexPdf: this.settings.ragOptions.indexPdf ?? true,
          settings: this.settings,
        },
        {
          scope: options.scope,
          truncate: options.truncate,
          signal: options.signal,
          onProgress: (indexProgress) => {
            onQueryProgressChange?.({
              type: 'indexing',
              indexProgress,
            })
          },
        },
      )
    }

    const queuedRun = this.indexUpdateQueue.catch(() => undefined).then(run)
    this.indexUpdateQueue = queuedRun.then(
      () => undefined,
      () => undefined,
    )
    await queuedRun
  }

  async processQuery({
    query,
    scope,
    minSimilarity: minSimilarityOverride,
    limit: limitOverride,
    onQueryProgressChange,
  }: {
    query: string
    scope?: {
      files: string[]
      folders: string[]
    }
    /** Override settings.ragOptions.minSimilarity when set */
    minSimilarity?: number
    /** Override settings.ragOptions.limit when set */
    limit?: number
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void
  }): Promise<RagQueryResult[]> {
    if (!this.embeddingModel) {
      throw new Error('Embedding model is not set')
    }
    // Index updates are handled by RagAutoUpdateService (vault events), manual
    // re-index commands, and settings UI — not on every query — to keep search fast.
    const queryEmbedding = await this.getQueryEmbedding(query)
    onQueryProgressChange?.({
      type: 'querying',
    })
    const queryResult =
      (await this.vectorManager?.performSimilaritySearch(
        queryEmbedding,
        this.embeddingModel,
        {
          minSimilarity:
            minSimilarityOverride ?? this.settings.ragOptions.minSimilarity,
          limit: limitOverride ?? this.settings.ragOptions.limit,
          scope,
        },
      )) ?? []
    const dedupedQueryResult = dedupeRagQueryResults(queryResult)
    onQueryProgressChange?.({
      type: 'querying-done',
      queryResult: dedupedQueryResult,
    })
    return dedupedQueryResult
  }

  private async getQueryEmbedding(query: string): Promise<number[]> {
    if (!this.embeddingModel) {
      throw new Error('Embedding model is not set')
    }
    return this.embeddingModel.getEmbedding(query)
  }
}
