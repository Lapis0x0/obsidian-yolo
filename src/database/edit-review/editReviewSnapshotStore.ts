import {
  type VaultDatabaseNamespaceAppStorage,
  resolveVaultDatabaseNamespaceId,
} from '../../core/storage/vaultDatabaseNamespace'
import { countFileChangeStats } from '../../utils/chat/editSummary'

/**
 * Edit review snapshots are device-local working state, not user data.
 *
 * They used to live in the vault (`<YOLO>/chat/edit_review_snapshots/<id>.json`,
 * one JSON file per conversation holding the before/after full text of every
 * (round, file) that conversation ever touched). That was wrong twice over:
 * every single edit rewrote the whole conversation file (cost O(the whole edit
 * history)), and Obsidian Sync / iCloud / git replicated megabytes of
 * throwaway diff material to every device. The chat history itself already
 * carries the `editSummary` that renders the card; only "open the diff" and
 * "undo" need the snapshot, and both are inherently local actions.
 *
 * So this is IndexedDB, one record per (conversation, round, file) — a single
 * read and a single write per edit, and nothing leaves the device. Nothing
 * migrated: the old directory is derived data and is deleted on startup (see
 * `LEGACY_CHAT_CACHE_DIR_NAMES` in `core/paths/yoloManagedData.ts`).
 */
export type EditReviewSnapshot = {
  conversationId: string
  roundId: string
  filePath: string
  beforeContent: string
  afterContent: string
  beforeExists: boolean
  afterExists: boolean
  addedLines: number
  removedLines: number
  /**
   * 行数是否可信。规模过大或 diff 超时的快照拿不到准确行数，UI 据此隐藏
   * `+N/-M`。
   */
  lineStatsAvailable: boolean
  /**
   * 是否保留了改前/改后全文。false 时 `beforeContent` / `afterContent` 都是空
   * 串——内容超过 {@link MAX_SNAPSHOT_CONTENT_CHARS} 时只记账不存正文，撤销与
   * 评审据此提示不可用。行数仍然是写入当时按真实内容算出来的。
   */
  contentAvailable: boolean
  createdAt: number
  updatedAt: number
}

/**
 * 单侧内容上限。超过就只留元数据，不把正文写进 IndexedDB——`edit_file` 之外的
 * 写入路径允许改动到 16MB 的文件，两侧全文一起存下来就是每次编辑往设备数据库
 * 里塞几十 MB。取 2MB 与 `core/tools/tool-args.ts` 的 `MAX_FILE_SIZE_BYTES`
 * 同值：那是工具愿意整份读进内存的上限，也就是快照可能拿到的常规最大值。
 */
export const MAX_SNAPSHOT_CONTENT_CHARS = 2 * 1024 * 1024

/** 见 `vectorDatabase.ts`：本库同样是首个版本，没有可迁移的前代 schema。 */
const EDIT_REVIEW_DATABASE_VERSION = 1
const DATABASE_NAME_PREFIX = 'yolo-edit-review:'
const SNAPSHOT_STORE = 'snapshots'

/**
 * 主键就是 `[conversationId, roundId, filePath]` 复合键，所以「按会话读 / 按
 * 会话删」是主键上的一段区间，不需要再建一个 `conversationId` 索引来重复表达
 * 同一件事。
 */
const SNAPSHOT_KEY_PATH = ['conversationId', 'roundId', 'filePath']

export type EditReviewSnapshotApp = VaultDatabaseNamespaceAppStorage

const UNAVAILABLE_LINE_STATS = {
  addedLines: 0,
  removedLines: 0,
  lineStatsAvailable: false,
} as const

