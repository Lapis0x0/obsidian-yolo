import type { App, TFile } from 'obsidian'

import {
  buildPdfTextCacheKey,
  buildPdfTextCacheKeyFromContent,
  lookupPdfTextCache,
  writePdfTextCacheEntry,
} from '../../database/json/chat/pdfTextCacheStore'
import { base64ToUint8Array } from '../base64'
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
    try {
      const cached = await lookupPdfTextCache(app, cacheKey, options.settings)
      if (cached) {
        return { pages: cached }
      }
    } catch (error) {
      console.warn(
        `[YOLO] PDF text cache lookup failed for ${file.path}; falling back to fresh extraction:`,
        error instanceof Error ? error.message : error,
      )
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

export type ExtractPdfTextFromBase64Options = {
  signal?: AbortSignal
  maxPages?: number
  /**
   * When provided, the cache is consulted (read-on-lookup, write-on-miss),
   * keyed by content hash. Omit to force a fresh extraction without caching.
   */
  settings?: YoloSettingsLike | null
  /**
   * Optional precomputed content-hash cache key. Skip recomputing fnv1a over
   * a multi-MB base64 string when the caller already has it (e.g. upload site).
   */
  precomputedCacheKey?: string
  /**
   * Diagnostic source label persisted into the cache entry (e.g. `upload:foo.pdf`).
   * Has no effect on lookup; helps when inspecting the cache JSON manually.
   */
  sourceLabel?: string
}

/**
 * Extract text from a PDF given its raw bytes as base64. Used by the chat
 * upload path and the request-build path (non-pdf-capable models). Shares the
 * same persistent cache as {@link extractPdfText}, keyed by content hash so
 * the same PDF re-uploaded under any filename hits one entry.
 */
export async function extractPdfTextFromBase64(
  app: App,
  base64: string,
  options: ExtractPdfTextFromBase64Options = {},
): Promise<{ pages: { page: number; text: string }[] }> {
  const maxPages = options.maxPages ?? PDF_INDEX_MAX_PAGES

  const cacheKey =
    options.settings !== undefined
      ? (options.precomputedCacheKey ??
        (await buildPdfTextCacheKeyFromContent(base64)))
      : null
  if (cacheKey) {
    // Lookup is best-effort: a failed read (corrupt JSON, IO error) must not
    // poison the whole call — fall through to fresh extraction.
    try {
      const cached = await lookupPdfTextCache(app, cacheKey, options.settings)
      if (cached) {
        return { pages: cached }
      }
    } catch (error) {
      console.warn(
        `[YOLO] PDF text cache lookup failed (${options.sourceLabel ?? 'upload'}); falling back to fresh extraction:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  const bytes = base64ToUint8Array(base64)
  const maybeYield = createYieldController(1)

  const { totalPages, pages } = await loadPdfPages(bytes, {
    maxPages,
    maybeYield,
    signal: options.signal,
  })

  if (totalPages > maxPages) {
    console.warn(
      `[YOLO] PDF (${options.sourceLabel ?? 'upload'}) has ${totalPages} pages; only first ${maxPages} were extracted.`,
    )
  }

  if (cacheKey) {
    try {
      await writePdfTextCacheEntry(
        app,
        {
          hash: cacheKey,
          sourcePath: options.sourceLabel ?? 'upload:unknown',
          pages,
        },
        options.settings,
      )
    } catch (error) {
      console.warn(
        `[YOLO] Failed to persist PDF text cache for ${options.sourceLabel ?? 'upload'}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  return { pages }
}
