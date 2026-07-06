import type { AssistantToolPreference } from '../../types/assistant.types'
import type {
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { LLMProviderApiType } from '../../types/provider.types'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import type {
  PromptSection,
  PromptSectionBucket,
  RequestContextBuilder,
} from '../../utils/chat/requestContextBuilder'
import {
  estimateJsonTokens,
  normalizeJsonValue,
} from '../../utils/llm/contextTokenEstimate'
import { resolveEffectiveMaxContextTokens } from '../../utils/llm/model-capability-registry'
import { McpManager } from '../mcp/mcpManager'

import { selectAllowedTools } from './tool-selection'

/** Token breakdown for a single bucket in the context-usage popover. */
export type ContextBucketUsage = {
  bucket: PromptSectionBucket
  tokens: number
}

export type ContextBreakdown = {
  buckets: ContextBucketUsage[]
  /** Sum of bucket tokens (NOT guaranteed to equal the server-side prompt
   * token count — the ring keeps showing the server number). */
  total: number
  /** Context-window size for the active model. May be null if unknown. */
  max: number | null
  /** When this breakdown finished computing (ms epoch). */
  computedAt: number
}

const BUCKET_ORDER: PromptSectionBucket[] = [
  'system',
  'tools',
  'rules',
  'skills',
  'memory',
  'reasoning',
  'conversation',
]

/** cyrb53 — fast non-cryptographic 53-bit hash. Stable across runs, plenty for
 * an in-memory LRU key. Reference: https://stackoverflow.com/a/52171480 */
const cyrb53 = (str: string, seed = 0): string => {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const high = (h2 >>> 0).toString(16).padStart(8, '0')
  const low = (h1 >>> 0).toString(16).padStart(8, '0')
  return `${high}${low}`
}

/** Hash a section list to a stable string key — used as LRU cache key for the
 * breakdown estimator. Any change to a section's bucket / id / content
 * naturally invalidates the cache; no manual fingerprint list needed.
 *
 * Reuses the token estimator's `normalizeJsonValue` so:
 *   - Base64 PDFs / images are reduced to short markers (a multi-MB conversation
 *     would otherwise stringify and hash the entire blob on every popover click).
 *   - Object key order is canonical, preventing false cache misses when two
 *     logically-identical payloads differ only in property iteration order. */
export const hashSections = (sections: PromptSection[]): string => {
  // Section order itself is part of identity — do NOT sort the list.
  const parts: string[] = []
  for (const section of sections) {
    let serialized: string
    try {
      if (typeof section.content === 'string') {
        serialized = section.content
      } else {
        const { value: normalized } = normalizeJsonValue(section.content)
        serialized = JSON.stringify(normalized)
      }
    } catch {
      serialized = '<unserializable>'
    }
    parts.push(`${section.bucket}|${section.id}|${serialized}`)
  }
  return cyrb53(parts.join('\n'))
}

const BREAKDOWN_CACHE_LIMIT = 8
const breakdownCache = new Map<string, ContextBreakdown>()

const cacheGet = (key: string): ContextBreakdown | undefined => {
  const hit = breakdownCache.get(key)
  if (hit !== undefined) {
    // LRU touch
    breakdownCache.delete(key)
    breakdownCache.set(key, hit)
  }
  return hit
}

const cacheSet = (key: string, value: ContextBreakdown): void => {
  breakdownCache.set(key, value)
  if (breakdownCache.size > BREAKDOWN_CACHE_LIMIT) {
    const oldestKey = breakdownCache.keys().next().value
    if (oldestKey !== undefined) {
      breakdownCache.delete(oldestKey)
    }
  }
}

/**
 * Estimate per-bucket token usage of the upcoming LLM request. Mirrors the
 * inputs of `estimateContinuationRequestContextTokens` so the popover can be
 * fed from the same call site without divergent state.
 */
export const estimateContextBreakdown = async ({
  requestContextBuilder,
  mcpManager,
  model,
  messages,
  conversationId,
  compaction,
  enableTools,
  includeBuiltinTools,
  apiType,
  allowedToolNames,
  enableToolDisclosure,
  toolPreferences,
  contextualInjections,
  runtimeModePrompt,
}: {
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  model: ChatModel
  messages: ChatMessage[]
  conversationId: string
  compaction?: ChatConversationCompactionLike | null
  enableTools: boolean
  includeBuiltinTools: boolean
  apiType?: LLMProviderApiType | null
  allowedToolNames?: string[]
  enableToolDisclosure?: boolean
  toolPreferences?: Record<string, AssistantToolPreference>
  contextualInjections?: ContextualInjection[]
  runtimeModePrompt?: string
}): Promise<ContextBreakdown> => {
  const availableTools = enableTools
    ? await mcpManager.listAvailableTools({
        includeBuiltinTools,
        chatModelModalities: model.modalities,
      })
    : []
  const { hasTools, hasMemoryTools, hasOnDemandTools, requestTools } =
    await selectAllowedTools({
      availableTools,
      allowedToolNames,
      toolPreferences,
      apiType,
      enableToolDisclosure,
      jsSandboxSettings: mcpManager.getJsSandboxSettings(),
    })

  const sections = await requestContextBuilder.generateRequestSections({
    messages,
    hasTools,
    hasMemoryTools,
    hasOnDemandTools,
    model,
    conversationId,
    compaction,
    contextualInjections,
    runtimeModePrompt,
    requestTools,
    // Token breakdown only: reuse a frozen snapshot if present, never create one.
    systemPromptSnapshotMode: 'reuse',
  })

  const cacheKey = hashSections(sections)
  const cached = cacheGet(cacheKey)
  if (cached) {
    return cached
  }

  // Tokenize each section, bucket-wise. We pass each section's content through
  // `estimateJsonTokens` so structured request messages and tool schemas are
  // serialized the same way as the real request payload.
  const bucketTotals = new Map<PromptSectionBucket, number>()
  for (const bucket of BUCKET_ORDER) {
    bucketTotals.set(bucket, 0)
  }
  await Promise.all(
    sections.map(async (section) => {
      const tokens = await estimateJsonTokens(section.content)
      const current = bucketTotals.get(section.bucket) ?? 0
      bucketTotals.set(section.bucket, current + tokens)
    }),
  )

  const buckets: ContextBucketUsage[] = BUCKET_ORDER.map((bucket) => ({
    bucket,
    tokens: bucketTotals.get(bucket) ?? 0,
  }))
  const total = buckets.reduce((sum, b) => sum + b.tokens, 0)

  const result: ContextBreakdown = {
    buckets,
    total,
    max: resolveEffectiveMaxContextTokens(model) ?? null,
    computedAt: Date.now(),
  }
  cacheSet(cacheKey, result)
  return result
}