export const upsertEditReviewSnapshot = async ({
  app,
  conversationId,
  roundId,
  filePath,
  beforeContent,
  afterContent,
  beforeExists = true,
  afterExists = true,
}: {
  app: EditReviewSnapshotApp
  conversationId: string
  roundId: string
  filePath: string
  beforeContent: string
  afterContent: string
  beforeExists?: boolean
  afterExists?: boolean
}): Promise<EditReviewSnapshot> => {
  return transaction(app, 'readwrite', async (store) => {
    const existing = parseSnapshot(
      await requestResult(store.get([conversationId, roundId, filePath])),
    )
    const now = Date.now()

    // 同一轮同一文件被多次编辑时，改前内容永远是最初那一次的——本轮的评审
    // diff 比的是「这一轮开始前」与「现在」。
    const knownBeforeContent = existing
      ? existing.contentAvailable
        ? existing.beforeContent
        : null
      : beforeContent
    const snapshotBeforeExists = existing?.beforeExists ?? beforeExists

    const counts =
      knownBeforeContent === null
        ? UNAVAILABLE_LINE_STATS
        : countFileChangeStats({
            beforeContent: knownBeforeContent,
            afterContent,
            beforeExists: snapshotBeforeExists,
            afterExists,
          })

    const contentAvailable =
      knownBeforeContent !== null &&
      knownBeforeContent.length <= MAX_SNAPSHOT_CONTENT_CHARS &&
      afterContent.length <= MAX_SNAPSHOT_CONTENT_CHARS

    const snapshot: EditReviewSnapshot = {
      conversationId,
      roundId,
      filePath,
      beforeContent: contentAvailable ? (knownBeforeContent ?? '') : '',
      afterContent: contentAvailable ? afterContent : '',
      beforeExists: snapshotBeforeExists,
      afterExists,
      addedLines: counts.addedLines,
      removedLines: counts.removedLines,
      lineStatsAvailable: counts.lineStatsAvailable,
      contentAvailable,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    await requestResult(store.put(snapshot))
    return snapshot
  })
}

export const readEditReviewSnapshot = async ({
  app,
  conversationId,
  roundId,
  filePath,
}: {
  app: EditReviewSnapshotApp
  conversationId: string
  roundId: string
  filePath: string
}): Promise<EditReviewSnapshot | null> => {
  const [snapshot] = await readEditReviewSnapshots({
    app,
    conversationId,
    keys: [{ roundId, filePath }],
  })
  return snapshot ?? null
}

/** 一次事务取出多个快照，供聊天卡片一次性补齐整组文件的行数。 */
export const readEditReviewSnapshots = async ({
  app,
  conversationId,
  keys,
}: {
  app: EditReviewSnapshotApp
  conversationId: string
  keys: ReadonlyArray<{ roundId: string; filePath: string }>
}): Promise<Array<EditReviewSnapshot | null>> => {
  if (keys.length === 0) {
    return []
  }
  return transaction(app, 'readonly', async (store) => {
    const results: Array<EditReviewSnapshot | null> = []
    for (const { roundId, filePath } of keys) {
      results.push(
        parseSnapshot(
          await requestResult(store.get([conversationId, roundId, filePath])),
        ) ?? null,
      )
    }
    return results
  })
}

export const deleteEditReviewSnapshotStore = async (
  app: EditReviewSnapshotApp,
  conversationId: string,
): Promise<void> => {
  await transaction(app, 'readwrite', async (store) => {
    await requestResult(store.delete(conversationKeyRange(conversationId)))
  })
}

export const clearAllEditReviewSnapshotStores = async (
  app: EditReviewSnapshotApp,
): Promise<void> => {
  await transaction(app, 'readwrite', async (store) => {
    await requestResult(store.clear())
  })
}

/**
 * 复合主键上「以 conversationId 开头」的那一段。IndexedDB 按类型再按字典序排
 * 数组键，`[id]` 排在所有更长的 `[id, ...]` 之前，而 `[id, []]` 排在它们之后
 * （数组大于数字/字符串/日期，本 schema 的后续分量只有字符串）。
 */
const conversationKeyRange = (conversationId: string): IDBKeyRange =>
  IDBKeyRange.bound([conversationId], [conversationId, []])

const parseSnapshot = (value: unknown): EditReviewSnapshot | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  return value as EditReviewSnapshot
}

type OpenConnection = { name: string; database: Promise<IDBDatabase> }

let connection: OpenConnection | null = null

const transaction = async <T>(
  app: EditReviewSnapshotApp,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> => {
  const database = await getDatabase(app)
  let idbTransaction: IDBTransaction
  try {
    idbTransaction = database.transaction(SNAPSHOT_STORE, mode)
  } catch (error) {
    throw snapshotDbError('transaction could not start', error)
  }
  const completion = transactionCompletion(idbTransaction)
  try {
    const result = await operation(idbTransaction.objectStore(SNAPSHOT_STORE))
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

const getDatabase = (app: EditReviewSnapshotApp): Promise<IDBDatabase> => {
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
    throw snapshotDbError('IndexedDB is unavailable')
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(name, EDIT_REVIEW_DATABASE_VERSION)
    } catch (error) {
      reject(snapshotDbError('database open failed', error))
      return
    }
    let settled = false
    const fail = (message: string, cause?: unknown): void => {
      if (settled) return
      settled = true
      reject(snapshotDbError(message, cause ?? request.error))
    }
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) {
        // v1 是唯一发布过的版本；非零 oldVersion 只可能是损坏或未知的版本
        // 标记，不去猜怎么迁移。
        fail(`database version ${event.oldVersion} is unsupported`)
        request.transaction?.abort()
        return
      }
      request.result.createObjectStore(SNAPSHOT_STORE, {
        keyPath: SNAPSHOT_KEY_PATH,
        autoIncrement: false,
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
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
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
      reject(snapshotDbError('request failed', request.error))
  })

const transactionCompletion = (idbTransaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    idbTransaction.oncomplete = () => resolve()
    idbTransaction.onerror = () =>
      reject(snapshotDbError('transaction failed', idbTransaction.error))
    idbTransaction.onabort = () =>
      reject(snapshotDbError('transaction aborted', idbTransaction.error))
  })

const snapshotDbError = (message: string, cause?: unknown): Error => {
  const detail =
    cause instanceof Error && cause.message ? `: ${cause.message}` : ''
  return new Error(`Edit review snapshots are unavailable: ${message}${detail}`)
}
