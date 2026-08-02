import type { ResponseUsage } from '../../types/llm/response'

import type {
  CliContextUsage,
  CliContextUsageBucket,
  CliContextUsageCategory,
} from './types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asNonNegativeInt = (value: unknown): number | null => {
  const number = asFiniteNumber(value)
  if (number === null || number < 0) return null
  return Math.floor(number)
}

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null

const CLI_CONTEXT_USAGE_BUCKETS: readonly CliContextUsageBucket[] = [
  'system',
  'tools',
  'rules',
  'skills',
  'memory',
  'reasoning',
  'conversation',
]

const isFreeSpaceCategory = (name: string): boolean =>
  /^free\s*space$/i.test(name.trim())

/**
 * Map Claude category labels onto the native breakdown swatch set so CLI and
 * YOLO cards share the same theme-aware palette.
 */
export const resolveClaudeContextUsageBucket = (
  name: string,
  fallbackIndex = 0,
): CliContextUsageBucket => {
  const normalized = name.trim().toLowerCase()
  if (
    normalized === 'system prompt' ||
    normalized === 'system' ||
    normalized.includes('system prompt')
  ) {
    return 'system'
  }
  if (
    normalized === 'tools' ||
    normalized.includes('mcp') ||
    normalized.includes('tool')
  ) {
    return 'tools'
  }
  if (normalized.includes('rule')) return 'rules'
  if (normalized.includes('skill')) return 'skills'
  if (normalized.includes('memory')) return 'memory'
  if (normalized.includes('reason') || normalized.includes('thinking')) {
    return 'reasoning'
  }
  if (
    normalized === 'messages' ||
    normalized.includes('message') ||
    normalized.includes('conversation')
  ) {
    return 'conversation'
  }
  if (normalized.includes('agent')) return 'tools'
  return CLI_CONTEXT_USAGE_BUCKETS[
    Math.abs(fallbackIndex) % CLI_CONTEXT_USAGE_BUCKETS.length
  ]
}

/**
 * Map Claude Agent SDK result `usage` + `modelUsage` into ring inputs.
 * Prompt tokens match the native Anthropic adapter: input + cache read/write.
 */
export const mapClaudeResultContextUsage = (result: {
  usage?: unknown
  modelUsage?: unknown
}): CliContextUsage | null => {
  if (!isRecord(result.usage)) return null
  const inputTokens = asNonNegativeInt(result.usage.input_tokens)
  if (inputTokens === null) return null
  const cacheRead = asNonNegativeInt(result.usage.cache_read_input_tokens) ?? 0
  const cacheCreation =
    asNonNegativeInt(result.usage.cache_creation_input_tokens) ?? 0
  const promptTokens = inputTokens + cacheRead + cacheCreation
  const cacheHitRate = promptTokens > 0 ? cacheRead / promptTokens : null

  let maxContextTokens: number | null = null
  if (isRecord(result.modelUsage)) {
    for (const entry of Object.values(result.modelUsage)) {
      if (!isRecord(entry)) continue
      const contextWindow = asNonNegativeInt(entry.contextWindow)
      if (contextWindow !== null && contextWindow > 0) {
        maxContextTokens =
          maxContextTokens === null
            ? contextWindow
            : Math.max(maxContextTokens, contextWindow)
      }
    }
  }

  return {
    promptTokens,
    maxContextTokens,
    ...(cacheHitRate !== null ? { cacheHitRate } : {}),
  }
}

export const mapClaudeResultResponseUsage = (result: {
  usage?: unknown
}): ResponseUsage | null => {
  if (!isRecord(result.usage)) return null
  const inputTokens = asNonNegativeInt(result.usage.input_tokens)
  const outputTokens = asNonNegativeInt(result.usage.output_tokens)
  if (inputTokens === null || outputTokens === null) return null
  const cacheRead = asNonNegativeInt(result.usage.cache_read_input_tokens) ?? 0
  const cacheCreation =
    asNonNegativeInt(result.usage.cache_creation_input_tokens) ?? 0
  const promptTokens = inputTokens + cacheRead + cacheCreation
  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation > 0
      ? { cache_creation_input_tokens: cacheCreation }
      : {}),
  }
}

/**
 * Map Claude `query.getContextUsage()` into ring inputs + category breakdown.
 * Prefers server-side totals (`totalTokens` / `maxTokens`) when present.
 * Drops Claude's "Free space" row — remaining capacity is already visible in
 * the summary percent / empty bar track.
 */
export const mapClaudeGetContextUsage = (
  response: unknown,
): CliContextUsage | null => {
  if (!isRecord(response)) return null
  const promptTokens = asNonNegativeInt(response.totalTokens)
  if (promptTokens === null) return null
  const maxTokens = asNonNegativeInt(response.maxTokens)
  const categories: CliContextUsageCategory[] = []
  if (Array.isArray(response.categories)) {
    for (const entry of response.categories) {
      if (!isRecord(entry)) continue
      const name = asNonEmptyString(entry.name)
      const tokens = asNonNegativeInt(entry.tokens)
      if (!name || tokens === null || isFreeSpaceCategory(name)) continue
      categories.push({
        name,
        tokens,
        bucket: resolveClaudeContextUsageBucket(name, categories.length),
      })
    }
  }
  return {
    promptTokens,
    maxContextTokens: maxTokens !== null && maxTokens > 0 ? maxTokens : null,
    ...(categories.length > 0 ? { categories } : {}),
  }
}

/**
 * Map Codex `thread/tokenUsage/updated` params into ring inputs.
 * Uses last-turn `totalTokens` against `modelContextWindow` (Codex status-line shape).
 */
export const mapCodexTokenUsageUpdated = (
  params: Record<string, unknown>,
): CliContextUsage | null => {
  const tokenUsage = params.tokenUsage
  if (!isRecord(tokenUsage)) return null
  const last = tokenUsage.last
  if (!isRecord(last)) return null
  const promptTokens = asNonNegativeInt(last.totalTokens)
  if (promptTokens === null) return null
  const maxContextTokens = asNonNegativeInt(tokenUsage.modelContextWindow)
  const inputTokens = asNonNegativeInt(last.inputTokens)
  const cachedInputTokens = asNonNegativeInt(last.cachedInputTokens)
  const cacheHitRate =
    inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null
      ? Math.min(1, cachedInputTokens / inputTokens)
      : null
  return {
    promptTokens,
    maxContextTokens:
      maxContextTokens !== null && maxContextTokens > 0
        ? maxContextTokens
        : null,
    ...(cacheHitRate !== null ? { cacheHitRate } : {}),
  }
}

export const mapCodexTurnResponseUsage = (
  params: Record<string, unknown>,
): ResponseUsage | null => {
  const tokenUsage = params.tokenUsage
  if (!isRecord(tokenUsage) || !isRecord(tokenUsage.last)) return null
  const inputTokens = asNonNegativeInt(tokenUsage.last.inputTokens)
  const outputTokens = asNonNegativeInt(tokenUsage.last.outputTokens)
  if (inputTokens === null || outputTokens === null) return null
  const cachedInputTokens =
    asNonNegativeInt(tokenUsage.last.cachedInputTokens) ?? 0
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...(cachedInputTokens > 0
      ? { cache_read_input_tokens: cachedInputTokens }
      : {}),
  }
}
