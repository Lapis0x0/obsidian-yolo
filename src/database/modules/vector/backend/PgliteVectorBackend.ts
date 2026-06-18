import {
  SQL,
  and,
  cosineDistance,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  like,
  or,
  sql,
  sum,
} from 'drizzle-orm'
import { PgliteDatabase } from 'drizzle-orm/pglite'
import { App } from 'obsidian'

import {
  EmbeddingDbStats,
  EmbeddingModelClient,
} from '../../../../types/embedding'
import { DatabaseNotInitializedException } from '../../../exception'
import { InsertEmbedding, SelectEmbedding, embeddingTable } from '../../../schema'

import {
  SimilaritySearchOptions,
  VectorBackend,
  VectorVacuumMode,
  VectorChunkRow,
} from './VectorBackend'

export class PgliteVectorBackend implements VectorBackend {
  readonly kind = 'pglite' as const

  constructor(
    private readonly _app: App,
    private readonly db: PgliteDatabase | null,
  ) {}

  async getFileMtimes(modelId: string): Promise<Map<string, number>> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }

    const results = await this.db
      .select({
        path: embeddingTable.path,
        mtime: embeddingTable.mtime,
      })
      .from(embeddingTable)
      .where(eq(embeddingTable.model, modelId))
      .groupBy(embeddingTable.path, embeddingTable.mtime)

    const mtimeMap = new Map<string, number>()
    for (const row of results) {
      const mtime = Number(row.mtime)
      const existing = mtimeMap.get(row.path)
      if (existing === undefined || mtime > existing) {
        mtimeMap.set(row.path, mtime)
      }
    }
    return mtimeMap
  }

  async listChunksForPaths(
    modelId: string,
    paths: string[],
  ): Promise<VectorChunkRow[]> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (paths.length === 0) return []
    return this.db
      .select({
        id: embeddingTable.id,
        path: embeddingTable.path,
        mtime: embeddingTable.mtime,
        content_hash: embeddingTable.content_hash,
        metadata: embeddingTable.metadata,
      })
      .from(embeddingTable)
      .where(
        and(
          eq(embeddingTable.model, modelId),
          inArray(embeddingTable.path, paths),
        ),
      )
  }

  async deleteVectorsByIds(ids: number[]): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (ids.length === 0) return
    await this.db.delete(embeddingTable).where(inArray(embeddingTable.id, ids))
  }

  async deleteVectorsByPaths(modelId: string, paths: string[]): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (paths.length === 0) return
    await this.db
      .delete(embeddingTable)
      .where(
        and(
          eq(embeddingTable.model, modelId),
          inArray(embeddingTable.path, paths),
        ),
      )
  }

  async bumpMtimeByIds(
    updates: Array<{ id: number; mtime: number }>,
  ): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (updates.length === 0) return
    const groups = new Map<number, number[]>()
    for (const update of updates) {
      const bucket = groups.get(update.mtime)
      if (bucket) bucket.push(update.id)
      else groups.set(update.mtime, [update.id])
    }
    for (const [mtime, ids] of groups) {
      await this.db
        .update(embeddingTable)
        .set({ mtime })
        .where(inArray(embeddingTable.id, ids))
    }
  }

  async insertVectors(data: InsertEmbedding[]): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (data.length === 0) return
    await this.db.insert(embeddingTable).values(data)
  }

  async truncateModel(modelId: string): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    await this.db
      .delete(embeddingTable)
      .where(eq(embeddingTable.model, modelId))
  }

  async clearVectorsByModelIds(modelIds: string[]): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (modelIds.length === 0) return
    await this.db
      .delete(embeddingTable)
      .where(inArray(embeddingTable.model, modelIds))
  }

  async vacuum(_mode: VectorVacuumMode = 'light'): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    const dbWithClient = this.db as PgliteDatabase & {
      $client?: { exec: (rawSql: string) => Promise<unknown> }
    }
    await dbWithClient.$client?.exec('VACUUM FULL;')
  }

  async performSimilaritySearch(
    queryVector: number[],
    embeddingModel: EmbeddingModelClient,
    options: SimilaritySearchOptions,
  ): Promise<
    (Omit<SelectEmbedding, 'embedding'> & {
      similarity: number
    })[]
  > {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    const dbWithClient = this.db as PgliteDatabase & {
      $client?: { exec: (rawSql: string) => Promise<unknown> }
    }
    await dbWithClient.$client?.exec('SET hnsw.ef_search = 100')

    const similarity =
      sql<number>`1 - (${cosineDistance(embeddingTable.embedding, queryVector)})`
    const similarityCondition = gt(similarity, options.minSimilarity)

    const getScopeCondition = (): SQL | undefined => {
      if (!options.scope) {
        return undefined
      }
      const conditions: (SQL | undefined)[] = []
      if (options.scope.files.length > 0) {
        conditions.push(inArray(embeddingTable.path, options.scope.files))
      }
      if (options.scope.folders.length > 0) {
        conditions.push(
          or(
            ...options.scope.folders.map((folder) =>
              like(embeddingTable.path, `${folder}/%`),
            ),
          ),
        )
      }
      if (conditions.length === 0) {
        return undefined
      }
      return or(...conditions)
    }

    const scopeCondition = getScopeCondition()

    return this.db
      .select({
        ...(() => {
          const { embedding, ...rest } = getTableColumns(embeddingTable)
          void embedding
          return rest
        })(),
        similarity,
      })
      .from(embeddingTable)
      .where(
        and(
          similarityCondition,
          scopeCondition,
          eq(embeddingTable.model, embeddingModel.id),
          eq(embeddingTable.dimension, embeddingModel.dimension),
        ),
      )
      .orderBy((table) => desc(table.similarity))
      .limit(options.limit)
  }

  async getEmbeddingStats(): Promise<EmbeddingDbStats[]> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }

    return this.db
      .select({
        model: embeddingTable.model,
        rowCount: count(),
        totalDataBytes: sum(sql`pg_column_size(${embeddingTable}.*)`).mapWith(
          Number,
        ),
      })
      .from(embeddingTable)
      .groupBy(embeddingTable.model)
      .orderBy(embeddingTable.model)
  }
}
