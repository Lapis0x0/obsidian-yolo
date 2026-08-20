import { App, normalizePath } from 'obsidian'

import { ensureUserDataRootDir } from '../../../core/paths/yoloManagedData'
import { countFileChangeStats } from '../../../utils/chat/editSummary'
import { CHAT_DIR } from '../constants'

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
   * `+N/-M`。旧快照没有这个字段，读取时按 true 兜底（它们写入时能算出数字，
   * 就说明当时没有触发这两种情况）。
   */
  lineStatsAvailable: boolean
  createdAt: number
  updatedAt: number
}

type ConversationEditReviewSnapshotStore = {
  schemaVersion: 1
  snapshots: Record<string, EditReviewSnapshot>
}

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

const SNAPSHOT_DIR = 'edit_review_snapshots'

const EMPTY_STORE: ConversationEditReviewSnapshotStore = {
  schemaVersion: 1,
  snapshots: {},
}

const conversationWriteQueue = new Map<string, Promise<void>>()

const buildSnapshotKey = (roundId: string, filePath: string): string =>
  `${roundId}::${filePath}`

const getSnapshotDirPath = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<string> => {
  const rootDir = await ensureUserDataRootDir(app, settings ?? null)
  return normalizePath(`${rootDir}/${CHAT_DIR}/${SNAPSHOT_DIR}`)
}

const getSnapshotFilePath = async (
  app: App,
  conversationId: string,
  settings?: YoloSettingsLike | null,
): Promise<string> => {
  const snapshotDir = await getSnapshotDirPath(app, settings)
  return normalizePath(`${snapshotDir}/${conversationId}.json`)
}

const ensureSnapshotDir = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  const snapshotDir = await getSnapshotDirPath(app, settings)
  if (!(await app.vault.adapter.exists(snapshotDir))) {
    await app.vault.adapter.mkdir(snapshotDir)
  }
}

const readSnapshotStore = async (
  app: App,
  conversationId: string,
  settings?: YoloSettingsLike | null,
): Promise<ConversationEditReviewSnapshotStore> => {
  const filePath = await getSnapshotFilePath(app, conversationId, settings)
  if (!(await app.vault.adapter.exists(filePath))) {
    return EMPTY_STORE
  }

  try {
    const content = await app.vault.adapter.read(filePath)
    const parsed = JSON.parse(content) as ConversationEditReviewSnapshotStore
    if (!parsed || typeof parsed !== 'object' || !parsed.snapshots) {
      return EMPTY_STORE
    }

    const snapshots = Object.fromEntries(
      Object.entries(parsed.snapshots).map(([key, snapshot]) => [
        key,
        {
          ...snapshot,
          beforeExists: snapshot.beforeExists ?? true,
          afterExists: snapshot.afterExists ?? true,
          lineStatsAvailable: snapshot.lineStatsAvailable ?? true,
        },
      ]),
    ) as Record<string, EditReviewSnapshot>

    return {
      schemaVersion: 1,
      snapshots,
    }
  } catch (error) {
    console.error('[YOLO] Failed to read edit review snapshots', error)
    return EMPTY_STORE
  }
}

const writeSnapshotStore = async (
  app: App,
  conversationId: string,
  store: ConversationEditReviewSnapshotStore,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  await ensureSnapshotDir(app, settings)
  const filePath = await getSnapshotFilePath(app, conversationId, settings)
  await app.vault.adapter.write(filePath, JSON.stringify(store, null, 2))
}

