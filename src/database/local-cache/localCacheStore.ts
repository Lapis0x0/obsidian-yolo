import {
  type VaultDatabaseNamespaceAppStorage,
  resolveVaultDatabaseNamespaceId,
} from '../../core/storage/vaultDatabaseNamespace'
import { utf8ByteLength } from '../../utils/common/utf8-byte-length'

/**
 * Device-local cache for derived data that is expensive to recompute: encoded
 * images (vault images, rendered PDF pages, images a tool attached) and text
 * extracted from PDFs.
 *
 * It replaces two single-file JSON stores in the vault
 * (`<YOLO>/chat/image_cache/global.json`, `<YOLO>/chat/pdf_cache/global.json`).
 * Every lookup there parsed the whole file and every write serialized it back,
 * so the cost of touching one entry grew with the whole cache — the stall
 * behind knowledge-base indexing of large PDF libraries. Writes also raced
 * (read-modify-write with no lock), the cache had no size bound, and sync
 * replicated it to every device.
 *
 * Here each entry is its own record, read and written in IndexedDB
 * transactions, and never leaves the device. Content and bookkeeping live in
 * separate object stores so that measuring usage and choosing what to evict
 * reads only the small `entries` records, never the megabytes behind them.
 *
 * Everything in it is a cache: a miss must always be survivable. Chat history
 * does reference images by key (`cache://<key>`), and a history image whose
 * entry is gone is rendered as a placeholder rather than restored.
 */

/**
 * Total budget across every kind of entry. A fixed number we answer for, not
 * a share of the browser quota (which on desktop is a large fraction of the
 * disk): the user's storage is not ours to fill.
 */
export const LOCAL_CACHE_MAX_BYTES = 400 * 1024 * 1024

export type PdfTextPage = {
  page: number
  text: string
}

type LocalCacheKind = 'image' | 'pdf-text'

type LocalCacheEntry = {
  key: string
  kind: LocalCacheKind
  byteSize: number
  sourcePath: string
  createdAt: number
  lastAccessedAt: number
}

type LocalCacheValue = string | PdfTextPage[]

type LocalCacheRecord = {
  key: string
  kind: LocalCacheKind
  sourcePath: string
  value: LocalCacheValue
  byteSize: number
}

export type LocalCacheApp = VaultDatabaseNamespaceAppStorage

/** First version; there is no earlier schema to migrate from. */
const LOCAL_CACHE_DATABASE_VERSION = 1
const DATABASE_NAME_PREFIX = 'yolo-cache:'
const VALUE_STORE = 'values'
const ENTRY_STORE = 'entries'

// ---------------------------------------------------------------------------
// Keys. The algorithms are unchanged from the JSON stores on purpose: chat
// history persisted `cache://<key>` references, and imported legacy entries
// keep resolving only if the same inputs keep producing the same keys.
// ---------------------------------------------------------------------------

const fnv1aHash = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Key for an image identified by where it came from plus its version stamp:
 * a vault path (or absolute path) with mtime and size, or a URL with `0, 0`.
 * Any change to the file changes the key.
 */
export const buildImageCacheKey = (
  sourcePath: string,
  mtime: number,
  size: number,
): string => fnv1aHash(`${sourcePath}:${mtime}:${size}`)

/** Key for one rendered PDF page; a key space separate from plain images. */
export const buildPdfPageImageCacheKey = (
  pdfPath: string,
  mtime: number,
  size: number,
  page: number,
): string => fnv1aHash(`pdf:${pdfPath}:${mtime}:${size}:p${page}`)

/** Key for a vault PDF's extracted text; any file change invalidates it. */
export const buildPdfTextCacheKey = (
  vaultPath: string,
  mtime: number,
  size: number,
): string => fnv1aHash(`${vaultPath}:${mtime}:${size}`)

/**
 * Key for PDF text derived from the bytes themselves (base64), for PDFs with
 * no vault path — chat uploads, native files. The same content under any
 * name shares one entry. SHA-256 rather than fnv1a-32: with no path in the
 * key, a collision would rest entirely on the hash and silently serve another
 * document's text.
 */
export const buildPdfTextCacheKeyFromContent = async (
  base64: string,
): Promise<string> => {
  const bytes = new TextEncoder().encode(base64)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `c:${hex}`
}

