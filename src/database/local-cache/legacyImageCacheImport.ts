import { App, normalizePath } from 'obsidian'

import {
  type YoloSettingsLike,
  ensureUserDataRootDir,
} from '../../core/paths/yoloManagedData'
import { CHAT_DIR } from '../json/constants'

import {
  type LegacyImageCacheEntry,
  startLegacyImageCacheImport,
} from './localCacheStore'

const LEGACY_IMAGE_CACHE_DIR = 'image_cache'
const LEGACY_IMAGE_CACHE_FILE = 'global.json'

/**
 * Moves the old vault image cache into the local cache, once.
 *
 * Unlike the PDF text cache (deleted outright, see
 * `LEGACY_CHAT_CACHE_DIR_NAMES`), this one is imported: chat history refers
 * to its entries as `cache://<key>`, so dropping it would strip the images out
 * of every existing conversation on upgrade.
 *
 * Call it before anything can read the cache — the local cache holds every
 * operation until the import settles.
 */
export const importLegacyImageCache = (
  app: App,
  settings: YoloSettingsLike | null,
): Promise<void> => {
  let legacyDir: string | null = null
  return startLegacyImageCacheImport(
    app,
    async () => {
      const root = await ensureUserDataRootDir(app, settings)
      legacyDir = normalizePath(`${root}/${CHAT_DIR}/${LEGACY_IMAGE_CACHE_DIR}`)
      const filePath = normalizePath(`${legacyDir}/${LEGACY_IMAGE_CACHE_FILE}`)
      if (!(await app.vault.adapter.exists(legacyDir))) {
        return null
      }
      if (!(await app.vault.adapter.exists(filePath))) {
        return []
      }
      return parseLegacyEntries(await app.vault.adapter.read(filePath))
    },
    async () => {
      if (legacyDir && (await app.vault.adapter.exists(legacyDir))) {
        await app.vault.adapter.rmdir(legacyDir, true)
      }
    },
  )
}

/**
 * An unreadable file imports nothing and is still cleaned up: it is a cache,
 * and keeping a corrupt one only means failing to parse it on every start.
 */
const parseLegacyEntries = (content: string): LegacyImageCacheEntry[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  const entries =
    parsed && typeof parsed === 'object'
      ? (parsed as { entries?: unknown }).entries
      : null
  if (!entries || typeof entries !== 'object') {
    return []
  }
  const result: LegacyImageCacheEntry[] = []
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as {
      dataUrl?: unknown
      sourcePath?: unknown
      lastAccessedAt?: unknown
    }
    if (typeof entry.dataUrl !== 'string') continue
    result.push({
      key,
      dataUrl: entry.dataUrl,
      sourcePath: typeof entry.sourcePath === 'string' ? entry.sourcePath : '',
      lastAccessedAt:
        typeof entry.lastAccessedAt === 'number' ? entry.lastAccessedAt : 0,
    })
  }
  return result
}
