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

const normalizeJsonValue = (value: unknown): unknown => {
  if (value === null) {
    return null
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
  const serialized = JSON.stringify(normalizeJsonValue(value))
  const cached = jsonTokenCache.get(serialized)
  if (cached !== undefined) {
    return cached
  }

  const count = estimateTextTokens(serialized)
  jsonTokenCache.set(serialized, count)
  return count
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
