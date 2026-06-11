import type { ChatMessage } from '../../types/chat'
import type { ResponseUsage } from '../../types/llm/response'

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

export const sumResponseUsages = (
  usages: readonly ResponseUsage[],
): ResponseUsage | null => {
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

  // Derive total_tokens from the summed components; provider total_tokens can
  // differ around cache accounting.
  total.total_tokens = total.prompt_tokens + total.completion_tokens

  return total
}

export const collectTotalAssistantUsage = (
  messages: readonly ChatMessage[],
): ResponseUsage | undefined => {
  const usages = messages.flatMap((message) =>
    message.role === 'assistant' && message.metadata?.usage
      ? [message.metadata.usage]
      : [],
  )
  return sumResponseUsages(usages) ?? undefined
}
