import { App, normalizePath } from 'obsidian'

import { ensureJsonDbRootDir } from '../../../core/paths/yoloManagedData'
import { countChangedLines } from '../../../utils/chat/editSummary'
import { CHAT_DIR } from '../constants'

export type EditReviewSnapshot = {
  conversationId: string
  roundId: string
  filePath: string
  beforeContent: string
  afterContent: string
  addedLines: number
  removedLines: number
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
  const rootDir = await ensureJsonDbRootDir(app, settings)
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

    return {
      schemaVersion: 1,
      snapshots: parsed.snapshots,
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
  settings,
}: {
  app: App
  conversationId: string
  roundId: string
  filePath: string
  beforeContent: string
  afterContent: string
  settings?: YoloSettingsLike | null
}): Promise<EditReviewSnapshot> => {
  return withConversationWriteLock(conversationId, async () => {
    const store = await readSnapshotStore(app, conversationId, settings)
    const key = buildSnapshotKey(roundId, filePath)
    const existing = store.snapshots[key]
    const now = Date.now()
    const snapshotBeforeContent = existing?.beforeContent ?? beforeContent
    const counts = countChangedLines(snapshotBeforeContent, afterContent)

    const snapshot: EditReviewSnapshot = {
      conversationId,
      roundId,
      filePath,
      beforeContent: snapshotBeforeContent,
      afterContent,
      addedLines: counts.addedLines,
      removedLines: counts.removedLines,
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
