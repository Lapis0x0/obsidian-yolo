// Bounded LRU for repeated short-text lookups (e.g. skill prompts shown in the
// Settings UI). We rely on Map's insertion-order guarantee: re-setting a key
// moves it to the end, so the oldest live entry is always the first key.
//
// NOTE: we intentionally do NOT cache `estimateJsonTokens` results. The caller
// serializes the full request payload (messages + tools) on every LLM turn,
// producing a unique key each time — the cache would never hit and would pin
// gigabytes of serialized JSON in memory across a session.
const TEXT_TOKEN_CACHE_LIMIT = 500
const textTokenCache = new Map<string, number>()

export type TokenizerProvider = Readonly<{
  count(text: string): Promise<number>
}>

const runtimeTokenizerProvider: TokenizerProvider = Object.freeze({
  async count(text) {
    const lease = await acquireRuntimeComponent('tokenizer')
    try {
      return lease.api.count(text)
    } finally {
      lease.release()
    }
  },
})

let tokenizerProvider: TokenizerProvider = runtimeTokenizerProvider

export function setTokenizerProviderForTests(
  provider: TokenizerProvider | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Tokenizer provider overrides are test-only')
  }
  tokenizerProvider = provider ?? runtimeTokenizerProvider
  textTokenCache.clear()
}

// Rough per-image token estimate used when replacing base64 data URLs.
// Real cost varies by provider and resolution, but ~1000 is a reasonable middle ground.
const ESTIMATED_IMAGE_TOKENS = 1000
// Per-page PDF token estimate. Gemini bills ~258 tokens/page for native PDF;
// other providers vary, but ~300 is a defensible middle ground for the local
// counter. We never want to tokenize the raw base64 — a multi-MB PDF would
// inflate the count by 6-7 orders of magnitude.
const ESTIMATED_PDF_TOKENS_PER_PAGE = 300
const ESTIMATED_PDF_TOKENS_FALLBACK = 3000
const BASE64_IMAGE_DATA_URL_RE = /^data:image\/[^;]+;base64,/
const BASE64_PDF_DATA_URL_RE = /^data:application\/pdf;base64,/

const isDocumentPart = (val: Record<string, unknown>): boolean =>
  val.type === 'document' &&
  val.mediaType === 'application/pdf' &&
  typeof val.data === 'string'

// Normalized OpenAI-compat shape: { type: 'file', file: { file_data: 'data:application/pdf;base64,...' } }
const isOpenAIFilePart = (val: Record<string, unknown>): boolean => {
  if (
    val.type !== 'file' ||
    typeof val.file !== 'object' ||
    val.file === null
  ) {
    return false
  }
  const fileData = (val.file as Record<string, unknown>).file_data
  return typeof fileData === 'string' && BASE64_PDF_DATA_URL_RE.test(fileData)
}

const estimatePdfTokens = (pageCount: unknown): number => {
  if (
    typeof pageCount === 'number' &&
    Number.isFinite(pageCount) &&
    pageCount > 0
  ) {
    return Math.ceil(pageCount) * ESTIMATED_PDF_TOKENS_PER_PAGE
  }
  return ESTIMATED_PDF_TOKENS_FALLBACK
}

/**
 * Walk `value`, replacing base64 image/PDF data URLs with placeholders and
 * sorting object keys alphabetically. The returned `value` is structurally
 * canonical — same logical content produces byte-identical JSON regardless of
 * source key order, and oversize base64 blobs are reduced to short markers.
 *
 * Exported so the context-breakdown cache can reuse the same normalization
 * when hashing sections (avoids both key-order false-misses and pathological
 * stringify cost on PDF/image-heavy conversations).
 */
export const normalizeJsonValue = (
  value: unknown,
): { value: unknown; imageCount: number; pdfTokenEstimate: number } => {
  let imageCount = 0
  let pdfTokenEstimate = 0
  const walk = (val: unknown): unknown => {
    if (val === null) {
      return null
    }
    if (typeof val === 'string' && BASE64_IMAGE_DATA_URL_RE.test(val)) {
      imageCount++
      return '<image>'
    }
    if (typeof val === 'string' && BASE64_PDF_DATA_URL_RE.test(val)) {
      pdfTokenEstimate += ESTIMATED_PDF_TOKENS_FALLBACK
      return '<pdf>'
    }
    if (Array.isArray(val)) {
      return val.map((item) => walk(item))
    }
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>
      // Native document part — known shape, use pageCount when available.
      if (isDocumentPart(obj)) {
        pdfTokenEstimate += estimatePdfTokens(obj.pageCount)
        return {
          type: 'document',
          mediaType: obj.mediaType,
          name: obj.name ?? null,
          data: '<pdf>',
          pageCount: obj.pageCount ?? null,
        }
      }
      // OpenAI-compat file part — no pageCount available, use fallback.
      if (isOpenAIFilePart(obj)) {
        pdfTokenEstimate += ESTIMATED_PDF_TOKENS_FALLBACK
        const file = obj.file as Record<string, unknown>
        return {
          type: 'file',
          file: {
            filename: file.filename ?? null,
            file_data: '<pdf>',
          },
        }
      }
      return Object.entries(obj)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .reduce<Record<string, unknown>>((result, [key, entryValue]) => {
          result[key] = walk(entryValue)
          return result
        }, {})
    }
    return val
  }
  return { value: walk(value), imageCount, pdfTokenEstimate }
}

export const estimateTextTokens = async (text: string): Promise<number> => {
  const cached = textTokenCache.get(text)
  if (cached !== undefined) {
    // LRU touch: move to the end so it is evicted last.
    textTokenCache.delete(text)
    textTokenCache.set(text, cached)
    return cached
  }

  const count = await tokenizerProvider.count(text)
  textTokenCache.set(text, count)
  if (textTokenCache.size > TEXT_TOKEN_CACHE_LIMIT) {
    // Drop the oldest inserted key (first in iteration order).
    const oldestKey = textTokenCache.keys().next().value
    if (oldestKey !== undefined) {
      textTokenCache.delete(oldestKey)
    }
  }
  return count
}

export const estimateJsonTokens = async (value: unknown): Promise<number> => {
  const {
    value: normalized,
    imageCount,
    pdfTokenEstimate,
  } = normalizeJsonValue(value)
  const serialized = JSON.stringify(normalized)

  // Do not cache here — keys are always unique in hot paths (request payloads
  // change every turn) and caching them would leak memory unboundedly.
  return (
    (await tokenizerProvider.count(serialized)) +
    imageCount * ESTIMATED_IMAGE_TOKENS +
    pdfTokenEstimate
  )
}
import { acquireRuntimeComponent } from '../../core/runtime-components/runtimeComponentAccess'
