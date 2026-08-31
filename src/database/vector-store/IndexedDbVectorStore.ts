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
  compoundKeyPrefixRange,
  requestResult,
  transactionCompletion,
  vectorDbError,
} from './vectorDatabase'
import { VectorIndex } from './vectorIndex'

const DESKTOP_IDLE_UNLOAD_MS = 15 * 60 * 1000
const MOBILE_IDLE_UNLOAD_MS = 5 * 60 * 1000
const IDLE_CHECK_INTERVAL_MS = 60 * 1000

/**
 * How many int8-scan results to pull as rescoring candidates, relative to
 * the caller's real `limit`. The int8 scan only ranks approximately, so a
 * true top-`limit` row can be scanned into a slightly lower position;
 * over-fetching a wider window and then rescoring+re-sorting exactly
 * (below) corrects that before truncating to `limit`. The `* 4` factor and
 * `32` floor are both empirical safety margins, not derived from the
 * quantization error bound (unlike `INT8_SCAN_SLACK` in `topK.ts`, which
 * bounds the score error itself rather than a rank-order shift).
 */
const CANDIDATE_WINDOW_MULTIPLIER = 4
const CANDIDATE_WINDOW_MIN = 32

/**
 * Random chunk pairs sampled for `getSimilarityBaseline`. The estimate only
 * needs to place the corpus's background similarity to two decimals, and the
 * standard error of a mean over 4000 samples is ~1.5% of the standard
 * deviation — far finer than the visual scale it feeds. Costs one int8 dot
 * product per sample against an index that is already resident.
 */
const BASELINE_PAIR_SAMPLES = 4000
/**
 * Recompute the cached baseline once the index has grown or shrunk by this
 * fraction. The statistic is coarse and barely moves as a few hundred chunks
 * are added, but a vault indexing from empty would otherwise keep a baseline
 * measured over its first handful of notes for the rest of the session.
 */
const BASELINE_STALE_SIZE_RATIO = 0.25

/** Exact dot product of two equal-length vectors (cosine similarity when both are unit-length). */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

