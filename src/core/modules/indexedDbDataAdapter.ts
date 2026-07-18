import type { App, ListedFiles, Stat } from 'obsidian'

import { MAX_MODULE_PRIVATE_LIST_ENTRIES } from './modulePrivateStorage'

// This backend is unshipped, so v1 is defined directly with its final schema.
const DATABASE_VERSION = 1
const ENTRY_STORE = 'entries'
const PARENT_KIND_INDEX = 'by-parent-kind'
const DATABASE_NAME_PREFIX = 'yolo-module-device-local:'
const LIST_QUERY_LIMIT = MAX_MODULE_PRIVATE_LIST_ENTRIES + 1

export const MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY =
  'yolo-module-device-local-database-namespace'

type AppLocalStorage = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>

type StoredRecord =
  | Readonly<{
      version: 1
      path: string
      parent: string
      kind: 'folder'
      type: 'folder'
      ctime: number
      mtime: number
      size: 0
    }>
  | Readonly<{
      version: 1
      path: string
      parent: string
      kind: 'file'
      type: 'text'
      ctime: number
      mtime: number
      size: number
      data: string
    }>
  | Readonly<{
      version: 1
      path: string
      parent: string
      kind: 'file'
      type: 'binary'
      ctime: number
      mtime: number
      size: number
      data: ArrayBuffer
    }>

export type IndexedDbDataAdapterOptions = Readonly<{
  indexedDB?: IDBFactory | null
  createNamespaceId?: () => string
}>

/** A vault-isolated DataAdapter subset backed by one IndexedDB record per path. */
export class IndexedDbDataAdapter {
  private databasePromise: Promise<IDBDatabase> | null = null
  private database: IDBDatabase | null = null
  private closed = false

  constructor(
    private readonly app: AppLocalStorage,
    private readonly options: IndexedDbDataAdapterOptions = {},
  ) {}

  async stat(path: string): Promise<Stat | null> {
    const normalizedPath = normalizePath(path)
    return this.readTransaction(async (store) => {
      const record = parseOptionalRecord(
        await requestResult(store.get(normalizedPath)),
        normalizedPath,
      )
      return record ? toStat(record) : null
    })
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null
  }

  async list(path: string): Promise<ListedFiles> {
    const normalizedPath = normalizePath(path)
    return this.readTransaction(async (store) => {
      const folder = parseOptionalRecord(
        await requestResult(store.get(normalizedPath)),
        normalizedPath,
      )
      if (folder?.type !== 'folder') return { files: [], folders: [] }

      const files: string[] = []
      const folders: string[] = []
      const children = await listChildKeys(
        store.index(PARENT_KIND_INDEX),
        normalizedPath,
        LIST_QUERY_LIMIT,
      )
      for (const child of children) {
        if (child.kind === 'folder') folders.push(child.path)
        else files.push(child.path)
      }
      files.sort()
      folders.sort()
      return { files, folders }
    })
  }

  async read(path: string): Promise<string> {
    const normalizedPath = normalizePath(path)
    return this.readTransaction(async (store) => {
      const record = parseOptionalRecord(
        await requestResult(store.get(normalizedPath)),
        normalizedPath,
      )
      if (record?.type !== 'text') throw unreadableError(normalizedPath)
      return record.data
    })
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const normalizedPath = normalizePath(path)
    return this.readTransaction(async (store) => {
      const record = parseOptionalRecord(
        await requestResult(store.get(normalizedPath)),
        normalizedPath,
      )
      if (record?.type !== 'binary') throw unreadableError(normalizedPath)
      return record.data
    })
  }

  async write(path: string, data: string): Promise<void> {
    if (typeof data !== 'string') {
      throw new TypeError('IndexedDB file content must be a string')
    }
    await this.writeFile(normalizePath(path), 'text', data)
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    if (!(data instanceof ArrayBuffer)) {
      throw new TypeError('IndexedDB file content must be an ArrayBuffer')
    }
    await this.writeFile(normalizePath(path), 'binary', copyArrayBuffer(data))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const database = this.database
    this.database = null
    this.databasePromise = null
    database?.close()
  }

