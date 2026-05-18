import { useMemo } from 'react'

import { AssistantToolMessageGroup } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { ResponseUsage } from '../../types/llm/response'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { calculateLLMCost } from '../../utils/llm/price-calculator'

export type LLMRequestEntry = {
  // 1-based, dense across billable (usage-bearing) calls — duration-only
  // assistants are skipped, so the index never has gaps.
  index: number | '-'
  messageId: string
  usage: ResponseUsage
  durationMs: number | null
  model: ChatModel | undefined
  cost: number | null
  kind: 'main' | 'sub-model'
}

export type LLMResponseInfo = {
  // Last-call semantics — what the user-visible final round-trip cost was.
  // The inline bar always renders these values; tooltip's "current" block too.
  // usage/durationMs/model/cost are all bound to the same last-with-usage call,
  // so derived values like tok/s in the UI stay consistent.
  usage: ResponseUsage | null
  model: ChatModel | undefined
  cost: number | null
  durationMs: number | null

  // Aggregate across every billable (usage-bearing) call in this group.
  // Populated only when there are >= 2 such calls; otherwise null.
  // Any field is null if it can't be computed cleanly (missing duration on
  // any counted call, unknown cost on any counted call, etc.) — better than
  // silently displaying a number that under-counts.
  totalUsage: ResponseUsage | null
  totalDurationMs: number | null
  totalCost: number | null
  requestCount: number
  hasSubModelCalls: boolean

  // Per-billable-call breakdown for the "Show breakdown" surface. Always
  // populated (empty array when no billable calls). Each entry binds its
  // usage/durationMs/model/cost to a single assistant message.
  requests: LLMRequestEntry[]
}

const addOptionalUsageTokenCount = (
  target: {
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
  key: 'cache_read_input_tokens' | 'cache_creation_input_tokens',
  value: number | undefined,
) => {
  if (typeof value !== 'number' || value <= 0) {
    return
  }
  target[key] = (target[key] ?? 0) + value
}

const sumUsages = (usages: ResponseUsage[]): ResponseUsage | null => {
  if (usages.length === 0) {
    return null
  }

  const total: ResponseUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  }

  for (const usage of usages) {
    total.prompt_tokens += usage.prompt_tokens
    total.completion_tokens += usage.completion_tokens
    addOptionalUsageTokenCount(
      total,
      'cache_read_input_tokens',
      usage.cache_read_input_tokens,
    )
    addOptionalUsageTokenCount(
      total,
      'cache_creation_input_tokens',
      usage.cache_creation_input_tokens,
    )
  }

  // Derive total_tokens from the summed components — upstream providers'
  // total_tokens semantics around cache aren't always consistent.
  total.total_tokens = total.prompt_tokens + total.completion_tokens

  return total
}

const RUN_MODEL_TASK_TOOL_NAME = 'run_model_task'

const isModelTaskToolName = (name: string): boolean =>
  name === RUN_MODEL_TASK_TOOL_NAME ||
  name.endsWith(`__${RUN_MODEL_TASK_TOOL_NAME}`)

const asRecord = (value: unknown): Record<string, unknown> | null =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const getNumber = (
  record: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const normalizeUsage = (value: unknown): ResponseUsage | null => {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const promptTokens = getNumber(record, 'prompt_tokens')
  const completionTokens = getNumber(record, 'completion_tokens')
  if (promptTokens === undefined || completionTokens === undefined) {
    return null
  }

  const usage: ResponseUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      getNumber(record, 'total_tokens') ?? promptTokens + completionTokens,
  }
  addOptionalUsageTokenCount(
    usage,
    'cache_read_input_tokens',
    getNumber(record, 'cache_read_input_tokens'),
  )
  addOptionalUsageTokenCount(
    usage,
    'cache_creation_input_tokens',
    getNumber(record, 'cache_creation_input_tokens'),
  )
  return usage
}

const parseModelTaskChildUsage = (
  text: string | undefined,
): {
  usage: ResponseUsage
  durationMs: number | null
} | null => {
  if (!text) {
    return null
  }
  try {
    const payload = asRecord(JSON.parse(text))
    const meta = asRecord(payload?.meta)
    if (!meta) {
      return null
    }
    const usage = normalizeUsage(meta.childUsage)
    if (!usage) {
      return null
    }
    const durationMs = getNumber(meta, 'childDurationMs')
    return {
      usage,
      durationMs: durationMs ?? null,
    }
  } catch {
    return null
  }
}