export type IndexedDbVectorStoreOptions = Readonly<{
  /** Test-only override; defaults to `Platform.isMobile`. */
  isMobile?: boolean
  /**
   * Test-only override for how many rows `topKSearch` scans between yields
   * (defaults to its dimension-based budget). Lets a test force a yield
   * inside a small scan so it can interleave a delete with it.
   */
  scanYieldEvery?: number
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
  // Tracks the dimension each in-flight load was requested for, so a second
  // request for a different dimension while a load is already in flight
  // can tell it isn't reusable (see `ensureIndexLoaded`) without waiting for
  // it to resolve first.
  private readonly loadingIndexes = new Map<
    string,
    { dimension: number; promise: Promise<VectorIndex> }
  >()
  /** Per-model background similarity, with the live row count it was measured
   *  over so growth can invalidate it. Cleared with the index it describes. */
  private readonly baselines = new Map<
    string,
    { mean: number; std: number; size: number }
  >()
  private readonly idleThresholdMs: number
  private readonly scanYieldEvery: number | undefined
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(
    private readonly db: IDBDatabase,
    options: IndexedDbVectorStoreOptions = {},
  ) {
    const isMobile = options.isMobile ?? Platform.isMobile
    this.scanYieldEvery = options.scanYieldEvery
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
    this.baselines.clear()
    this.db.close()
  }

  private unloadIdleIndexes(): void {
    const now = Date.now()
    for (const [modelId, index] of this.indexes) {
      if (now - index.lastQueryAt > this.idleThresholdMs) {
        this.indexes.delete(modelId)
        this.baselines.delete(modelId)
      }
    }
  }

  async getFileMtimes(
    modelId: string,
  ): Promise<Readonly<Record<string, number>>> {
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const index = tx.objectStore(CHUNKS_STORE).index(MODEL_PATH_INDEX)
    const result: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >
    // Key cursor over `[model, path, mtime]`: reads index entries only, never
    // the (vector + content carrying) record values.
    await new Promise<void>((resolve, reject) => {
      const request = index.openKeyCursor(compoundKeyPrefixRange([modelId]))
      request.onerror = () =>
        reject(vectorDbError('mtime scan failed', request.error))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        const [, path, mtime] = cursor.key as [string, string, number]
        const existing = result[path]
        if (existing === undefined || mtime > existing) {
          result[path] = mtime
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
        index.getAll(compoundKeyPrefixRange([modelId, path])),
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

  async listVectorsForPath(
    modelId: string,
    path: string,
  ): Promise<Float32Array[]> {
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const index = tx.objectStore(CHUNKS_STORE).index(MODEL_PATH_INDEX)
    const records = (await requestResult(
      index.getAll(compoundKeyPrefixRange([modelId, path])),
    )) as ChunkRecord[]
    await transactionCompletion(tx)
    return records.map((record) => record.vector)
  }

  async deleteVectorsByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    const tx = this.db.transaction(CHUNKS_STORE, 'readwrite')
    const store = tx.objectStore(CHUNKS_STORE)
    for (const id of ids) {
      await requestResult(store.delete(id))
    }
    await transactionCompletion(tx)
    // Tombstone the whole batch first, then compact each touched index at
    // most once — not once per id — via `maybeCompact()` (see
    // `VectorIndex`'s class doc for why per-delete compaction was removed).
    for (const index of this.indexes.values()) {
      for (const id of ids) index.tombstoneById(id)
      index.maybeCompact()
    }
  }

  async deleteVectorsByPaths(modelId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const tx = this.db.transaction(CHUNKS_STORE, 'readwrite')
    const store = tx.objectStore(CHUNKS_STORE)
    const modelPathIndex = store.index(MODEL_PATH_INDEX)
    for (const path of paths) {
      const keys = await requestResult(
        modelPathIndex.getAllKeys(compoundKeyPrefixRange([modelId, path])),
      )
      for (const key of keys) {
        await requestResult(store.delete(key))
      }
    }
    await transactionCompletion(tx)
    const index = this.indexes.get(modelId)
    if (index) {
      for (const path of paths) index.tombstoneByPath(path)
      index.maybeCompact()
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
    // Validate every row before opening the write transaction: a dimension
    // mismatch caught only inside `VectorIndex.append` (called after the
    // transaction already committed, from the per-row loop below) would
    // leave a durable row committed to IndexedDB despite the "insert"
    // failing — see Codex finding 1.5.
    for (const item of data) {
      if (!item.embedding || item.embedding.length === 0) {
        throw new Error(
          `insertVectors requires an embedding for every row (missing for "${item.path}")`,
        )
      }
      if (item.embedding.length !== item.dimension) {
        throw new Error(
          `insertVectors: embedding length ${item.embedding.length} does not match declared dimension ${item.dimension} (path "${item.path}")`,
        )
      }
    }
    const tx = this.db.transaction(CHUNKS_STORE, 'readwrite')
    const store = tx.objectStore(CHUNKS_STORE)
    const inserted: Array<{ id: number; row: NewChunkRecord }> = []
    for (const item of data) {
      const row: NewChunkRecord = {
        model: item.model,
        path: item.path,
        mtime: item.mtime,
        content: item.content,
        content_hash: item.content_hash ?? null,
        dimension: item.dimension,
        metadata: item.metadata,
        // Non-null: validated above, before the transaction was opened.
        vector: l2Normalize(item.embedding as number[]),
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
    this.baselines.delete(modelId)
    this.loadingIndexes.delete(modelId)
  }

  async clearVectorsByModelIds(modelIds: string[]): Promise<void> {
    for (const modelId of modelIds) {
      await this.deleteAllForModel(modelId)
      this.indexes.delete(modelId)
      this.baselines.delete(modelId)
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

  /**
   * Reports per-model row counts and `vectorBytes` (`rowCount * dimension *
   * 4`, i.e. the on-disk float32 vector payload's size — a performance-over-
   * precision estimate, not an exact byte count of the whole record).
   * Previously this used `store.openCursor()` and read every `cursor.value`
   * purely to count rows and sum byte estimates — at hundreds of thousands
   * of chunks that meant deserializing a full vector + content string per
   * row just to compute a count (see Codex finding 2.4). Instead: enumerate
   * distinct model ids via a unique key cursor over `MODEL_INDEX`, then
   * `index.count(modelId)` for the row count (index-only, no record read)
   * and one `index.openCursor(modelId)` — stopped after its first result —
   * purely to read that one row's `dimension`.
   */
  /**
   * See `VectorStore.getSimilarityBaseline`. Samples random *live* row pairs
   * from the resident int8 matrix and reconstructs each pair's cosine from
   * the per-row scales (`x ≈ q * scale / 127`, see `quantization.ts`); rows
   * are L2-normalized at write time, so the dot product is the cosine. int8
   * error is well below the resolution this statistic is read at, so the
   * float32 rescore `performSimilaritySearch` does is not worth a second
   * IndexedDB round trip here.
   */
  async getSimilarityBaseline(embeddingModel: {
    id: string
    dimension: number
  }): Promise<{ mean: number; std: number } | null> {
    const index = await this.ensureIndexLoaded(
      embeddingModel.id,
      embeddingModel.dimension,
    )
    const liveCount = index.size - index.tombstoneCount
    if (liveCount < 2) return null

    const cached = this.baselines.get(embeddingModel.id)
    if (
      cached &&
      Math.abs(liveCount - cached.size) <=
        cached.size * BASELINE_STALE_SIZE_RATIO
    ) {
      return { mean: cached.mean, std: cached.std }
    }

    const liveRows: number[] = []
    for (let rowIndex = 0; rowIndex < index.size; rowIndex++) {
      if (!index.isTombstoned(rowIndex)) liveRows.push(rowIndex)
    }
    if (liveRows.length < 2) return null

    const { dimension, matrix, scales } = index
    let sum = 0
    let sumSquares = 0
    for (let sample = 0; sample < BASELINE_PAIR_SAMPLES; sample++) {
      const indexA = Math.floor(Math.random() * liveRows.length)
      let indexB = Math.floor(Math.random() * liveRows.length)
      // A row against itself scores 1 and would drag the background up.
      if (indexA === indexB) indexB = (indexB + 1) % liveRows.length
      const a = liveRows[indexA]
      const b = liveRows[indexB]
      let dot = 0
      const offsetA = a * dimension
      const offsetB = b * dimension
      for (let i = 0; i < dimension; i++) {
        dot += matrix[offsetA + i] * matrix[offsetB + i]
      }
      const similarity = (dot * scales[a] * scales[b]) / (127 * 127)
      sum += similarity
      sumSquares += similarity * similarity
    }
    const mean = sum / BASELINE_PAIR_SAMPLES
    const std = Math.sqrt(
      Math.max(0, sumSquares / BASELINE_PAIR_SAMPLES - mean * mean),
    )
    this.baselines.set(embeddingModel.id, {
      mean,
      std,
      size: liveRows.length,
    })
    return { mean, std }
  }

  async getEmbeddingStats(): Promise<
    Array<{ model: string; rowCount: number; vectorBytes: number }>
  > {
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const modelIndex = tx.objectStore(CHUNKS_STORE).index(MODEL_INDEX)
    const modelIds: string[] = []
    await new Promise<void>((resolve, reject) => {
      const request = modelIndex.openKeyCursor(null, 'nextunique')
      request.onerror = () =>
        reject(vectorDbError('stats scan failed', request.error))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        modelIds.push(cursor.key as string)
        cursor.continue()
      }
    })

    const stats: Array<{
      model: string
      rowCount: number
      vectorBytes: number
    }> = []
    for (const model of modelIds) {
      const rowCount = await requestResult(modelIndex.count(model))
      const dimension = await new Promise<number>((resolve, reject) => {
        const request = modelIndex.openCursor(model)
        request.onerror = () =>
          reject(vectorDbError('stats scan failed', request.error))
        request.onsuccess = () => {
          const cursor = request.result
          resolve(cursor ? (cursor.value as ChunkRecord).dimension : 0)
        }
      })
      stats.push({
        model,
        rowCount,
        vectorBytes: rowCount * dimension * 4,
      })
    }

    await transactionCompletion(tx)
    return stats.sort((a, b) => a.model.localeCompare(b.model))
  }

  async performSimilaritySearch(
    queryVector: number[],
    embeddingModel: { id: string; dimension: number },
    options: {
      minSimilarity: number
      limit: number
      scope?: { files: string[]; folders: string[]; exclude?: string[] }
    },
  ): Promise<Array<VectorSelect & { similarity: number }>> {
    if (queryVector.length !== embeddingModel.dimension) {
      throw new Error(
        `performSimilaritySearch: query vector length ${queryVector.length} does not match model dimension ${embeddingModel.dimension}`,
      )
    }
    const index = await this.ensureIndexLoaded(
      embeddingModel.id,
      embeddingModel.dimension,
    )
    index.lastQueryAt = Date.now()

    const normalizedQuery = l2Normalize(queryVector)
    const scope = options.scope
    const exclude = scope?.exclude ?? []
    const hasScope =
      !!scope &&
      (scope.files.length > 0 || scope.folders.length > 0 || exclude.length > 0)
    const filesSet = hasScope ? new Set(scope.files) : null
    const folders = hasScope ? scope.folders : []
    const hasInclude = hasScope && (filesSet!.size > 0 || folders.length > 0)
    const filter = hasScope
      ? (rowIndex: number): boolean => {
          const path = index.paths[rowIndex]
          // Exclude always wins, even over an explicit include match — same
          // priority as `workspaceScope.ts`'s `matchesRule`/
          // `isPathAllowedByScope`.
          if (
            exclude.some((rule) => path === rule || path.startsWith(`${rule}/`))
          ) {
            return false
          }
          if (!hasInclude) return true
          if (filesSet!.has(path)) return true
          return folders.some((folder) => path.startsWith(`${folder}/`))
        }
      : undefined

    // Over-fetch candidates from the approximate int8 scan; a negative
    // limit already means "unlimited" and needs no widening.
    const candidateLimit =
      options.limit < 0
        ? options.limit
        : Math.max(
            options.limit * CANDIDATE_WINDOW_MULTIPLIER,
            CANDIDATE_WINDOW_MIN,
          )

    // `beginScan`/`endScan` bracket the scan so a concurrent delete's
    // tombstoning can't trigger a mid-scan `compact()` that remaps `ids`/
    // `paths`/tombstones out from under this scan's captured `matrix`/
    // `scales` (see `VectorIndex`'s class doc and Codex finding 1.1).
    // The row indices the scan returns are only meaningful while the scan
    // is still registered: `endScan()` may compact synchronously and remap
    // every row, so candidate ids are resolved inside the bracket and only
    // ids (never row indices) are used after it.
    index.beginScan()
    let candidateIds: number[]
    try {
      const top = await topKSearch({
        matrix: index.matrix,
        scales: index.scales,
        dimension: index.dimension,
        size: index.size,
        isTombstoned: (rowIndex) => index.isTombstoned(rowIndex),
        filter,
        queryVector: normalizedQuery,
        limit: candidateLimit,
        minSimilarity: options.minSimilarity,
        yieldEvery: this.scanYieldEvery,
      })
      candidateIds = top.map((row) => index.ids[row.rowIndex])
    } finally {
      index.endScan()
    }
    if (candidateIds.length === 0) return []

    // The scan above only ranked by an approximate int8 score. Rescore
    // every candidate against its exact float32 vector (already fetched
    // here to get `content`, so this is free), then apply the caller's
    // exact strict `> minSimilarity` and truncate to the real `limit` —
    // both intentionally deferred until this point.
    const records = await this.getByIds(candidateIds)
    const recordById = new Map(records.map((record) => [record.id, record]))

    const rescored: Array<VectorSelect & { similarity: number }> = []
    for (const id of candidateIds) {
      const record = recordById.get(id)
      if (!record) continue
      const similarity = dotProduct(record.vector, normalizedQuery)
      if (similarity > options.minSimilarity) {
        rescored.push({
          id: record.id,
          path: record.path,
          mtime: record.mtime,
          content: record.content,
          content_hash: record.content_hash,
          model: record.model,
          dimension: record.dimension,
          metadata: record.metadata,
          similarity,
        })
      }
    }
    rescored.sort((a, b) => b.similarity - a.similarity)
    return options.limit < 0 ? rescored : rescored.slice(0, options.limit)
  }

  /**
   * Fetches every id in one readonly transaction. All `get` requests are
   * issued synchronously (via `.map`, before any is awaited) so they run
   * against the same transaction concurrently rather than one at a time —
   * `store.get(id)` returns an `IDBRequest` immediately, and `requestResult`
   * attaches its listeners synchronously too, so nothing here actually
   * awaits before every request has been issued (see Codex finding 2.5).
   * `Promise.all` preserves the input `ids` order in its result array
   * regardless of which request's underlying event fires first.
   */
  private async getByIds(ids: number[]): Promise<ChunkRecord[]> {
    if (ids.length === 0) return []
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const store = tx.objectStore(CHUNKS_STORE)
    const requests = ids.map(
      (id) => requestResult(store.get(id)) as Promise<ChunkRecord | undefined>,
    )
    const results = await Promise.all(requests)
    await transactionCompletion(tx)
    return results.filter((record): record is ChunkRecord => !!record)
  }

  /**
   * Returns the loaded (or in-flight-loading) index for `modelId`, reloading
   * from scratch whenever the request is for a different `dimension` than
   * what's already loaded/loading — an existing index never silently serves
   * a different dimension's queries (see Codex finding 1.4: an index keyed
   * only by model id, with no dimension check, would keep an in-memory index
   * built for a superseded dimension after the model's configured dimension
   * changes, so both queries and future inserts for the new dimension would
   * be applied against the stale index instead of a fresh one).
   */
  private ensureIndexLoaded(
    modelId: string,
    dimension: number,
  ): Promise<VectorIndex> {
    const existing = this.indexes.get(modelId)
    if (existing) {
      if (existing.dimension === dimension) return Promise.resolve(existing)
      this.indexes.delete(modelId)
      this.baselines.delete(modelId)
    }
    const inFlight = this.loadingIndexes.get(modelId)
    if (inFlight) {
      if (inFlight.dimension === dimension) return inFlight.promise
      // A load for a different dimension is already in flight. Let it run
      // to completion undisturbed (its `.then` below only installs itself
      // into `this.indexes`/`this.loadingIndexes` if it's still the
      // current entry for `modelId`), and start a fresh load for the
      // dimension actually requested here.
      this.loadingIndexes.delete(modelId)
    }

    const promise = this.loadIndexFromDb(modelId, dimension).then(
      (index) => {
        if (this.loadingIndexes.get(modelId)?.promise === promise) {
          this.loadingIndexes.delete(modelId)
        }
        this.indexes.set(modelId, index)
        return index
      },
      (error: unknown) => {
        if (this.loadingIndexes.get(modelId)?.promise === promise) {
          this.loadingIndexes.delete(modelId)
        }
        throw error
      },
    )
    this.loadingIndexes.set(modelId, { dimension, promise })
    return promise
  }

  /**
   * Streams every row for `modelId` into a fresh in-memory index via a
   * cursor (never `getAll`, to avoid holding two copies of the whole model
   * in memory at once). Each cursor value's float32 vector is quantized to
   * int8 by `index.append` and then discarded, so the full float32 matrix
   * for the model never materializes in memory at all — peak memory here
   * is the (already 4x-smaller) int8 matrix plus at most one in-flight
   * cursor record. Rows whose stored dimension doesn't match are skipped
   * rather than aborting the whole load — mirroring the PGlite baseline's
   * per-query `eq(dimension, ...)` filter, which simply excludes them
   * instead of erroring.
   *
   * Capacity is `reserve()`d up front from `index.count(modelId)` (an
   * index-only count, no record reads) so the append loop below never has
   * to grow the matrix mid-load — `count()` may modestly overcount rows
   * whose stored dimension won't match (mismatched rows are skipped, not
   * appended), which just means `reserve` pre-allocates a few rows more
   * than strictly needed, not fewer.
   */
  private async loadIndexFromDb(
    modelId: string,
    dimension: number,
  ): Promise<VectorIndex> {
    const index = new VectorIndex(dimension)
    const tx = this.db.transaction(CHUNKS_STORE, 'readonly')
    const idbIndex = tx.objectStore(CHUNKS_STORE).index(MODEL_INDEX)
    const rowCount = await requestResult(idbIndex.count(modelId))
    index.reserve(rowCount)
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
