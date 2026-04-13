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
import {
  InsertEmbedding,
  SelectEmbedding,
  VectorMetaData,
  embeddingTable,
} from '../../schema'

export class VectorRepository {
  private app: App
  private db: PgliteDatabase | null

  constructor(app: App, db: PgliteDatabase | null) {
    this.app = app
    this.db = db
  }

  async getIndexedFilePaths(
    embeddingModel: EmbeddingModelClient,
  ): Promise<string[]> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    const indexedFiles = await this.db
      .select({
        path: embeddingTable.path,
      })
      .from(embeddingTable)
      .where(eq(embeddingTable.model, embeddingModel.id))
    return [...new Set(indexedFiles.map((row) => row.path))]
  }

  /** Chunk metadata without embedding column (lighter for incremental diff). */
  async getChunkMetaForFile(
    filePath: string,
    embeddingModel: EmbeddingModelClient,
  ): Promise<
    {
      id: number
      mtime: number
      content: string
      content_hash: string | null
      metadata: VectorMetaData
    }[]
  > {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    return await this.db
      .select({
        id: embeddingTable.id,
        mtime: embeddingTable.mtime,
        content: embeddingTable.content,
        content_hash: embeddingTable.content_hash,
        metadata: embeddingTable.metadata,
      })
      .from(embeddingTable)
      .where(
        and(
          eq(embeddingTable.path, filePath),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )
  }

  async deleteVectorsByIds(ids: number[]): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (ids.length === 0) {
      return
    }
    await this.db
      .delete(embeddingTable)
      .where(inArray(embeddingTable.id, ids))
  }

  async updateVectorsMtimeByIds(
    ids: number[],
    mtime: number,
  ): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (ids.length === 0) {
      return
    }
    await this.db
      .update(embeddingTable)
      .set({ mtime })
      .where(inArray(embeddingTable.id, ids))
  }

  async updateVectorMetadataById(
    id: number,
    updates: {
      mtime: number
      metadata: VectorMetaData
      path?: string
    },
  ): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    await this.db
      .update(embeddingTable)
      .set({
        mtime: updates.mtime,
        metadata: updates.metadata,
        ...(updates.path ? { path: updates.path } : {}),
      })
      .where(eq(embeddingTable.id, id))
  }

  async getVectorsByFilePath(
    filePath: string,
    embeddingModel: EmbeddingModelClient,
  ): Promise<SelectEmbedding[]> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    const fileVectors = await this.db
      .select()
      .from(embeddingTable)
      .where(
        and(
          eq(embeddingTable.path, filePath),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )
    return fileVectors
  }

  /**
   * 批量获取文件的 mtime 信息
   * 用于优化 N+1 查询问题，一次查询获取所有文件的索引状态
   */
  async getFileMtimes(
    embeddingModel: EmbeddingModelClient,
  ): Promise<Map<string, number>> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }

    const results = await this.db
      .select({
        path: embeddingTable.path,
        mtime: embeddingTable.mtime,
      })
      .from(embeddingTable)
      .where(eq(embeddingTable.model, embeddingModel.id))
      .groupBy(embeddingTable.path, embeddingTable.mtime)

    const mtimeMap = new Map<string, number>()
    for (const row of results) {
      // 如果同一文件有多条记录，取最新的 mtime
      const existing = mtimeMap.get(row.path)
      if (existing === undefined || row.mtime > existing) {
        mtimeMap.set(row.path, row.mtime)
      }
    }
    return mtimeMap
  }

  async deleteVectorsForSingleFile(
    filePath: string,
    embeddingModel: EmbeddingModelClient,
  ): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    await this.db
      .delete(embeddingTable)
      .where(
        and(
          eq(embeddingTable.path, filePath),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )
  }

  async deleteVectorsForMultipleFiles(
    filePaths: string[],
    embeddingModel: EmbeddingModelClient,
  ): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    await this.db
      .delete(embeddingTable)
      .where(
        and(
          inArray(embeddingTable.path, filePaths),
          eq(embeddingTable.model, embeddingModel.id),
        ),
      )
  }

  async clearAllVectors(embeddingModel: EmbeddingModelClient): Promise<void> {
    await this.clearVectorsByModelId(embeddingModel.id)
  }

  async clearVectorsByModelId(modelId: string): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    await this.db.delete(embeddingTable).where(eq(embeddingTable.model, modelId))
  }

  async clearStagingVectorsForModel(baseModelId: string): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    await this.db
      .delete(embeddingTable)
      .where(sql`${embeddingTable.model} LIKE ${`${baseModelId}::staging:%`}`)
  }

  async clearVectorsByModelIds(modelIds: string[]): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    if (modelIds.length === 0) {
      return
    }
    await this.db
      .delete(embeddingTable)
      .where(inArray(embeddingTable.model, modelIds))
  }

  async hasVectorsForModel(
    embeddingModel: EmbeddingModelClient,
  ): Promise<boolean> {
    return this.hasVectorsForModelId(embeddingModel.id)
  }

  async hasVectorsForModelId(modelId: string): Promise<boolean> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    const result = await this.db
      .select({ value: count() })
      .from(embeddingTable)
      .where(eq(embeddingTable.model, modelId))
      .limit(1)
    const countValue = result[0]?.value ?? 0
    return countValue > 0
  }

  async replaceModelContents(input: {
    activeModelId: string
    stagingModelId: string
  }): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }

    const dbWithClient = this.db as PgliteDatabase & {
      $client?: { exec: (query: string) => Promise<unknown> }
    }
    const client = dbWithClient.$client
    if (!client) {
      throw new Error('PGlite client is unavailable')
    }

    const escapeSqlText = (value: string) => value.replace(/'/g, "''")
    const activeModelId = escapeSqlText(input.activeModelId)
    const stagingModelId = escapeSqlText(input.stagingModelId)

    await client.exec('BEGIN')
    try {
      await client.exec(`DELETE FROM embeddings WHERE model = '${activeModelId}'`)
      await client.exec(
        `UPDATE embeddings SET model = '${activeModelId}' WHERE model = '${stagingModelId}'`,
      )
      await client.exec('COMMIT')
    } catch (error) {
      await client.exec('ROLLBACK')
      throw error
    }
  }

  async insertVectors(data: InsertEmbedding[]): Promise<void> {
    if (!this.db) {
      throw new DatabaseNotInitializedException()
    }
    await this.db.insert(embeddingTable).values(data)
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
      .where(sql`${embeddingTable.model} NOT LIKE '%::staging:%'`)
      .groupBy(embeddingTable.model)
      .orderBy(embeddingTable.model)

    return stats
  }
}