  dispose(): void {
    this.close()
  }

  async mkdir(path: string): Promise<void> {
    const normalizedPath = normalizePath(path)
    await this.writeTransaction(async (store) => {
      await assertParentFolder(store, normalizedPath)
      const existing = parseOptionalRecord(
        await requestResult(store.get(normalizedPath)),
        normalizedPath,
      )
      if (existing?.type === 'folder') return
      if (existing) throw new Error(`IndexedDB path is a file: ${path}`)
      const now = Date.now()
      await requestResult(
        store.add({
          version: 1,
          path: normalizedPath,
          parent: parentPath(normalizedPath),
          kind: 'folder',
          type: 'folder',
          ctime: now,
          mtime: now,
          size: 0,
        } satisfies StoredRecord),
      )
    })
  }

  async rename(from: string, to: string): Promise<void> {
    const normalizedFrom = normalizePath(from)
    const normalizedTo = normalizePath(to)
    if (normalizedFrom === normalizedTo) return
    if (
      normalizedFrom.startsWith(`${normalizedTo}/`) ||
      normalizedTo.startsWith(`${normalizedFrom}/`)
    ) {
      throw new Error(
        'IndexedDB rename paths must not be ancestors of each other',
      )
    }

    await this.writeTransaction(async (store) => {
      const source = parseOptionalRecord(
        await requestResult(store.get(normalizedFrom)),
        normalizedFrom,
      )
      if (!source) throw new Error(`IndexedDB source does not exist: ${from}`)

      await assertParentFolder(store, normalizedTo)
      const destination = parseOptionalRecord(
        await requestResult(store.get(normalizedTo)),
        normalizedTo,
      )
      const destinationDescendants = await listDescendantRecords(
        store,
        normalizedTo,
      )
      if (destination || destinationDescendants.length > 0) {
        throw new Error(`IndexedDB destination already exists: ${to}`)
      }

      const descendants = await listDescendantRecords(store, normalizedFrom)
      if (source.type !== 'folder' && descendants.length > 0) {
        throw corruptionError(normalizedFrom)
      }
      const sourceRecords = [source, ...descendants]
      for (const record of sourceRecords) {
        const suffix = record.path.slice(normalizedFrom.length)
        const destinationPath = `${normalizedTo}${suffix}`
        await requestResult(store.add(relocateRecord(record, destinationPath)))
      }
      for (const record of sourceRecords) {
        await requestResult(store.delete(record.path))
      }
    })
  }

  async remove(path: string): Promise<void> {
    const normalizedPath = normalizePath(path)
    await this.writeTransaction(async (store) => {
      const existing = parseOptionalRecord(
        await requestResult(store.get(normalizedPath)),
        normalizedPath,
      )
      if (!existing) return
      if (existing.type === 'folder') {
        const descendants = await listDescendantRecords(store, normalizedPath)
        for (const record of descendants) {
          await requestResult(store.delete(record.path))
        }
      }
      await requestResult(store.delete(normalizedPath))
    })
  }

  private async writeFile(
    path: string,
    type: 'text' | 'binary',
    data: string | ArrayBuffer,
  ): Promise<void> {
    await this.writeTransaction(async (store) => {
      await assertParentFolder(store, path)
      const existing = parseOptionalRecord(
        await requestResult(store.get(path)),
        path,
      )
      if (existing?.type === 'folder') {
        throw new Error(`IndexedDB path is a folder: ${path}`)
      }
      const now = Date.now()
      const ctime = existing?.ctime ?? now
      if (type === 'text') {
        const text = data as string
        await requestResult(
          store.put({
            version: 1,
            path,
            parent: parentPath(path),
            kind: 'file',
            type,
            ctime,
            mtime: now,
            size: textByteLength(text),
            data: text,
          } satisfies StoredRecord),
        )
      } else {
        const binary = data as ArrayBuffer
        await requestResult(
          store.put({
            version: 1,
            path,
            parent: parentPath(path),
            kind: 'file',
            type,
            ctime,
            mtime: now,
            size: binary.byteLength,
            data: binary,
          } satisfies StoredRecord),
        )
      }
    })
  }

