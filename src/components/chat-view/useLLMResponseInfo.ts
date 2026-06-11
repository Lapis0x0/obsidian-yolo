import { useMemo } from 'react'

import { AssistantToolMessageGroup } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { ResponseUsage } from '../../types/llm/response'
import { sumResponseUsages } from '../../utils/chat/llmUsage'
import { calculateLLMCost } from '../../utils/llm/price-calculator'

export type LLMRequestEntry = {
  // 1-based, dense across billable (usage-bearing) calls — duration-only
  // assistants are skipped, so the index never has gaps.
  index: number
  messageId: string
  usage: ResponseUsage
  durationMs: number | null
  model: ChatModel | undefined
  cost: number | null
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

  // Per-billable-call breakdown for the "Show breakdown" surface. Always
  // populated (empty array when no billable calls). Each entry binds its
  // usage/durationMs/model/cost to a single assistant message.
  requests: LLMRequestEntry[]
}

export function collectLLMResponseInfo(
  messages: AssistantToolMessageGroup,
): LLMResponseInfo {
  const calls: LLMRequestEntry[] = []
  let fallbackModel: ChatModel | undefined

  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }

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

    calls.push({
      index: calls.length + 1,
      messageId: message.id,
      usage,
      durationMs,
      model,
      cost: model ? calculateLLMCost({ model, usage }) : null,
    })
  }

  const lastCall = calls.length > 0 ? calls[calls.length - 1] : null

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

  const hasMultipleRequests = calls.length >= 2
  const totalUsage = hasMultipleRequests
    ? sumResponseUsages(calls.map((call) => call.usage))
    : null

  let totalDurationMs: number | null = null
  if (hasMultipleRequests) {
    let runningDuration = 0
    let anyMissing = false
    for (const call of calls) {
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
    for (const call of calls) {
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
    requestCount: calls.length,
    requests: calls,
  }
}

export function useLLMResponseInfo(
  messages: AssistantToolMessageGroup,
): LLMResponseInfo {
  return useMemo(() => collectLLMResponseInfo(messages), [messages])
}
