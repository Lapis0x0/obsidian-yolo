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
} from '../../../types/embedding'
import { DatabaseNotInitializedException } from '../../exception'
import { InsertEmbedding, SelectEmbedding, embeddingTable } from '../../schema'

export class VectorRepository {
  private db: PgliteDatabase | null

  constructor(_app: App, db: PgliteDatabase | null) {
    this.db = db
  }

  /**
   * Build a path → mtime map for the given model. Used by the reconciler to
   * decide which files have changed without round-tripping per file.
   *
   * If a path has multiple chunk rows (the common case), we expose the max
   * mtime across them — they should all match anyway, since updateVaultIndex
   * sets mtime per file.
   */
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
      const existing = mtimeMap.get(row.path)
      if (existing === undefined || row.mtime > existing) {
        mtimeMap.set(row.path, row.mtime)
      }
    }
    return mtimeMap
  }

  /**
   * Read the actual chunk rows for a set of paths under a given model. Used
   * by the reconciler to diff against desired chunks. The embedding column
   * is excluded since the diff doesn't need it.
   */
  async listChunksForPaths(
    modelId: string,
    paths: string[],
  ): Promise<
    Array<{
      id: number
      path: string
      mtime: number
      content_hash: string | null
      metadata: SelectEmbedding['metadata']
    }>
  > {
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

  async bumpMtimeByIds(
    updates: Array<{ id: number; mtime: number }>,
  ): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (updates.length === 0) return
    // Group by mtime to minimize statements when many rows share the new mtime.
    const groups = new Map<number, number[]>()
    for (const u of updates) {
      const bucket = groups.get(u.mtime)
      if (bucket) bucket.push(u.id)
      else groups.set(u.mtime, [u.id])
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

  /** Wipe all rows for one model namespace. */
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
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    const dbWithClient = this.db as PgliteDatabase & {
      $client?: { exec: (sql: string) => Promise<unknown> }
    }
    await dbWithClient.$client?.exec('SET hnsw.ef_search = 100')

    const similarity = sql<number>`1 - (${cosineDistance(embeddingTable.embedding, queryVector)})`
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

    const similaritySearchResults = await this.db
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
          eq(embeddingTable.dimension, embeddingModel.dimension), // include this to fully utilize partial index
        ),
      )
      .orderBy((t) => desc(t.similarity))
      .limit(options.limit)

    return similaritySearchResults
  }

  async getEmbeddingStats(): Promise<EmbeddingDbStats[]> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }

    const stats = await this.db
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

    return stats
  }
}
