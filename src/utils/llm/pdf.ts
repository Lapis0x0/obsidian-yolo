import type { App } from 'obsidian'

import {
  buildPdfTextCacheKeyFromContent,
  writePdfText,
} from '../../database/local-cache/localCacheStore'
import { MentionablePDF } from '../../types/mentionable'
import { uint8ArrayToBase64 } from '../base64'
import { createYieldController } from '../common/yield-to-main'
import { getPdfPageCount, loadPdfPages } from '../pdf/pdfPages'

/**
 * Hard cap for uploaded PDF size at the chat input. Anthropic's native-PDF
 * document block caps the *whole request payload* at 32 MB, and inline base64
 * inflates raw bytes by ~33%. Capping raw uploads at 24 MB keeps the encoded
 * payload comfortably under that ceiling so a Claude request that passed
 * upload won't fail at the API layer.
 */
export const PDF_UPLOAD_MAX_BYTES = 24 * 1024 * 1024

/** Match the global vault PDF page extraction cap. */
const UPLOAD_MAX_PAGES = 500

export type FileToMentionablePDFOptions = {
  maxBinaryBytes?: number
}

/**
 * Build a {@link MentionablePDF} from a chat-uploaded `File`.
 *
 * pdfjs runs exactly once at upload time: we read the page count AND extract
 * full text in the same pass, then persist the text into the shared
 * local cache keyed by content hash. Native-PDF adapters
 * (Claude / Gemini) only need `rawData` and ignore the cache; non-native
 * adapters hit the cache during request build and skip pdfjs entirely.
 *
 * Trade-off: a one-time ~1–2s extraction at upload (background, with progress)
 * for zero per-turn cost later. Since most providers do NOT advertise the pdf
 * modality (only Claude / Gemini do), the non-native path is the common case
 * and pre-extracting is the right default.
 */
export async function fileToMentionablePDF(
  app: App,
  file: File,
  options: FileToMentionablePDFOptions = {},
): Promise<MentionablePDF> {
  const maxBinaryBytes = options.maxBinaryBytes ?? PDF_UPLOAD_MAX_BYTES

  if (file.size > maxBinaryBytes) {
    throw new Error(
      `PDF too large (${file.size} bytes). Limit is ${maxBinaryBytes} bytes.`,
    )
  }

  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const base64 = uint8ArrayToBase64(bytes)
  const maybeYield = createYieldController(1)

  // Try to extract full text in the same pdfjs pass that gives us pageCount.
  // Both are best-effort: a corrupt / encrypted PDF must not block the upload,
  // because the dominant use case (Claude / Gemini native PDF) only needs raw
  // bytes. On failure we still fall back to a metadata-only probe for
  // pageCount, and ultimately to undefined.
  let pageCount: number | undefined
  let extractedPages: { page: number; text: string }[] | null = null
  try {
    const result = await loadPdfPages(bytes, {
      maxPages: UPLOAD_MAX_PAGES,
      maybeYield,
    })
    pageCount = result.totalPages
    extractedPages = result.pages
  } catch (error) {
    console.warn(
      `[YOLO] Failed to extract PDF text at upload for ${file.name}; native-PDF path will still work, non-native fallback will re-attempt later:`,
      error instanceof Error ? error.message : error,
    )
    try {
      pageCount = await getPdfPageCount(bytes, { maybeYield })
    } catch {
      // Even the page-count probe failed (truly malformed). Leave pageCount
      // undefined; native-PDF adapters can still forward the raw bytes.
    }
  }

  // Best-effort write to the local text cache. Skipped on extraction failure
  // (no pages to write); the non-native fallback path will retry extraction.
  if (extractedPages !== null) {
    await writePdfText(app, {
      key: await buildPdfTextCacheKeyFromContent(base64),
      sourcePath: `upload:${file.name}`,
      pages: extractedPages,
    })
  }

  return {
    type: 'pdf',
    name: file.name,
    rawData: base64,
    pageCount,
  }
}
