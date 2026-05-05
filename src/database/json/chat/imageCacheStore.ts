import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

import { ensureJsonDbRootDir } from '../../../core/paths/yoloManagedData'
import { CHAT_DIR } from '../constants'

type ImageCacheEntry = {
  hash: string
  dataUrl: string
  sourcePath: string
  createdAt: number
  lastAccessedAt: number
}

type ImageCacheStore = {
  schemaVersion: 1
  entries: Record<string, ImageCacheEntry>
}

const IMAGE_CACHE_DIR = 'image_cache'
const CACHE_FILE_NAME = 'global.json'

const EMPTY_STORE: ImageCacheStore = {
  schemaVersion: 1,
  entries: {},
}

export type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

const fnv1aHash = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const buildImageCacheKey = (
  vaultPath: string,
  mtime: number,
  size: number,
): string => fnv1aHash(`${vaultPath}:${mtime}:${size}`)

/**
 * Build a cache key for a single rendered PDF page.
 * Key space is separate from markdown image keys (different input format).
 */
export const buildPdfPageImageCacheKey = (
  pdfPath: string,
  mtime: number,
  size: number,
  page: number,
): string => fnv1aHash(`pdf:${pdfPath}:${mtime}:${size}:p${page}`)

const getCacheDirPath = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<string> => {
  const rootDir = await ensureJsonDbRootDir(app, settings)
  return normalizePath(path.join(rootDir, CHAT_DIR, IMAGE_CACHE_DIR))
}

const getCacheFilePath = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<string> => {
  const cacheDir = await getCacheDirPath(app, settings)
  return normalizePath(path.join(cacheDir, CACHE_FILE_NAME))
}

const ensureCacheDir = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  const cacheDir = await getCacheDirPath(app, settings)
  if (!(await app.vault.adapter.exists(cacheDir))) {
    await app.vault.adapter.mkdir(cacheDir)
  }
}

const readCacheStore = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<ImageCacheStore> => {
  const filePath = await getCacheFilePath(app, settings)
  if (!(await app.vault.adapter.exists(filePath))) {
    return EMPTY_STORE
  }

  try {
    const content = await app.vault.adapter.read(filePath)
    const parsed = JSON.parse(content) as ImageCacheStore
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      return EMPTY_STORE
    }
    return {
      schemaVersion: 1,
      entries: parsed.entries,
    }
  } catch (error) {
    console.error('[YOLO] Failed to read image cache store', error)
    return EMPTY_STORE
  }
}

const writeCacheStore = async (
  app: App,
  store: ImageCacheStore,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  await ensureCacheDir(app, settings)
  const filePath = await getCacheFilePath(app, settings)
  await app.vault.adapter.write(filePath, JSON.stringify(store))
}

/**
 * Look up a cached image by its hash.
 * Returns the dataUrl if found, null otherwise.
 * Read-only — does not update lastAccessedAt to avoid write contention.
 * lastAccessedAt is updated during batch write / prune operations.
 */
export const lookupImageCache = async (
  app: App,
  hash: string,
  settings?: YoloSettingsLike | null,
): Promise<string | null> => {
  const store = await readCacheStore(app, settings)
  const entry = store.entries[hash]
  return entry?.dataUrl ?? null
}

/**
 * Write a single image cache entry.
 */
export const writeImageCacheEntry = async (
  app: App,
  entry: Omit<ImageCacheEntry, 'createdAt' | 'lastAccessedAt'>,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  const store = await readCacheStore(app, settings)
  const now = Date.now()
  store.entries[entry.hash] = {
    ...entry,
    createdAt: store.entries[entry.hash]?.createdAt ?? now,
    lastAccessedAt: now,
  }
  await writeCacheStore(app, store, settings)
}

/**
 * Remove cache entries not accessed within maxAgeDays.
 * Returns the number of pruned entries.
 */
export const pruneImageCache = async (
  app: App,
  maxAgeDays: number,
  settings?: YoloSettingsLike | null,
): Promise<number> => {
  const store = await readCacheStore(app, settings)
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const originalCount = Object.keys(store.entries).length

  const filtered = Object.fromEntries(
    Object.entries(store.entries).filter(
      ([, entry]) => entry.lastAccessedAt >= cutoff,
    ),
  )

  const pruned = originalCount - Object.keys(filtered).length
  if (pruned > 0) {
    await writeCacheStore(
      app,
      { schemaVersion: 1, entries: filtered },
      settings,
    )
  }

  return pruned
}

/**
 * Batch lookup: returns a map of hash → dataUrl for all found entries.
 * Read-only — does not update lastAccessedAt to avoid write contention.
 */
export const batchLookupImageCache = async (
  app: App,
  hashes: string[],
  settings?: YoloSettingsLike | null,
): Promise<Map<string, string>> => {
  if (hashes.length === 0) return new Map()

  const store = await readCacheStore(app, settings)
  const result = new Map<string, string>()

  for (const hash of hashes) {
    const entry = store.entries[hash]
    if (entry) {
      result.set(hash, entry.dataUrl)
    }
  }

  return result
}

/**
 * Clear the entire global image cache.
 */
export const clearImageCache = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  const filePath = await getCacheFilePath(app, settings)
  if (await app.vault.adapter.exists(filePath)) {
    await app.vault.adapter.remove(filePath)
  }
}

/**
 * Batch write: add multiple entries at once (single disk write).
 */
export const batchWriteImageCache = async (
  app: App,
  entries: Array<Omit<ImageCacheEntry, 'createdAt' | 'lastAccessedAt'>>,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  if (entries.length === 0) return

  const store = await readCacheStore(app, settings)
  const now = Date.now()

  for (const entry of entries) {
    store.entries[entry.hash] = {
      ...entry,
      createdAt: store.entries[entry.hash]?.createdAt ?? now,
      lastAccessedAt: now,
    }
  }

  await writeCacheStore(app, store, settings)
}
