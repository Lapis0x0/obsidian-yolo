import { Platform } from 'obsidian'

import type {
  VectorInsert,
  VectorSelect,
  VectorStore,
} from '../../core/runtime-components/contracts'

import { l2Normalize, topKSearch } from './topK'
import {
  CHUNKS_STORE,
  type ChunkRecord,
  MODEL_INDEX,
  MODEL_PATH_INDEX,
  type NewChunkRecord,
  requestResult,
  transactionCompletion,
  vectorDbError,
} from './vectorDatabase'
import { VectorIndex } from './vectorIndex'

const DESKTOP_IDLE_UNLOAD_MS = 15 * 60 * 1000
const MOBILE_IDLE_UNLOAD_MS = 5 * 60 * 1000
const IDLE_CHECK_INTERVAL_MS = 60 * 1000

export type IndexedDbVectorStoreOptions = Readonly<{
  /** Test-only override; defaults to `Platform.isMobile`. */
  isMobile?: boolean
}>

/**
 * Flat-scan `VectorStore` backed by one IndexedDB database (see
 * `vectorDatabase.ts` for the schema) plus a lazily-loaded, per-embedding-
 * model in-memory `VectorIndex` used only for `performSimilaritySearch`.
 * Every other method reads/writes IndexedDB directly and keeps a loaded
 * index in sync (see the per-method comments below).
 */
export class IndexedDbVectorStore implements VectorStore {
  private readonly indexes = new Map<string, VectorIndex>()
  private readonly loadingIndexes = new Map<string, Promise<VectorIndex>>()
  private readonly idleThresholdMs: number
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(
    private readonly db: IDBDatabase,
    options: IndexedDbVectorStoreOptions = {},
  ) {
    const isMobile = options.isMobile ?? Platform.isMobile
    this.idleThresholdMs = isMobile
      ? MOBILE_IDLE_UNLOAD_MS
      : DESKTOP_IDLE_UNLOAD_MS
    this.idleTimer = setInterval(() => {
      this.unloadIdleIndexes()
    }, IDLE_CHECK_INTERVAL_MS)
  }

