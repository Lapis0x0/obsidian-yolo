import type { VectorMetaData } from '../../core/runtime-components/contracts'

/**
 * v1 is the final schema for this backend's first shipped version — there is
 * no prior version to migrate from, so the upgrade path only ever handles
 * `oldVersion === 0` (fresh database).
 */
export const VECTOR_DATABASE_VERSION = 1
export const VECTOR_DATABASE_NAME_PREFIX = 'yolo-vector:'
export const CHUNKS_STORE = 'chunks'
export const MODEL_INDEX = 'model'
/**
 * Compound index on `[model, path, mtime]`. Carrying `mtime` in the key lets
 * `getFileMtimes` walk a key cursor over the index entries alone instead of
 * deserializing every record (each of which carries a full vector + content)
 * just to read two small fields.
 */
export const MODEL_PATH_INDEX = 'model_path_mtime'

/**
 * One IndexedDB database per (vault namespace, knowledge base) pair — each
 * knowledge base is an independent vector store. `kbId` is the knowledge
 * base's own id (`KnowledgeBase.id`), not any prior single-store namespace.
 */
export const vectorDatabaseName = (namespaceId: string, kbId: string): string =>
  `${VECTOR_DATABASE_NAME_PREFIX}${namespaceId}:${kbId}`

/** The single-store name this backend used before multi-knowledge-base
 * support (this schema's IndexedDB backend has never shipped in a release —
 * see `cleanupLegacyVectorDbArtifacts` in `DatabaseManager.ts`, which sweeps
 * it unconditionally rather than migrating it). */
export const legacySingleVectorDatabaseName = (namespaceId: string): string =>
  `${VECTOR_DATABASE_NAME_PREFIX}${namespaceId}`

/** On-disk record shape. `vector` is stored L2-normalized. */
export type ChunkRecord = {
  id: number
  model: string
  path: string
  mtime: number
  content: string
  content_hash: string | null
  dimension: number
  metadata: VectorMetaData
  vector: Float32Array
}

export type NewChunkRecord = Omit<ChunkRecord, 'id'>

export function openVectorDatabase(
  indexedDB: IDBFactory,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(databaseName, VECTOR_DATABASE_VERSION)
    } catch (error) {
      reject(vectorDbError('database open failed', error))
      return
    }
    let settled = false
    const fail = (message: string, cause?: unknown): void => {
      if (settled) return
      settled = true
      reject(vectorDbError(message, cause ?? request.error))
    }
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) {
        // v1 is the only version ever shipped; a nonzero oldVersion means a
        // corrupt or unknown version marker. Fail closed instead of guessing
        // how to migrate from it.
        fail(`database version ${event.oldVersion} is unsupported`)
        request.transaction?.abort()
        return
      }
      const db = request.result
      const store = db.createObjectStore(CHUNKS_STORE, {
        keyPath: 'id',
        autoIncrement: true,
      })
      store.createIndex(MODEL_INDEX, 'model', { unique: false })
      store.createIndex(MODEL_PATH_INDEX, ['model', 'path', 'mtime'], {
        unique: false,
      })
    }
    request.onerror = () => fail('database open failed')
    request.onblocked = () => fail('database open was blocked')
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      resolve(request.result)
    }
  })
}

/**
 * Key range matching every compound key that starts with `prefix`. IndexedDB
 * orders keys by type (number < date < string < binary < array) and arrays
 * lexicographically, so `[...prefix]` sorts before and `[...prefix, []]`
 * sorts after every longer key sharing that prefix whose next component is
 * a number, string, or date — which is all this schema ever stores.
 */
export function compoundKeyPrefixRange(prefix: IDBValidKey[]): IDBKeyRange {
  return IDBKeyRange.bound(prefix, [...prefix, []])
}

/** Deletes an IndexedDB database by name, resolving even if it doesn't exist. */
export function deleteVectorDatabase(
  indexedDB: IDBFactory,
  databaseName: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.deleteDatabase(databaseName)
    } catch (error) {
      reject(vectorDbError('database delete failed', error))
      return
    }
    let settled = false
    request.onsuccess = () => {
      if (settled) return
      settled = true
      resolve()
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      reject(vectorDbError('database delete failed'))
    }
    // The caller is expected to close every connection it owns before
    // calling this (`DatabaseManager.deleteKnowledgeBase` closes its own
    // connection first). A block here means some other connection is still
    // open — the data has NOT been deleted, so treat it as a failure rather
    // than pretending success; the delete request itself is left pending
    // (IndexedDB will still fire onsuccess/onerror once unblocked, but this
    // promise has already settled by then and the caller should retry).
    request.onblocked = () => {
      if (settled) return
      settled = true
      reject(vectorDbError('database delete was blocked by an open connection'))
    }
  })
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(vectorDbError('request failed', request.error))
  })
}

export function transactionCompletion(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(vectorDbError('transaction failed', transaction.error))
    transaction.onabort = () =>
      reject(vectorDbError('transaction aborted', transaction.error))
  })
}

export function vectorDbError(message: string, cause?: unknown): Error {
  const detail =
    cause instanceof Error && cause.message ? `: ${cause.message}` : ''
  return new Error(`Vector store is unavailable: ${message}${detail}`)
}