export function collectLLMResponseInfo(
  messages: AssistantToolMessageGroup,
): LLMResponseInfo {
  const mainCalls: LLMRequestEntry[] = []
  const requests: LLMRequestEntry[] = []
  let fallbackModel: ChatModel | undefined
  let hasSubModelCalls = false

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const toolCall of message.toolCalls) {
        if (!isModelTaskToolName(toolCall.request.name)) {
          continue
        }
        hasSubModelCalls = true
        const childUsage =
          toolCall.response.status === ToolCallResponseStatus.Success
            ? parseModelTaskChildUsage(toolCall.response.data.text)
            : null
        if (!childUsage) {
          continue
        }
        // Sub-model child usage is surfaced as its own breakdown row but is
        // intentionally NOT folded into mainCalls/totalUsage/totalCost. The
        // turn totals stay scoped to main-model calls so tok/s stays
        // coherent; this knowingly under-reports true spend when sub-model
        // tasks are heavy — accepted for now to keep the display simple.
        requests.push({
          index: '-',
          messageId: `${message.id}:${toolCall.request.id}:sub-model`,
          usage: childUsage.usage,
          durationMs: childUsage.durationMs,
          model: undefined,
          cost: null,
          kind: 'sub-model',
        })
      }
    }

    if (message.role !== 'assistant') {
      continue
    }

    hasSubModelCalls =
      hasSubModelCalls ||
      (message.toolCallRequests?.some((toolCall) =>
        isModelTaskToolName(toolCall.name),
      ) ??
        false)

    const model = message.metadata?.model
    if (model) {
      fallbackModel = model
    }

    const usage = message.metadata?.usage
    if (!usage) {
      continue
    }

    const durationMs =
      typeof message.metadata?.durationMs === 'number'
        ? message.metadata.durationMs
        : null

    const entry: LLMRequestEntry = {
      index: mainCalls.length + 1,
      messageId: message.id,
      usage,
      durationMs,
      model,
      cost: model ? calculateLLMCost({ model, usage }) : null,
      kind: 'main',
    }
    mainCalls.push(entry)
    requests.push(entry)
  }

  const lastCall = mainCalls.length > 0 ? mainCalls[mainCalls.length - 1] : null

  // Top-level reflects the last billable call only — usage/duration/model are
  // pulled from the same entry, so the inline bar's tok/s stays coherent.
  const usage = lastCall?.usage ?? null
  const durationMs = lastCall?.durationMs ?? null
  // When a billable call exists, model is bound to that same entry — even if
  // that entry's model is undefined. Only fall back when there were no
  // billable calls at all (e.g. an in-flight stream that hasn't reported
  // usage yet).
  const model = lastCall ? lastCall.model : fallbackModel
  const cost = lastCall?.cost ?? null

  const hasMultipleRequests = mainCalls.length >= 2
  const totalUsage = hasMultipleRequests
    ? sumUsages(mainCalls.map((call) => call.usage))
    : null

  let totalDurationMs: number | null = null
  if (hasMultipleRequests) {
    let runningDuration = 0
    let anyMissing = false
    for (const call of mainCalls) {
      if (call.durationMs === null) {
        anyMissing = true
        break
      }
      runningDuration += call.durationMs
    }
    totalDurationMs = anyMissing ? null : runningDuration
  }

  let totalCost: number | null = null
  if (hasMultipleRequests) {
    let runningCost = 0
    let anyUnknown = false
    for (const call of mainCalls) {
      if (call.cost === null) {
        anyUnknown = true
        break
      }
      runningCost += call.cost
    }
    totalCost = anyUnknown ? null : runningCost
  }

  return {
    usage,
    model,
    cost,
    durationMs,
    totalUsage,
    totalDurationMs,
    totalCost,
    requestCount: mainCalls.length,
    hasSubModelCalls,
    requests,
  }
}

export function useLLMResponseInfo(
  messages: AssistantToolMessageGroup,
): LLMResponseInfo {
  return useMemo(() => collectLLMResponseInfo(messages), [messages])
}