  private async readTransaction<T>(
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    return this.transaction('readonly', operation)
  }

  private async writeTransaction<T>(
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    return this.transaction('readwrite', operation)
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const database = await this.getDatabase()
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(ENTRY_STORE, mode)
    } catch (error) {
      throw indexedDbError('transaction could not start', error)
    }
    const completion = transactionCompletion(transaction)
    try {
      const result = await operation(transaction.objectStore(ENTRY_STORE))
      await completion
      return result
    } catch (error) {
      if (mode === 'readwrite') {
        try {
          transaction.abort()
        } catch {
          // The transaction may already have aborted or completed.
        }
      }
      await completion.catch(() => undefined)
      throw error
    }
  }

  private getDatabase(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(closedError())
    if (this.database) return Promise.resolve(this.database)
    if (this.databasePromise) return this.databasePromise

    const opening = this.openDatabase().then((database) => {
      if (this.closed) {
        database.close()
        throw closedError()
      }
      this.database = database
      const disconnect = (): void => {
        if (this.database === database) {
          this.database = null
          this.databasePromise = null
        }
        database.close()
      }
      database.onversionchange = disconnect
      database.onclose = disconnect
      return database
    })
    this.databasePromise = opening
    void opening.catch(() => {
      if (this.databasePromise === opening) this.databasePromise = null
    })
    return opening
  }

  private async openDatabase(): Promise<IDBDatabase> {
    const namespaceId = this.resolveNamespaceId()
    const indexedDB = this.resolveIndexedDb()
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(
        `${DATABASE_NAME_PREFIX}${namespaceId}`,
        DATABASE_VERSION,
      )
    } catch (error) {
      throw indexedDbError('database open failed', error)
    }
    return new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false
      const fail = (message: string, cause?: unknown): void => {
        if (settled) return
        settled = true
        reject(indexedDbError(message, cause ?? request.error))
      }
      request.onupgradeneeded = (event) => {
        const oldVersion = event.oldVersion
        if (oldVersion !== 0) {
          fail(`database version ${oldVersion} is unsupported`)
          request.transaction?.abort()
          return
        }
        const store = request.result.createObjectStore(ENTRY_STORE, {
          keyPath: 'path',
          autoIncrement: false,
        })
        store.createIndex(PARENT_KIND_INDEX, ['parent', 'kind'], {
          unique: false,
          multiEntry: false,
        })
      }
      request.onerror = () => fail('database open failed')
      request.onblocked = () => fail('database open was blocked')
      request.onsuccess = () => {
        const database = request.result
        if (settled) {
          database.close()
          return
        }
        if (!database.objectStoreNames.contains(ENTRY_STORE)) {
          database.close()
          fail('database schema is corrupt')
          return
        }
        try {
          assertDatabaseSchema(database)
        } catch (error) {
          database.close()
          fail('database schema is corrupt', error)
          return
        }
        settled = true
        resolve(database)
      }
    })
  }

  private resolveIndexedDb(): IDBFactory {
    const indexedDB = Object.prototype.hasOwnProperty.call(
      this.options,
      'indexedDB',
    )
      ? this.options.indexedDB
      : globalThis.indexedDB
    if (!indexedDB) {
      throw new Error(
        'Module device-local storage is unavailable: IndexedDB is unavailable',
      )
    }
    return indexedDB
  }

  private resolveNamespaceId(): string {
    let stored: unknown
    try {
      stored = this.app.loadLocalStorage(
        MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY,
      )
    } catch (error) {
      throw indexedDbError('vault database namespace read failed', error)
    }
    if (stored !== null && stored !== undefined) {
      if (!isNamespaceId(stored)) {
        throw new Error(
          'Module device-local storage is unavailable: vault database namespace is malformed',
        )
      }
      return stored
    }

    let namespaceId: string
    try {
      namespaceId = (this.options.createNamespaceId ?? createNamespaceId)()
    } catch (error) {
      throw indexedDbError('vault database namespace generation failed', error)
    }
    if (!isNamespaceId(namespaceId)) {
      throw new Error(
        'Module device-local storage is unavailable: generated vault database namespace is malformed',
      )
    }
    try {
      this.app.saveLocalStorage(
        MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY,
        namespaceId,
      )
    } catch (error) {
      throw indexedDbError('vault database namespace write failed', error)
    }
    return namespaceId
  }
}

