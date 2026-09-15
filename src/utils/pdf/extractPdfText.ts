import type { App, TFile } from 'obsidian'

import {
  buildPdfTextCacheKey,
  buildPdfTextCacheKeyFromContent,
  lookupPdfText,
  writePdfText,
} from '../../database/local-cache/localCacheStore'
import { base64ToUint8Array } from '../base64'
import { createYieldController } from '../common/yield-to-main'

import { loadPdfPages } from './pdfPages'

/** Default binary-size cap when chat reads a PDF's text (knowledge base indexing is uncapped). */
export const PDF_READ_MAX_BYTES = 50 * 1024 * 1024

/** Default page cap when chat reads a PDF's text (knowledge base indexing is uncapped). */
export const PDF_READ_MAX_PAGES = 500

export type ExtractPdfTextOptions = {
  signal?: AbortSignal
  maxBinaryBytes?: number
  maxPages?: number
  /**
   * Read from / write to the local PDF text cache (keyed by path:mtime:size).
   * Off by default: knowledge-base indexing deliberately bypasses it.
   */
  useCache?: boolean
}

export async function extractPdfText(
  app: App,
  file: TFile,
  options: ExtractPdfTextOptions = {},
): Promise<{ pages: { page: number; text: string }[] }> {
  const maxBinaryBytes = options.maxBinaryBytes ?? PDF_READ_MAX_BYTES
  const maxPages = options.maxPages ?? PDF_READ_MAX_PAGES

  if (file.stat.size > maxBinaryBytes) {
    throw new Error(
      `PDF too large (${file.stat.size} bytes). Limit is ${maxBinaryBytes} bytes.`,
    )
  }

  // Cache hit fast-path: avoid the expensive pdfjs pipeline entirely when
  // path:mtime:size matches a previously extracted entry.
  const cacheKey = options.useCache
    ? buildPdfTextCacheKey(file.path, file.stat.mtime, file.stat.size)
    : null
  if (cacheKey) {
    const cached = await lookupPdfText(app, cacheKey)
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
    await writePdfText(app, { key: cacheKey, sourcePath: file.path, pages })
  }

  return { pages }
}

export type ExtractPdfTextFromBase64Options = {
  signal?: AbortSignal
  maxPages?: number
  /**
   * Consult the local PDF text cache (read-on-lookup, write-on-miss), keyed
   * by content hash. Off by default.
   */
  useCache?: boolean
  /**
   * Optional precomputed content-hash cache key. Skip recomputing fnv1a over
   * a multi-MB base64 string when the caller already has it (e.g. upload site).
   */
  precomputedCacheKey?: string
  /**
   * Diagnostic source label persisted into the cache entry (e.g. `upload:foo.pdf`).
   * Has no effect on lookup; helps when inspecting the cache database manually.
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
  const maxPages = options.maxPages ?? PDF_READ_MAX_PAGES

  const cacheKey = options.useCache
    ? (options.precomputedCacheKey ??
      (await buildPdfTextCacheKeyFromContent(base64)))
    : null
  if (cacheKey) {
    const cached = await lookupPdfText(app, cacheKey)
    if (cached) {
      return { pages: cached }
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
    await writePdfText(app, {
      key: cacheKey,
      sourcePath: options.sourceLabel ?? 'upload:unknown',
      pages,
    })
  }

  return { pages }
}
