import { App, normalizePath } from 'obsidian'

import { ensureJsonDbRootDir } from '../../../core/paths/yoloManagedData'
import type { TimelineHeightCacheSnapshot } from '../../../utils/chat/timeline-virtualization-cache'
import {
  clearTimelineHeightCache,
  hydrateTimelineHeightCache,
  listTimelineHeightCacheSnapshots,
} from '../../../utils/chat/timeline-virtualization-cache'
import { CHAT_DIR } from '../constants'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

type PersistedTimelineHeightScope = {
  widthBucket: number
  styleSignature: string
  updatedAt: number
  heights: Record<string, number>
}

type PersistedTimelineHeightCacheStore = {
  schemaVersion: 1
  updatedAt: number
  scopes: Record<string, PersistedTimelineHeightScope>
}

const TIMELINE_HEIGHT_CACHE_DIR = 'timeline_height_cache'
const SCHEMA_VERSION = 1
const MAX_SCOPES_PER_CONVERSATION = 3
const FLUSH_DEBOUNCE_MS = 1000
const EMPTY_STORE: PersistedTimelineHeightCacheStore = {
  schemaVersion: SCHEMA_VERSION,
  updatedAt: 0,
  scopes: {},
}

const conversationWriteQueue = new Map<string, Promise<void>>()
const pendingFlushTimers = new Map<string, number>()
const loadedConversationIds = new Set<string>()

const getTimelineHeightCacheDirPath = async (
  app: App,
  settings?: YoloSettingsLike | null,
) => {
  const rootDir = await ensureJsonDbRootDir(app, settings)
  return normalizePath(`${rootDir}/${CHAT_DIR}/${TIMELINE_HEIGHT_CACHE_DIR}`)
}

const getTimelineHeightCacheFilePath = async (
  app: App,
  conversationId: string,
  settings?: YoloSettingsLike | null,
) => {
  const cacheDir = await getTimelineHeightCacheDirPath(app, settings)
  return normalizePath(`${cacheDir}/${conversationId}.json`)
}

const ensureTimelineHeightCacheDir = async (
  app: App,
  settings?: YoloSettingsLike | null,
) => {
  const cacheDir = await getTimelineHeightCacheDirPath(app, settings)
  if (!(await app.vault.adapter.exists(cacheDir))) {
    await app.vault.adapter.mkdir(cacheDir)
  }
}

const readTimelineHeightCacheStore = async (
  app: App,
  conversationId: string,
  settings?: YoloSettingsLike | null,
): Promise<PersistedTimelineHeightCacheStore> => {
  const filePath = await getTimelineHeightCacheFilePath(
    app,
    conversationId,
    settings,
  )
  if (!(await app.vault.adapter.exists(filePath))) {
    return EMPTY_STORE
  }

  try {
    const content = await app.vault.adapter.read(filePath)
    const parsed = JSON.parse(content) as PersistedTimelineHeightCacheStore
    if (!parsed || typeof parsed !== 'object' || !parsed.scopes) {
      return EMPTY_STORE
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt:
        typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      scopes: parsed.scopes,
    }
  } catch (error) {
    console.error('[YOLO] Failed to read timeline height cache', error)
    return EMPTY_STORE
  }
}

const writeTimelineHeightCacheStore = async (
  app: App,
  conversationId: string,
  store: PersistedTimelineHeightCacheStore,
  settings?: YoloSettingsLike | null,
) => {
  await ensureTimelineHeightCacheDir(app, settings)
  const filePath = await getTimelineHeightCacheFilePath(
    app,
    conversationId,
    settings,
  )
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

const buildScopeKey = (snapshot: TimelineHeightCacheSnapshot) => {
  return `${snapshot.scope.widthBucket}::${snapshot.scope.styleSignature}`
}

const pruneScopes = (
  scopes: Record<string, PersistedTimelineHeightScope>,
): Record<string, PersistedTimelineHeightScope> => {
  const entries = Object.entries(scopes).sort(
    (left, right) => right[1].updatedAt - left[1].updatedAt,
  )

  return Object.fromEntries(entries.slice(0, MAX_SCOPES_PER_CONVERSATION))
}

export const hydratePersistedTimelineHeightCache = async ({
  app,
  conversationId,
  settings,
}: {
  app: App
  conversationId: string
  settings?: YoloSettingsLike | null
}) => {
  if (loadedConversationIds.has(conversationId)) {
    return
  }

  const store = await readTimelineHeightCacheStore(
    app,
    conversationId,
    settings,
  )
  const snapshots: TimelineHeightCacheSnapshot[] = Object.values(
    store.scopes,
  ).map((scope) => ({
    scope: {
      conversationId,
      widthBucket: scope.widthBucket,
      styleSignature: scope.styleSignature,
    },
    updatedAt: scope.updatedAt,
    heights: scope.heights,
  }))
  hydrateTimelineHeightCache(snapshots)
  loadedConversationIds.add(conversationId)
}

const flushPersistedTimelineHeightCacheInternal = async ({
  app,
  conversationId,
  settings,
}: {
  app: App
  conversationId: string
  settings?: YoloSettingsLike | null
}) => {
  const snapshots = listTimelineHeightCacheSnapshots(conversationId)
  const scopes = pruneScopes(
    Object.fromEntries(
      snapshots.map((snapshot) => [
        buildScopeKey(snapshot),
        {
          widthBucket: snapshot.scope.widthBucket,
          styleSignature: snapshot.scope.styleSignature,
          updatedAt: snapshot.updatedAt,
          heights: snapshot.heights,
        } satisfies PersistedTimelineHeightScope,
      ]),
    ),
  )

  await withConversationWriteLock(conversationId, async () => {
    await writeTimelineHeightCacheStore(
      app,
      conversationId,
      {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: Date.now(),
        scopes,
      },
      settings,
    )
  })
}

export const schedulePersistedTimelineHeightCacheFlush = ({
  app,
  conversationId,
  settings,
}: {
  app: App
  conversationId: string
  settings?: YoloSettingsLike | null
}) => {
  const existingTimer = pendingFlushTimers.get(conversationId)
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer)
  }

  const timeoutId = window.setTimeout(() => {
    pendingFlushTimers.delete(conversationId)
    void flushPersistedTimelineHeightCacheInternal({
      app,
      conversationId,
      settings,
    })
  }, FLUSH_DEBOUNCE_MS)

  pendingFlushTimers.set(conversationId, timeoutId)
}

export const flushPersistedTimelineHeightCache = async ({
  app,
  conversationId,
  settings,
}: {
  app: App
  conversationId: string
  settings?: YoloSettingsLike | null
}) => {
  const existingTimer = pendingFlushTimers.get(conversationId)
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer)
    pendingFlushTimers.delete(conversationId)
  }

  await flushPersistedTimelineHeightCacheInternal({
    app,
    conversationId,
    settings,
  })
}

export const clearAllTimelineHeightCacheStores = async (
  app: App,
  settings?: YoloSettingsLike | null,
) => {
  for (const timeoutId of pendingFlushTimers.values()) {
    window.clearTimeout(timeoutId)
  }
  pendingFlushTimers.clear()

  await Promise.all([...conversationWriteQueue.values()])
  clearTimelineHeightCache()
  loadedConversationIds.clear()

  const cacheDir = await getTimelineHeightCacheDirPath(app, settings)
  if (!(await app.vault.adapter.exists(cacheDir))) {
    return
  }

  const listing = await app.vault.adapter.list(cacheDir)
  for (const filePath of listing.files) {
    await app.vault.adapter.remove(filePath)
  }
}
