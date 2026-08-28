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

export type RagQueryResult = VectorSelect & {
  similarity: number
}

/**
 * `findSimilarChunks`' output: the ranked chunks plus the knowledge base's
 * background similarity, which is what turns a raw cosine into a statement
 * about strength. `baseline` is `null` only for an index too small to sample.
 */
export type SimilarChunkResults = {
  rows: RagQueryResult[]
  baseline: { mean: number; std: number } | null
}

/**
 * Identifies one chunk's position for dedup purposes: PDF rows carry a page
 * number in addition to (and distinct from) their `startLine`/`endLine` —
 * two different chunks on the same PDF page share a page number but not a
 * line range, so the key must include all three or same-page chunks would
 * collide. Exported for `mergeRagQueryResults` (cross-knowledge-base merge)
 * to reuse the identical key on raw rows, before any display-mapping step
 * collapses `page` into `startLine`/`endLine` (see `vaultSearchService.ts`'s
 * `mapRagRowsToSuper`, which does exactly that for the UI-facing shape).
 */
export const ragChunkKey = (row: {
  path: string
  metadata: { page?: number; startLine: number; endLine: number }
}): string =>
  `${row.path}:${row.metadata.page ?? ''}:${row.metadata.startLine}:${row.metadata.endLine}`

export const dedupeRagQueryResults = (
  rows: RagQueryResult[],
): RagQueryResult[] => {
  const deduped = new Map<string, RagQueryResult>()

  for (const row of rows) {
    const key = ragChunkKey(row)
    const existing = deduped.get(key)
    if (!existing || row.similarity > existing.similarity) {
      deduped.set(key, row)
    }
  }

  return [...deduped.values()]
}

/**
 * Averages a file's chunk vectors into one document vector. Stored chunk
 * vectors are already L2-normalized, and the similarity search normalizes
 * whatever query vector it is handed, so no normalization is needed here.
 *
 * Returns `null` for an empty input or for rows whose dimensions disagree —
 * the latter means the stored rows predate a model/dimension change, and
 * pooling them would produce a vector the search would reject anyway.
 */
export function meanPoolVectors(
  vectors: readonly Float32Array[],
): number[] | null {
  const first = vectors[0]
  if (!first) return null
  const dimension = first.length
  if (dimension === 0) return null
  const pooled = new Array<number>(dimension).fill(0)
  for (const vector of vectors) {
    if (vector.length !== dimension) return null
    for (let i = 0; i < dimension; i++) {
      pooled[i] += vector[i]
    }
  }
  for (let i = 0; i < dimension; i++) {
    pooled[i] /= vectors.length
  }
  return pooled
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

  /**
   * Tears down the embedding model's live session (if any) without
   * invalidating this engine — unlike `cleanup()`, the engine stays usable
   * for a later index run or query. Called after an aborted/cancelled
   * index run so a heavy local model doesn't idle at full memory for the
   * rest of its idle-teardown window. No-op for remote providers.
   */
  async releaseEmbeddingIdleSession(): Promise<void> {
    await this.embeddingModel?.releaseIdleSession?.()
  }

  cleanup() {
    // Local embedding clients hold a live Worker session + runtime-component
    // lease (`core/rag/local-embedding/client.ts`); release it immediately
    // rather than leaving it to its own idle timeout. Remote provider
    // clients have no `dispose` and this is a no-op for them.
    void this.embeddingModel?.dispose?.()
    this.embeddingModel = null
    this.vectorManager = null
  }

  // TODO: use addSettingsChangeListener
  setSettings(settings: YoloSettings) {
    this.settings = settings
    const previousEmbeddingModel = this.embeddingModel
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
    // See `cleanup()` — every settings save recreates the client (it's
    // stateless config, cheap for remote providers), so the previous one's
    // session (if any) must be released here too, not just on engine
    // teardown.
    void previousEmbeddingModel?.dispose?.()
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
        settings: this.settings,
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

  /**
   * "Notes similar to this one", without embedding anything: the file's own
   * chunk vectors are already in this knowledge base, so they are mean-pooled
   * into a single document vector and used as the query. The source file is
   * excluded from its own results.
   *
   * Returns `null` when this knowledge base holds no vectors for `path` —
   * the file is outside its scope, or not indexed yet. That is a distinct
   * outcome from "indexed but nothing similar" (an empty array), and the
   * panel shows different states for the two.
   */
  async findSimilarChunks({
    path,
    limit,
    minSimilarity,
  }: {
    path: string
    limit: number
    minSimilarity: number
  }): Promise<SimilarChunkResults | null> {
    if (!this.embeddingModel) {
      throw new Error('Embedding model is not set')
    }
    if (!this.vectorManager) {
      throw new Error('Vector manager is not set')
    }
    const chunkVectors = await this.vectorManager.listVectorsForPath(
      this.embeddingModel.id,
      path,
    )
    if (chunkVectors.length === 0) return null

    const documentVector = meanPoolVectors(chunkVectors)
    if (!documentVector) return null

    const rows = await this.vectorManager.performSimilaritySearch(
      documentVector,
      this.embeddingModel,
      {
        minSimilarity,
        limit,
        // The source note's own chunks are always its nearest neighbours;
        // `exclude` matches on the exact path (or a prefix segment), which is
        // what drops them here.
        scope: { files: [], folders: [], exclude: [path] },
      },
    )
    // The corpus baseline travels with the rows: a raw cosine says nothing on
    // its own — what "unrelated" scores differs per embedding model — so the
    // caller needs both to tell a strong match from a merely top-ranked one.
    const baseline = await this.vectorManager.getSimilarityBaseline(
      this.embeddingModel,
    )
    return { rows: dedupeRagQueryResults(rows), baseline }
  }

  private async getQueryEmbedding(query: string): Promise<number[]> {
    if (!this.embeddingModel) {
      throw new Error('Embedding model is not set')
    }
    return this.embeddingModel.getEmbedding(query, { kind: 'query' })
  }
}
