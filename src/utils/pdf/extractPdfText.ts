import type { App, TFile } from 'obsidian'

import {
  buildPdfTextCacheKey,
  lookupPdfTextCache,
  writePdfTextCacheEntry,
} from '../../database/json/chat/pdfTextCacheStore'
import { createYieldController } from '../common/yield-to-main'

import { loadPdfPages } from './pdfPages'

/** Hard cap for vault PDF indexing (binary size). */
export const PDF_INDEX_MAX_BYTES = 50 * 1024 * 1024

/** Hard cap for vault PDF indexing (page count). */
export const PDF_INDEX_MAX_PAGES = 500

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

export type ExtractPdfTextOptions = {
  signal?: AbortSignal
  maxBinaryBytes?: number
  maxPages?: number
  /**
   * When provided, results are read from / written to the shared PDF text cache
   * (keyed by path:mtime:size). Omit to force a fresh extraction without touching
   * the cache — useful for callers with no settings handle (tests, tools that
   * opt out). Same YoloSettingsLike shape as imageCacheStore.
   */
  settings?: YoloSettingsLike | null
}

export async function extractPdfText(
  app: App,
  file: TFile,
  options: ExtractPdfTextOptions = {},
): Promise<{ pages: { page: number; text: string }[] }> {
  const maxBinaryBytes = options.maxBinaryBytes ?? PDF_INDEX_MAX_BYTES
  const maxPages = options.maxPages ?? PDF_INDEX_MAX_PAGES

  if (file.stat.size > maxBinaryBytes) {
    throw new Error(
      `PDF too large (${file.stat.size} bytes). Limit is ${maxBinaryBytes} bytes.`,
    )
  }

  // Cache hit fast-path: avoid the expensive pdfjs pipeline entirely when
  // path:mtime:size matches a previously extracted entry.
  const cacheKey =
    options.settings !== undefined
      ? buildPdfTextCacheKey(file.path, file.stat.mtime, file.stat.size)
      : null
  if (cacheKey) {
    const cached = await lookupPdfTextCache(app, cacheKey, options.settings)
    if (cached) {
      return { pages: cached }
    }
  }

  const buf = await app.vault.readBinary(file)
  const maybeYield = createYieldController(1)

  const { totalPages, pages } = await loadPdfPages(new Uint8Array(buf), {
    maxPages,
    maybeYield,
    signal: options.signal,
  })

  if (totalPages > maxPages) {
    console.warn(
      `[YOLO] PDF ${file.path} has ${totalPages} pages; only first ${maxPages} were extracted.`,
    )
  }

  if (cacheKey) {
    try {
      await writePdfTextCacheEntry(
        app,
        { hash: cacheKey, sourcePath: file.path, pages },
        options.settings,
      )
    } catch (error) {
      console.warn(
        `[YOLO] Failed to persist PDF text cache for ${file.path}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  return { pages }
}