  /** Stops the idle-unload timer and closes the underlying database. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    this.indexes.clear()
    this.loadingIndexes.clear()
    this.db.close()
  }

  private unloadIdleIndexes(): void {
    const now = Date.now()
    for (const [modelId, index] of this.indexes) {
      if (now - index.lastQueryAt > this.idleThresholdMs) {
        this.indexes.delete(modelId)
      }
    }
  }

  async getFileMtimes(
    modelId: string,
  ): Promise<Readonly<Record<string, number>>> {
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const index = tx.objectStore(CHUNKS_STORE).index(MODEL_INDEX)
    const result: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >
    await new Promise<void>((resolve, reject) => {
      const request = index.openCursor(modelId)
      request.onerror = () =>
        reject(vectorDbError('mtime scan failed', request.error))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        const record = cursor.value as ChunkRecord
        const existing = result[record.path]
        if (existing === undefined || record.mtime > existing) {
          result[record.path] = record.mtime
        }
        cursor.continue()
      }
    })
    await transactionCompletion(tx)
    return Object.freeze(result)
  }

  async listChunksForPaths(
    modelId: string,
    paths: string[],
  ): Promise<
    Array<
      Pick<VectorSelect, 'id' | 'path' | 'mtime' | 'content_hash' | 'metadata'>
    >
  > {
    if (paths.length === 0) return []
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const index = tx.objectStore(CHUNKS_STORE).index(MODEL_PATH_INDEX)
    const results: Array<
      Pick<VectorSelect, 'id' | 'path' | 'mtime' | 'content_hash' | 'metadata'>
    > = []
    for (const path of paths) {
      const records = (await requestResult(
        index.getAll([modelId, path]),
      )) as ChunkRecord[]
      for (const record of records) {
        results.push({
          id: record.id,
          path: record.path,
          mtime: record.mtime,
          content_hash: record.content_hash,
          metadata: record.metadata,
        })
      }
    }
    await transactionCompletion(tx)
    return results
  }

  async deleteVectorsByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    const tx = this.db.transaction(CHUNKS_STORE, 'readwrite')
    const store = tx.objectStore(CHUNKS_STORE)
    for (const id of ids) {
      await requestResult(store.delete(id))
    }
    await transactionCompletion(tx)
    for (const index of this.indexes.values()) {
      for (const id of ids) index.tombstoneById(id)
    }
  }

  async deleteVectorsByPaths(modelId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const tx = this.db.transaction(CHUNKS_STORE, 'readwrite')
    const store = tx.objectStore(CHUNKS_STORE)
    const modelPathIndex = store.index(MODEL_PATH_INDEX)
    for (const path of paths) {
      const keys = await requestResult(
        modelPathIndex.getAllKeys([modelId, path]),
      )
      for (const key of keys) {
        await requestResult(store.delete(key))
      }
    }
    await transactionCompletion(tx)
    const index = this.indexes.get(modelId)
    if (index) {
      for (const path of paths) index.tombstoneByPath(path)
    }
  }

  async bumpMtimeByIds(
    updates: Array<{ id: number; mtime: number }>,
  ): Promise<void> {
    if (updates.length === 0) return
    const tx = this.db.transaction(CHUNKS_STORE, 'readwrite')
    const store = tx.objectStore(CHUNKS_STORE)
    for (const { id, mtime } of updates) {
      const record = (await requestResult(store.get(id))) as
        | ChunkRecord
        | undefined
      if (!record) continue
      record.mtime = mtime
      await requestResult(store.put(record))
    }
    await transactionCompletion(tx)
  }

  async insertVectors(data: VectorInsert[]): Promise<void> {
    if (data.length === 0) return
    const tx = this.db.transaction(CHUNKS_STORE, 'readwrite')
    const store = tx.objectStore(CHUNKS_STORE)
    const inserted: Array<{ id: number; row: NewChunkRecord }> = []
    for (const item of data) {
      if (!item.embedding || item.embedding.length === 0) {
        throw new Error(
          `insertVectors requires an embedding for every row (missing for "${item.path}")`,
        )
      }
      const row: NewChunkRecord = {
        model: item.model,
        path: item.path,
        mtime: item.mtime,
        content: item.content,
        content_hash: item.content_hash ?? null,
        dimension: item.dimension,
        metadata: item.metadata,
        vector: l2Normalize(item.embedding),
      }
      // The `chunks` store's key is an autoIncrement number, so the
      // generated key is always a number despite IDBValidKey's wider type.
      const id = (await requestResult(store.add(row))) as number
      inserted.push({ id, row })
    }
    await transactionCompletion(tx)
    for (const { id, row } of inserted) {
      const index = this.indexes.get(row.model)
      if (index && index.dimension === row.dimension) {
        index.append({
          id,
          path: row.path,
          metadata: row.metadata,
          vector: row.vector,
        })
      }
    }
  }

  async truncateModel(modelId: string): Promise<void> {
    await this.deleteAllForModel(modelId)
    this.indexes.delete(modelId)
    this.loadingIndexes.delete(modelId)
  }

  async clearVectorsByModelIds(modelIds: string[]): Promise<void> {
    for (const modelId of modelIds) {
      await this.deleteAllForModel(modelId)
      this.indexes.delete(modelId)
      this.loadingIndexes.delete(modelId)
    }
  }

  private async deleteAllForModel(modelId: string): Promise<void> {
    const tx = this.db.transaction(CHUNKS_STORE, 'readwrite')
    const store = tx.objectStore(CHUNKS_STORE)
    const index = store.index(MODEL_INDEX)
    const keys = await requestResult(index.getAllKeys(modelId))
    for (const key of keys) {
      await requestResult(store.delete(key))
    }
    await transactionCompletion(tx)
  }

  async getEmbeddingStats(): Promise<
    Array<{ model: string; rowCount: number; totalDataBytes: number }>
  > {
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const store = tx.objectStore(CHUNKS_STORE)
    const statsByModel = new Map<
      string,
      { rowCount: number; totalDataBytes: number }
    >()
    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor()
      request.onerror = () =>
        reject(vectorDbError('stats scan failed', request.error))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        const record = cursor.value as ChunkRecord
        const existing = statsByModel.get(record.model) ?? {
          rowCount: 0,
          totalDataBytes: 0,
        }
        existing.rowCount += 1
        existing.totalDataBytes +=
          record.dimension * 4 + record.content.length * 2
        statsByModel.set(record.model, existing)
        cursor.continue()
      }
    })
    await transactionCompletion(tx)
    return [...statsByModel.entries()]
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => a.model.localeCompare(b.model))
  }

  async performSimilaritySearch(
    queryVector: number[],
    embeddingModel: { id: string; dimension: number },
    options: {
      minSimilarity: number
      limit: number
      scope?: { files: string[]; folders: string[] }
    },
  ): Promise<Array<VectorSelect & { similarity: number }>> {
    const index = await this.ensureIndexLoaded(
      embeddingModel.id,
      embeddingModel.dimension,
    )
    index.lastQueryAt = Date.now()

    const normalizedQuery = l2Normalize(queryVector)
    const scope = options.scope
    const hasScope =
      !!scope && (scope.files.length > 0 || scope.folders.length > 0)
    const filesSet = hasScope ? new Set(scope.files) : null
    const folders = hasScope ? scope.folders : []
    const filter = hasScope
      ? (rowIndex: number): boolean => {
          const path = index.paths[rowIndex]
          if (filesSet!.has(path)) return true
          return folders.some((folder) => path.startsWith(`${folder}/`))
        }
      : undefined

    const top = await topKSearch({
      matrix: index.matrix,
      dimension: index.dimension,
      size: index.size,
      isTombstoned: (rowIndex) => index.isTombstoned(rowIndex),
      filter,
      queryVector: normalizedQuery,
      limit: options.limit,
      minSimilarity: options.minSimilarity,
    })
    if (top.length === 0) return []

    const ids = top.map((row) => index.ids[row.rowIndex])
    const records = await this.getByIds(ids)
    const recordById = new Map(records.map((record) => [record.id, record]))

    const results: Array<VectorSelect & { similarity: number }> = []
    for (const { rowIndex, score } of top) {
      const record = recordById.get(index.ids[rowIndex])
      if (!record) continue
      results.push({
        id: record.id,
        path: record.path,
        mtime: record.mtime,
        content: record.content,
        content_hash: record.content_hash,
        model: record.model,
        dimension: record.dimension,
        metadata: record.metadata,
        similarity: score,
      })
    }
    return results
  }

  private async getByIds(ids: number[]): Promise<ChunkRecord[]> {
    if (ids.length === 0) return []
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const store = tx.objectStore(CHUNKS_STORE)
    const records: ChunkRecord[] = []
    for (const id of ids) {
      const record = (await requestResult(store.get(id))) as
        | ChunkRecord
        | undefined
      if (record) records.push(record)
    }
    await transactionCompletion(tx)
    return records
  }

  private ensureIndexLoaded(
    modelId: string,
    dimension: number,
  ): Promise<VectorIndex> {
    const existing = this.indexes.get(modelId)
    if (existing) return Promise.resolve(existing)
    const inFlight = this.loadingIndexes.get(modelId)
    if (inFlight) return inFlight

    const promise = this.loadIndexFromDb(modelId, dimension)
      .then((index) => {
        this.indexes.set(modelId, index)
        this.loadingIndexes.delete(modelId)
        return index
      })
      .catch((error: unknown) => {
        this.loadingIndexes.delete(modelId)
        throw error
      })
    this.loadingIndexes.set(modelId, promise)
    return promise
  }

  /**
   * Streams every row for `modelId` into a fresh in-memory index via a
   * cursor (never `getAll`, to avoid holding two copies of the whole model
   * in memory at once). Rows whose stored dimension doesn't match are
   * skipped rather than aborting the whole load — mirroring the PGlite
   * baseline's per-query `eq(dimension, ...)` filter, which simply excludes
   * them instead of erroring.
   */
  private async loadIndexFromDb(
    modelId: string,
    dimension: number,
  ): Promise<VectorIndex> {
    const index = new VectorIndex(dimension)
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const idbIndex = tx.objectStore(CHUNKS_STORE).index(MODEL_INDEX)
    await new Promise<void>((resolve, reject) => {
      const request = idbIndex.openCursor(modelId)
      request.onerror = () =>
        reject(vectorDbError('index load failed', request.error))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        const record = cursor.value as ChunkRecord
        if (record.dimension === dimension) {
          index.append({
            id: record.id,
            path: record.path,
            metadata: record.metadata,
            vector: record.vector,
          })
        }
        cursor.continue()
      }
    })
    await transactionCompletion(tx)
    return index
  }
}
