import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

import { ensureJsonDbRootDir } from '../../../core/paths/yoloManagedData'
import { CHAT_DIR } from '../constants'

export type PdfTextPage = {
  page: number
  text: string
}

type PdfTextCacheEntry = {
  hash: string
  sourcePath: string
  pages: PdfTextPage[]
  createdAt: number
  lastAccessedAt: number
}

type PdfTextCacheStore = {
  schemaVersion: 1
  entries: Record<string, PdfTextCacheEntry>
}

const PDF_CACHE_DIR = 'pdf_cache'
const CACHE_FILE_NAME = 'global.json'

const EMPTY_STORE: PdfTextCacheStore = {
  schemaVersion: 1,
  entries: {},
}

type YoloSettingsLike = {
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

/** Key is derived from vault path + mtime + size — any file change invalidates. */
export const buildPdfTextCacheKey = (
  vaultPath: string,
  mtime: number,
  size: number,
): string => fnv1aHash(`${vaultPath}:${mtime}:${size}`)

const getCacheDirPath = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<string> => {
  const rootDir = await ensureJsonDbRootDir(app, settings)
  return normalizePath(path.join(rootDir, CHAT_DIR, PDF_CACHE_DIR))
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
): Promise<PdfTextCacheStore> => {
  const filePath = await getCacheFilePath(app, settings)
  if (!(await app.vault.adapter.exists(filePath))) {
    return EMPTY_STORE
  }

  try {
    const content = await app.vault.adapter.read(filePath)
    const parsed = JSON.parse(content) as PdfTextCacheStore
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      return EMPTY_STORE
    }
    return {
      schemaVersion: 1,
      entries: parsed.entries,
    }
  } catch (error) {
    console.error('[YOLO] Failed to read PDF text cache store', error)
    return EMPTY_STORE
  }
}

const writeCacheStore = async (
  app: App,
  store: PdfTextCacheStore,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  await ensureCacheDir(app, settings)
  const filePath = await getCacheFilePath(app, settings)
  await app.vault.adapter.write(filePath, JSON.stringify(store))
}

/**
 * Look up cached PDF pages by hash. Read-only — does not bump lastAccessedAt
 * to avoid write contention; prune relies on write-time updates.
 */
export const lookupPdfTextCache = async (
  app: App,
  hash: string,
  settings?: YoloSettingsLike | null,
): Promise<PdfTextPage[] | null> => {
  const store = await readCacheStore(app, settings)
  const entry = store.entries[hash]
  return entry?.pages ?? null
}

export const writePdfTextCacheEntry = async (
  app: App,
  entry: Omit<PdfTextCacheEntry, 'createdAt' | 'lastAccessedAt'>,
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
 * Remove cache entries not accessed within maxAgeDays. Returns number pruned.
 */
export const prunePdfTextCache = async (
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

export const clearPdfTextCache = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  const filePath = await getCacheFilePath(app, settings)
  if (await app.vault.adapter.exists(filePath)) {
    await app.vault.adapter.remove(filePath)
  }
}