// ---------------------------------------------------------------------------
// Typed operations. Failures never reach the caller: a failed lookup is a
// miss and a failed write is a warning, because a cache must not be able to
// break the feature it speeds up.
// ---------------------------------------------------------------------------

/** Returns the data URL for every key found; missing keys are absent. */
export const lookupImageDataUrls = async (
  app: LocalCacheApp,
  keys: readonly string[],
): Promise<Map<string, string>> => {
  const found = await lookupValues(app, keys, 'image')
  const result = new Map<string, string>()
  for (const [key, value] of found) {
    if (typeof value === 'string') {
      result.set(key, value)
    }
  }
  return result
}

export const writeImageDataUrls = async (
  app: LocalCacheApp,
  images: ReadonlyArray<{ key: string; dataUrl: string; sourcePath: string }>,
): Promise<void> => {
  await writeRecords(
    app,
    images.map(({ key, dataUrl, sourcePath }) => ({
      key,
      kind: 'image',
      sourcePath,
      value: dataUrl,
      byteSize: utf8ByteLength(dataUrl),
    })),
  )
}

export const lookupPdfText = async (
  app: LocalCacheApp,
  key: string,
): Promise<PdfTextPage[] | null> => {
  const found = await lookupValues(app, [key], 'pdf-text')
  const value = found.get(key)
  return Array.isArray(value) ? value : null
}

export const writePdfText = async (
  app: LocalCacheApp,
  entry: { key: string; sourcePath: string; pages: PdfTextPage[] },
): Promise<void> => {
  await writeRecords(app, [
    {
      key: entry.key,
      kind: 'pdf-text',
      sourcePath: entry.sourcePath,
      value: entry.pages,
      byteSize: entry.pages.reduce(
        (sum, page) => sum + utf8ByteLength(page.text),
        0,
      ),
    },
  ])
}

/** Bytes currently held, as counted against {@link LOCAL_CACHE_MAX_BYTES}. */
export const getLocalCacheUsageBytes = async (
  app: LocalCacheApp,
): Promise<number> => {
  await awaitLegacyImport()
  return transaction(app, 'readonly', async ({ entries }) => {
    const all = await requestResult(entries.getAll())
    return all.filter(isEntry).reduce((sum, entry) => sum + entry.byteSize, 0)
  })
}

export const clearLocalCache = async (app: LocalCacheApp): Promise<void> => {
  await awaitLegacyImport()
  await transaction(app, 'readwrite', async ({ values, entries }) => {
    await requestResult(values.clear())
    await requestResult(entries.clear())
  })
}

// ---------------------------------------------------------------------------
// Legacy import. Until it settles, every operation waits for it, so reopening
// a conversation right after an upgrade cannot miss an image that is only
// seconds away from being imported.
// ---------------------------------------------------------------------------

export type LegacyImageCacheEntry = {
  key: string
  dataUrl: string
  sourcePath: string
  lastAccessedAt: number
}

let legacyImport: Promise<void> | null = null

/**
 * Starts the one-time import of the old vault image cache. `load` returns its
 * entries (or null when there is nothing to import); `cleanup` removes the old
 * files and runs only after the entries are committed, so an interrupted
 * import simply runs again next time — writes are keyed, so repeating one is
 * harmless.
 *
 * Entries go in most recently used first and stop at the budget, so what
 * survives is what the user touched last.
 */
export const startLegacyImageCacheImport = (
  app: LocalCacheApp,
  load: () => Promise<LegacyImageCacheEntry[] | null>,
  cleanup: () => Promise<void>,
): Promise<void> => {
  if (legacyImport) {
    return legacyImport
  }
  legacyImport = (async () => {
    try {
      const legacyEntries = await load()
      if (!legacyEntries) {
        return
      }
      const ordered = [...legacyEntries].sort(
        (a, b) => b.lastAccessedAt - a.lastAccessedAt,
      )
      let budget = LOCAL_CACHE_MAX_BYTES
      const accepted: Array<LocalCacheRecord & { lastAccessedAt: number }> = []
      for (const legacy of ordered) {
        const byteSize = utf8ByteLength(legacy.dataUrl)
        if (byteSize > budget) {
          break
        }
        budget -= byteSize
        accepted.push({
          key: legacy.key,
          kind: 'image',
          sourcePath: legacy.sourcePath,
          value: legacy.dataUrl,
          byteSize,
          lastAccessedAt: legacy.lastAccessedAt,
        })
      }
      if (accepted.length > 0) {
        await transaction(app, 'readwrite', async (stores) => {
          for (const record of accepted) {
            await putRecord(stores, record, record.lastAccessedAt)
          }
          await evictOverBudget(stores, new Set())
        })
      }
      await cleanup()
    } catch (error) {
      console.warn('[YOLO] Failed to import the legacy image cache', error)
    }
  })()
  return legacyImport
}