async function assertParentFolder(
  store: IDBObjectStore,
  path: string,
): Promise<void> {
  const separator = path.lastIndexOf('/')
  if (separator === -1) return
  const parent = path.slice(0, separator)
  const record = parseOptionalRecord(
    await requestResult(store.get(parent)),
    parent,
  )
  if (record?.type !== 'folder') {
    throw new Error(`IndexedDB parent folder does not exist: ${parent}`)
  }
}

async function listDescendantRecords(
  store: IDBObjectStore,
  path: string,
): Promise<StoredRecord[]> {
  const prefix = `${path}/`
  const paths = await new Promise<string[]>((resolve, reject) => {
    const descendants: string[] = []
    const request = store.openKeyCursor()
    request.onerror = () =>
      reject(indexedDbError('subtree query failed', request.error))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(descendants)
        return
      }
      const key = cursor.primaryKey
      if (typeof key !== 'string' || key < prefix) {
        cursor.continue(prefix)
        return
      }
      if (key.startsWith(prefix)) {
        descendants.push(key)
        cursor.continue()
        return
      }
      resolve(descendants)
    }
  })
  const records: StoredRecord[] = []
  for (const descendantPath of paths) {
    const record = parseOptionalRecord(
      await requestResult(store.get(descendantPath)),
      descendantPath,
    )
    if (!record) throw corruptionError(descendantPath)
    records.push(record)
  }
  return records
}

function relocateRecord(record: StoredRecord, path: string): StoredRecord {
  return {
    ...record,
    path,
    parent: parentPath(path),
  }
}

type ListedChild = Readonly<{ path: string; kind: 'file' | 'folder' }>

function listChildKeys(
  index: IDBIndex,
  parent: string,
  limit: number,
): Promise<ListedChild[]> {
  return new Promise<ListedChild[]>((resolve, reject) => {
    const children: ListedChild[] = []
    let pending = 2
    let settled = false
    const completeRequest = (): void => {
      pending -= 1
      if (pending === 0 && !settled) {
        settled = true
        resolve(children)
      }
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(
        error instanceof Error
          ? error
          : indexedDbError('list query failed', error),
      )
    }

    for (const kind of ['file', 'folder'] as const) {
      const request = index.openKeyCursor([parent, kind])
      let requestComplete = false
      request.onerror = () =>
        fail(indexedDbError('list query failed', request.error))
      request.onsuccess = () => {
        if (settled || requestComplete) return
        const cursor = request.result
        if (!cursor || children.length >= limit) {
          requestComplete = true
          completeRequest()
          return
        }
        try {
          const key = cursor.key
          const path = cursor.primaryKey
          if (
            !Array.isArray(key) ||
            key.length !== 2 ||
            key[0] !== parent ||
            key[1] !== kind ||
            typeof path !== 'string' ||
            !isNormalizedPath(path) ||
            parentPath(path) !== parent
          ) {
            throw corruptionError(typeof path === 'string' ? path : 'unknown')
          }
          children.push({ path, kind })
        } catch (error) {
          fail(error)
          return
        }
        if (children.length >= limit) {
          requestComplete = true
          completeRequest()
        } else {
          cursor.continue()
        }
      }
    }
  })
}

function assertDatabaseSchema(database: IDBDatabase): void {
  if (
    database.objectStoreNames.length !== 1 ||
    !database.objectStoreNames.contains(ENTRY_STORE)
  ) {
    throw new Error('unexpected object stores')
  }
  const store = database
    .transaction(ENTRY_STORE, 'readonly')
    .objectStore(ENTRY_STORE)
  if (store.keyPath !== 'path' || store.autoIncrement) {
    throw new Error('entry store key configuration is invalid')
  }
  if (
    store.indexNames.length !== 1 ||
    !store.indexNames.contains(PARENT_KIND_INDEX)
  ) {
    throw new Error('entry store index is missing')
  }
  const index = store.index(PARENT_KIND_INDEX)
  if (
    !Array.isArray(index.keyPath) ||
    index.keyPath.length !== 2 ||
    index.keyPath[0] !== 'parent' ||
    index.keyPath[1] !== 'kind' ||
    index.unique ||
    index.multiEntry
  ) {
    throw new Error('entry store index configuration is invalid')
  }
}

