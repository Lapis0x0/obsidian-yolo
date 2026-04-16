import { getEncoding } from 'js-tiktoken'

const textTokenCache = new Map<string, number>()
const jsonTokenCache = new Map<string, number>()

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
    return cached
  }

  const count = getSharedEncoding().encode(text).length
  textTokenCache.set(text, count)
  return count
}

export const estimateJsonTokens = (value: unknown): number => {
  strippedImageCount = 0
  const serialized = JSON.stringify(normalizeJsonValue(value))
  const imageCount = strippedImageCount

  const cached = jsonTokenCache.get(serialized)
  if (cached !== undefined) {
    return cached + imageCount * ESTIMATED_IMAGE_TOKENS
  }

  const textTokens = estimateTextTokens(serialized)
  jsonTokenCache.set(serialized, textTokens)
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