const awaitLegacyImport = async (): Promise<void> => {
  if (legacyImport) {
    await legacyImport
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type CacheStores = { values: IDBObjectStore; entries: IDBObjectStore }

const lookupValues = async (
  app: LocalCacheApp,
  keys: readonly string[],
  kind: LocalCacheKind,
): Promise<Map<string, LocalCacheValue>> => {
  const result = new Map<string, LocalCacheValue>()
  const uniqueKeys = [...new Set(keys)]
  if (uniqueKeys.length === 0) {
    return result
  }
  try {
    await awaitLegacyImport()
    // readwrite because a hit refreshes `lastAccessedAt`: eviction is by
    // recency of use, and a lookup is the use.
    await transaction(app, 'readwrite', async ({ values, entries }) => {
      const now = Date.now()
      for (const key of uniqueKeys) {
        const entry = await requestResult(entries.get(key))
        if (!isEntry(entry) || entry.kind !== kind) {
          continue
        }
        const value = (await requestResult(values.get(key))) as
          | LocalCacheValue
          | undefined
        if (value === undefined) {
          continue
        }
        result.set(key, value)
        await requestResult(entries.put({ ...entry, lastAccessedAt: now }))
      }
    })
  } catch (error) {
    console.warn('[YOLO] Local cache lookup failed', error)
    result.clear()
  }
  return result
}

const writeRecords = async (
  app: LocalCacheApp,
  records: readonly LocalCacheRecord[],
): Promise<void> => {
  // Last write wins within a batch, and an entry larger than the whole budget
  // is never stored — it could only be written to be evicted.
  const byKey = new Map<string, LocalCacheRecord>()
  for (const record of records) {
    if (record.byteSize <= LOCAL_CACHE_MAX_BYTES) {
      byKey.set(record.key, record)
    }
  }
  if (byKey.size === 0) {
    return
  }
  try {
    await awaitLegacyImport()
    await transaction(app, 'readwrite', async (stores) => {
      const now = Date.now()
      for (const record of byKey.values()) {
        await putRecord(stores, record, now)
      }
      await evictOverBudget(stores, new Set(byKey.keys()))
    })
  } catch (error) {
    console.warn('[YOLO] Local cache write failed', error)
  }
}

const putRecord = async (
  { values, entries }: CacheStores,
  record: LocalCacheRecord,
  lastAccessedAt: number,
): Promise<void> => {
  const existing = await requestResult(entries.get(record.key))
  const entry: LocalCacheEntry = {
    key: record.key,
    kind: record.kind,
    byteSize: record.byteSize,
    sourcePath: record.sourcePath,
    createdAt: isEntry(existing) ? existing.createdAt : lastAccessedAt,
    lastAccessedAt,
  }
  await requestResult(values.put(record.value, record.key))
  await requestResult(entries.put(entry))
}

/**
 * Brings the total back under budget, least recently used first. Entries just
 * written in this transaction go last — in their batch order — so a write
 * evicts older data before it evicts itself, and the budget still holds when a
 * single batch is larger than it.
 */
const evictOverBudget = async (
  { values, entries }: CacheStores,
  justWritten: ReadonlySet<string>,
): Promise<void> => {
  const all = (await requestResult(entries.getAll())).filter(isEntry)
  let total = all.reduce((sum, entry) => sum + entry.byteSize, 0)
  if (total <= LOCAL_CACHE_MAX_BYTES) {
    return
  }
  const older = all
    .filter((entry) => !justWritten.has(entry.key))
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
  const written = [...justWritten]
    .map((key) => all.find((entry) => entry.key === key))
    .filter((entry): entry is LocalCacheEntry => entry !== undefined)
  for (const entry of [...older, ...written]) {
    if (total <= LOCAL_CACHE_MAX_BYTES) {
      break
    }
    await requestResult(values.delete(entry.key))
    await requestResult(entries.delete(entry.key))
    total -= entry.byteSize
  }
}

const isEntry = (value: unknown): value is LocalCacheEntry =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as LocalCacheEntry).key === 'string' &&
  typeof (value as LocalCacheEntry).byteSize === 'number'

type OpenConnection = { name: string; database: Promise<IDBDatabase> }

let connection: OpenConnection | null = null

const transaction = async <T>(
  app: LocalCacheApp,
  mode: IDBTransactionMode,
  operation: (stores: CacheStores) => Promise<T>,
): Promise<T> => {
  const database = await getDatabase(app)
  let idbTransaction: IDBTransaction
  try {
    idbTransaction = database.transaction([VALUE_STORE, ENTRY_STORE], mode)
  } catch (error) {
    throw localCacheError('transaction could not start', error)
  }
  const completion = transactionCompletion(idbTransaction)
  try {
    const result = await operation({
      values: idbTransaction.objectStore(VALUE_STORE),
      entries: idbTransaction.objectStore(ENTRY_STORE),
    })
    await completion
    return result
  } catch (error) {
    if (mode === 'readwrite') {
      try {
        idbTransaction.abort()
      } catch {
        // Already aborted or completed.
      }
    }
    await completion.catch(() => undefined)
    throw error
  }
}

const getDatabase = (app: LocalCacheApp): Promise<IDBDatabase> => {
  const name = `${DATABASE_NAME_PREFIX}${resolveVaultDatabaseNamespaceId(app)}`
  if (connection?.name === name) {
    return connection.database
  }
  const opening = openDatabase(name)
  const opened: OpenConnection = { name, database: opening }
  connection = opened
  void opening.then(
    (database) => {
      const disconnect = (): void => {
        if (connection === opened) {
          connection = null
        }
        database.close()
      }
      database.onversionchange = disconnect
      database.onclose = disconnect
    },
    () => {
      if (connection === opened) {
        connection = null
      }
    },
  )
  return opening
}

const openDatabase = (name: string): Promise<IDBDatabase> => {
  const indexedDB = globalThis.indexedDB
  if (!indexedDB) {
    return Promise.reject(localCacheError('IndexedDB is unavailable'))
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(name, LOCAL_CACHE_DATABASE_VERSION)
    } catch (error) {
      reject(localCacheError('database open failed', error))
      return
    }
    let settled = false
    const fail = (message: string, cause?: unknown): void => {
      if (settled) return
      settled = true
      reject(localCacheError(message, cause ?? request.error))
    }
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) {
        fail(`database version ${event.oldVersion} is unsupported`)
        request.transaction?.abort()
        return
      }
      // Values use out-of-line keys: the stored value is the raw content
      // (a data URL string or a pages array), not a wrapper object.
      request.result.createObjectStore(VALUE_STORE)
      request.result.createObjectStore(ENTRY_STORE, { keyPath: 'key' })
    }
    request.onerror = () => fail('database open failed')
    request.onblocked = () => fail('database open was blocked')
    request.onsuccess = () => {
      const database = request.result
      if (settled) {
        database.close()
        return
      }
      if (
        !database.objectStoreNames.contains(VALUE_STORE) ||
        !database.objectStoreNames.contains(ENTRY_STORE)
      ) {
        database.close()
        fail('database schema is corrupt')
        return
      }
      settled = true
      resolve(database)
    }
  })
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(localCacheError('request failed', request.error))
  })

const transactionCompletion = (idbTransaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    idbTransaction.oncomplete = () => resolve()
    idbTransaction.onerror = () =>
      reject(localCacheError('transaction failed', idbTransaction.error))
    idbTransaction.onabort = () =>
      reject(localCacheError('transaction aborted', idbTransaction.error))
  })

const localCacheError = (message: string, cause?: unknown): Error => {
  const detail =
    cause instanceof Error && cause.message ? `: ${cause.message}` : ''
  return new Error(`Local cache is unavailable: ${message}${detail}`)
}

/** Test-only: forget the module-level connection and legacy import state. */
export const resetLocalCacheStateForTests = (): void => {
  connection = null
  legacyImport = null
}