function normalizePath(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.normalize('NFC') !== path
  ) {
    throw new Error('IndexedDB path must be a normalized relative path')
  }
  const segments = path.split('/')
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('IndexedDB path must be a normalized relative path')
  }
  return path
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator === -1 ? '' : path.slice(0, separator)
}

function parseOptionalRecord(
  raw: unknown,
  expectedPath: string,
): StoredRecord | null {
  if (raw === undefined) return null
  const record = parseRecord(raw)
  if (record.path !== expectedPath) throw corruptionError(expectedPath)
  return record
}

function parseRecord(raw: unknown): StoredRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw corruptionError('unknown')
  }
  const record = raw as Record<string, unknown>
  const path = record.path
  if (
    record.version !== 1 ||
    typeof path !== 'string' ||
    !isNormalizedPath(path) ||
    typeof record.parent !== 'string' ||
    record.parent !== parentPath(path) ||
    !isTimestamp(record.ctime) ||
    !isTimestamp(record.mtime) ||
    record.mtime < record.ctime ||
    typeof record.size !== 'number' ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0
  ) {
    throw corruptionError(typeof path === 'string' ? path : 'unknown')
  }
  if (record.type === 'folder') {
    if (
      record.kind !== 'folder' ||
      record.size !== 0 ||
      !hasExactKeys(record, FOLDER_KEYS)
    ) {
      throw corruptionError(path)
    }
    return record as StoredRecord
  }
  if (record.type === 'text') {
    if (
      record.kind !== 'file' ||
      typeof record.data !== 'string' ||
      record.size !== textByteLength(record.data) ||
      !hasExactKeys(record, FILE_KEYS)
    ) {
      throw corruptionError(path)
    }
    return record as StoredRecord
  }
  if (record.type === 'binary') {
    if (
      record.kind !== 'file' ||
      !(record.data instanceof ArrayBuffer) ||
      record.size !== record.data.byteLength ||
      !hasExactKeys(record, FILE_KEYS)
    ) {
      throw corruptionError(path)
    }
    return record as StoredRecord
  }
  throw corruptionError(path)
}

const FOLDER_KEYS = [
  'ctime',
  'kind',
  'mtime',
  'parent',
  'path',
  'size',
  'type',
  'version',
]
const FILE_KEYS = [...FOLDER_KEYS, 'data'].sort()

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function isNormalizedPath(path: string): boolean {
  try {
    return normalizePath(path) === path
  } catch {
    return false
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNamespaceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
}

function createNamespaceId(): string {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues)
    throw new Error('secure randomness is unavailable')
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

function toStat(record: StoredRecord): Stat {
  return {
    type: record.type === 'folder' ? 'folder' : 'file',
    ctime: record.ctime,
    mtime: record.mtime,
    size: record.size,
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(indexedDbError('request failed', request.error))
  })
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(indexedDbError('transaction failed', transaction.error))
    transaction.onabort = () =>
      reject(indexedDbError('transaction aborted', transaction.error))
  })
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function copyArrayBuffer(value: ArrayBuffer): ArrayBuffer {
  return new Uint8Array(value).slice().buffer
}

function unreadableError(path: string): Error {
  return new Error(`IndexedDB file is missing or has the wrong type: ${path}`)
}

function corruptionError(path: string): Error {
  return new Error(`Module device-local IndexedDB record is corrupt: ${path}`)
}

function indexedDbError(message: string, cause?: unknown): Error {
  const detail =
    cause instanceof Error && cause.message ? `: ${cause.message}` : ''
  return new Error(
    `Module device-local storage is unavailable: ${message}${detail}`,
  )
}

function closedError(): Error {
  return new Error('Module device-local storage adapter is closed')
}
