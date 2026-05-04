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

type EncodeFn = (text: string) => number[]

let encoderPromise: Promise<EncodeFn> | null = null

const ensureEncoder = (): Promise<EncodeFn> => {
  if (!encoderPromise) {
    encoderPromise = import('gpt-tokenizer/encoding/cl100k_base').then(
      (mod) => mod.encode,
    )
  }
  return encoderPromise
}

// Rough per-image token estimate used when replacing base64 data URLs.
// Real cost varies by provider and resolution, but ~1000 is a reasonable middle ground.
const ESTIMATED_IMAGE_TOKENS = 1000
const BASE64_DATA_URL_RE = /^data:image\/[^;]+;base64,/

const normalizeJsonValue = (
  value: unknown,
): { value: unknown; imageCount: number } => {
  let imageCount = 0
  const walk = (val: unknown): unknown => {
    if (val === null) {
      return null
    }
    if (typeof val === 'string' && BASE64_DATA_URL_RE.test(val)) {
      imageCount++
      return '<image>'
    }
    if (Array.isArray(val)) {
      return val.map((item) => walk(item))
    }
    if (typeof val === 'object') {
      return Object.entries(val as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .reduce<Record<string, unknown>>((result, [key, entryValue]) => {
          result[key] = walk(entryValue)
          return result
        }, {})
    }
    return val
  }
  return { value: walk(value), imageCount }
}

export const estimateTextTokens = async (text: string): Promise<number> => {
  const cached = textTokenCache.get(text)
  if (cached !== undefined) {
    // LRU touch: move to the end so it is evicted last.
    textTokenCache.delete(text)
    textTokenCache.set(text, cached)
    return cached
  }

  const encode = await ensureEncoder()
  const count = encode(text).length
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
  const { value: normalized, imageCount } = normalizeJsonValue(value)
  const serialized = JSON.stringify(normalized)

  // Do not cache here — keys are always unique in hot paths (request payloads
  // change every turn) and caching them would leak memory unboundedly.
  const encode = await ensureEncoder()
  return encode(serialized).length + imageCount * ESTIMATED_IMAGE_TOKENS
}
