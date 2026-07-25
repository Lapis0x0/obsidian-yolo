import {
  type SQL,
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
import type { PgliteDatabase } from 'drizzle-orm/pglite'

import {
  type InsertEmbedding,
  type SelectEmbedding,
  embeddingTable,
} from './schema'

export type VectorStore = Readonly<{
  getFileMtimes(modelId: string): Promise<Readonly<Record<string, number>>>
  listChunksForPaths(
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
  >
  deleteVectorsByIds(ids: number[]): Promise<void>
  deleteVectorsByPaths(modelId: string, paths: string[]): Promise<void>
  bumpMtimeByIds(updates: Array<{ id: number; mtime: number }>): Promise<void>
  insertVectors(data: InsertEmbedding[]): Promise<void>
  truncateModel(modelId: string): Promise<void>
  clearVectorsByModelIds(modelIds: string[]): Promise<void>
  performSimilaritySearch(
    queryVector: number[],
    embeddingModel: { id: string; dimension: number },
    options: {
      minSimilarity: number
      limit: number
      scope?: { files: string[]; folders: string[] }
    },
  ): Promise<Array<Omit<SelectEmbedding, 'embedding'> & { similarity: number }>>
  getEmbeddingStats(): Promise<
    Array<{ model: string; rowCount: number; totalDataBytes: number }>
  >
}>

export function createVectorStore(db: PgliteDatabase): VectorStore {
  return Object.freeze({
    async getFileMtimes(modelId) {
      const rows = await db
        .select({ path: embeddingTable.path, mtime: embeddingTable.mtime })
        .from(embeddingTable)
        .where(eq(embeddingTable.model, modelId))
        .groupBy(embeddingTable.path, embeddingTable.mtime)
      const result: Record<string, number> = Object.create(null) as Record<
        string,
        number
      >
      for (const row of rows) {
        const mtime = Number(row.mtime)
        if (result[row.path] === undefined || mtime > result[row.path]) {
          result[row.path] = mtime
        }
      }
      return Object.freeze(result)
    },

    async listChunksForPaths(modelId, paths) {
      if (paths.length === 0) return []
      return db
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
    },

    async deleteVectorsByIds(ids) {
      if (ids.length === 0) return
      await db.delete(embeddingTable).where(inArray(embeddingTable.id, ids))
    },

    async deleteVectorsByPaths(modelId, paths) {
      if (paths.length === 0) return
      await db
        .delete(embeddingTable)
        .where(
          and(
            eq(embeddingTable.model, modelId),
            inArray(embeddingTable.path, paths),
          ),
        )
    },

    async bumpMtimeByIds(updates) {
      const groups = new Map<number, number[]>()
      for (const update of updates) {
        const ids = groups.get(update.mtime) ?? []
        ids.push(update.id)
        groups.set(update.mtime, ids)
      }
      for (const [mtime, ids] of groups) {
        await db
          .update(embeddingTable)
          .set({ mtime })
          .where(inArray(embeddingTable.id, ids))
      }
    },

    async insertVectors(data) {
      if (data.length > 0) await db.insert(embeddingTable).values(data)
    },

    async truncateModel(modelId) {
      await db.delete(embeddingTable).where(eq(embeddingTable.model, modelId))
    },

    async clearVectorsByModelIds(modelIds) {
      if (modelIds.length > 0) {
        await db
          .delete(embeddingTable)
          .where(inArray(embeddingTable.model, modelIds))
      }
    },

    async performSimilaritySearch(queryVector, embeddingModel, options) {
      const client = db as PgliteDatabase & {
        $client?: { exec(sql: string): Promise<unknown> }
      }
      await client.$client?.exec('SET hnsw.ef_search = 100')
      const similarity = sql<number>`1 - (${cosineDistance(
        embeddingTable.embedding,
        queryVector,
      )})`
      let scopeCondition: SQL | undefined
      if (options.scope) {
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
        if (conditions.length > 0) scopeCondition = or(...conditions)
      }
      return db
        .select({
          ...(() => {
            const { embedding, ...columns } = getTableColumns(embeddingTable)
            void embedding
            return columns
          })(),
          similarity,
        })
        .from(embeddingTable)
        .where(
          and(
            gt(similarity, options.minSimilarity),
            scopeCondition,
            eq(embeddingTable.model, embeddingModel.id),
            eq(embeddingTable.dimension, embeddingModel.dimension),
          ),
        )
        .orderBy((result) => desc(result.similarity))
        .limit(options.limit)
    },

    async getEmbeddingStats() {
      return db
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
    },
  })
}
