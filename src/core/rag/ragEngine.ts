import { App } from 'obsidian'

import { QueryProgressState } from '../../components/chat-view/QueryProgress'
import {
  ReconcileResult,
  VectorManager,
} from '../../database/modules/vector/VectorManager'
import {
  KnowledgeBase,
  YoloSettings,
} from '../../settings/schema/setting.types'
import { EmbeddingModelClient } from '../../types/embedding'
import type { VectorSelect } from '../runtime-components'

import { getEmbeddingModelClient } from './embedding'
import type { ReconcileScope } from './reconciler'

type RagQueryResult = VectorSelect & {
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
/** One instance per knowledge base — `kbId` selects both which vector store
 * this engine talks to (via the `VectorManager` passed in) and which
 * `KnowledgeBase.include`/`exclude` rules `updateVaultIndex` applies. The
 * engine re-reads its `KnowledgeBase` from current settings on every index
 * run rather than caching it, so an edit to a base's scope in the settings
 * UI takes effect on the next run without recreating the engine. */
export class RAGEngine {
  private app: App
  private settings: YoloSettings
  private readonly kbId: string
  private vectorManager: VectorManager | null = null
  private embeddingModel: EmbeddingModelClient | null = null
  private indexUpdateQueue: Promise<void> = Promise.resolve()

  constructor(
    app: App,
    settings: YoloSettings,
    vectorManager: VectorManager,
    kbId: string,
  ) {
    this.app = app
    this.settings = settings
    this.kbId = kbId
    this.vectorManager = vectorManager
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
  }

  getKnowledgeBaseId(): string {
    return this.kbId
  }

  private getKnowledgeBase(): KnowledgeBase {
    const kb = this.settings.knowledgeBases.find((k) => k.id === this.kbId)
    if (!kb) {
      throw new Error(`Knowledge base "${this.kbId}" no longer exists`)
    }
    return kb
  }

  cleanup() {
    this.embeddingModel = null
    this.vectorManager = null
  }

  // TODO: use addSettingsChangeListener
  setSettings(settings: YoloSettings) {
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
  ): Promise<ReconcileResult> {
    const run = async (): Promise<ReconcileResult> => {
      if (!this.embeddingModel) {
        throw new Error('Embedding model is not set')
      }
      if (!this.vectorManager) {
        throw new Error('Vector manager is not set')
      }
      const kb = this.getKnowledgeBase()
      return await this.vectorManager.reconcile(
        this.embeddingModel,
        {
          chunkSize: this.settings.ragOptions.chunkSize,
          include: kb.include,
          exclude: kb.exclude,
          indexPdf: this.settings.ragOptions.indexPdf ?? true,
          embeddingConcurrency: this.settings.ragOptions.embeddingConcurrency,
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
    return await queuedRun
  }

  /**
   * Cheap dry-run count of what a `sync` reconcile would touch — no
   * chunkify, no embed, no write. Backs the settings UI's "N 个待更新" pill
   * and per-card "N 个文件已修改" line; see
   * {@link VectorManager.countPendingChanges}.
   */
  async countPendingChanges(): Promise<{ changed: number; total: number }> {
    if (!this.vectorManager) {
      throw new Error('Vector manager is not set')
    }
    const kb = this.getKnowledgeBase()
    return await this.vectorManager.countPendingChanges(
      this.settings.embeddingModelId,
      {
        chunkSize: this.settings.ragOptions.chunkSize,
        include: kb.include,
        exclude: kb.exclude,
        indexPdf: this.settings.ragOptions.indexPdf ?? true,
      },
    )
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
      exclude?: string[]
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