const withConversationWriteLock = async <T>(
  conversationId: string,
  task: () => Promise<T>,
): Promise<T> => {
  const previous =
    conversationWriteQueue.get(conversationId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  conversationWriteQueue.set(conversationId, tail)

  await previous

  try {
    return await task()
  } finally {
    release()
    if (conversationWriteQueue.get(conversationId) === tail) {
      conversationWriteQueue.delete(conversationId)
    }
  }
}

const waitForConversationWrites = async (
  conversationId: string,
): Promise<void> => {
  await (conversationWriteQueue.get(conversationId) ?? Promise.resolve())
}

const waitForAllConversationWrites = async (): Promise<void> => {
  await Promise.all([...conversationWriteQueue.values()])
}

export const upsertEditReviewSnapshot = async ({
  app,
  conversationId,
  roundId,
  filePath,
  beforeContent,
  afterContent,
  beforeExists = true,
  afterExists = true,
  settings,
}: {
  app: App
  conversationId: string
  roundId: string
  filePath: string
  beforeContent: string
  afterContent: string
  beforeExists?: boolean
  afterExists?: boolean
  settings?: YoloSettingsLike | null
}): Promise<EditReviewSnapshot> => {
  return withConversationWriteLock(conversationId, async () => {
    const store = await readSnapshotStore(app, conversationId, settings)
    const key = buildSnapshotKey(roundId, filePath)
    const existing = store.snapshots[key]
    const now = Date.now()
    const snapshotBeforeContent = existing?.beforeContent ?? beforeContent
    const snapshotBeforeExists = existing?.beforeExists ?? beforeExists
    const counts = countFileChangeStats({
      beforeContent: snapshotBeforeContent,
      afterContent,
      beforeExists: snapshotBeforeExists,
      afterExists,
    })

    const snapshot: EditReviewSnapshot = {
      conversationId,
      roundId,
      filePath,
      beforeContent: snapshotBeforeContent,
      afterContent,
      beforeExists: snapshotBeforeExists,
      afterExists,
      addedLines: counts.addedLines,
      removedLines: counts.removedLines,
      lineStatsAvailable: counts.lineStatsAvailable,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    await writeSnapshotStore(
      app,
      conversationId,
      {
        schemaVersion: 1,
        snapshots: {
          ...store.snapshots,
          [key]: snapshot,
        },
      },
      settings,
    )

    return snapshot
  })
}

export const readEditReviewSnapshot = async ({
  app,
  conversationId,
  roundId,
  filePath,
  settings,
}: {
  app: App
  conversationId: string
  roundId: string
  filePath: string
  settings?: YoloSettingsLike | null
}): Promise<EditReviewSnapshot | null> => {
  const store = await readSnapshotStore(app, conversationId, settings)
  return store.snapshots[buildSnapshotKey(roundId, filePath)] ?? null
}

/**
 * 一次读盘取出多个快照。
 *
 * `readEditReviewSnapshot` 每调用一次就要把整个会话的快照库读盘并 `JSON.parse`
 * 一遍，而这个库存着该会话每个 (轮次, 文件) 的前后全文，可以到数 MB。调用方
 * 需要多个快照时逐个调用，就是把同一份大 JSON 反复解析，全在主线程上。
 */
export const readEditReviewSnapshots = async ({
  app,
  conversationId,
  keys,
  settings,
}: {
  app: App
  conversationId: string
  keys: ReadonlyArray<{ roundId: string; filePath: string }>
  settings?: YoloSettingsLike | null
}): Promise<Array<EditReviewSnapshot | null>> => {
  if (keys.length === 0) {
    return []
  }
  const store = await readSnapshotStore(app, conversationId, settings)
  return keys.map(
    ({ roundId, filePath }) =>
      store.snapshots[buildSnapshotKey(roundId, filePath)] ?? null,
  )
}

export const deleteEditReviewSnapshotStore = async (
  app: App,
  conversationId: string,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  await waitForConversationWrites(conversationId)
  const filePath = await getSnapshotFilePath(app, conversationId, settings)
  if (await app.vault.adapter.exists(filePath)) {
    await app.vault.adapter.remove(filePath)
  }
}

export const clearAllEditReviewSnapshotStores = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  await waitForAllConversationWrites()
  const snapshotDir = await getSnapshotDirPath(app, settings)
  if (!(await app.vault.adapter.exists(snapshotDir))) {
    return
  }

  const listing = await app.vault.adapter.list(snapshotDir)
  for (const filePath of listing.files) {
    await app.vault.adapter.remove(filePath)
  }
}
