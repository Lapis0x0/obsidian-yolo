import { getEncoding } from 'js-tiktoken'

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

let sharedEncoding: ReturnType<typeof getEncoding> | null = null

const getSharedEncoding = () => {
  if (!sharedEncoding) {
    sharedEncoding = getEncoding('cl100k_base')
  }
  return sharedEncoding
}

// Rough per-image token estimate used when replacing base64 data URLs.
// Real cost varies by provider and resolution, but ~1000 is a reasonable middle ground.
const ESTIMATED_IMAGE_TOKENS = 1000
const BASE64_DATA_URL_RE = /^data:image\/[^;]+;base64,/

let strippedImageCount = 0

const normalizeJsonValue = (value: unknown): unknown => {
  if (value === null) {
    return null
  }
  if (typeof value === 'string' && BASE64_DATA_URL_RE.test(value)) {
    strippedImageCount++
    return '<image>'
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item))
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((result, [key, entryValue]) => {
        result[key] = normalizeJsonValue(entryValue)
        return result
      }, {})
  }
  return value
}

export const estimateTextTokens = (text: string): number => {
  const cached = textTokenCache.get(text)
  if (cached !== undefined) {
    // LRU touch: move to the end so it is evicted last.
    textTokenCache.delete(text)
    textTokenCache.set(text, cached)
    return cached
  }

  const count = getSharedEncoding().encode(text).length
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

export const estimateJsonTokens = (value: unknown): number => {
  strippedImageCount = 0
  const serialized = JSON.stringify(normalizeJsonValue(value))
  const imageCount = strippedImageCount

  // Do not cache here — keys are always unique in hot paths (request payloads
  // change every turn) and caching them would leak memory unboundedly.
  const textTokens = getSharedEncoding().encode(serialized).length
  return textTokens + imageCount * ESTIMATED_IMAGE_TOKENS
}

export const formatTokenCount = (count: number): string => {
  if (count < 1000) {
    return String(count)
  }
  if (count < 10_000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return `${Math.round(count / 1000)}k`
}
