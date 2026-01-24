import { useMemo } from 'react'

import {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { ResponseUsage } from '../../types/llm/response'
import { calculateLLMCost } from '../../utils/llm/price-calculator'

type LLMResponseInfo = {
  usage: ResponseUsage | null
  model: ChatModel | undefined
  cost: number | null
  durationMs: number | null
}

export function useLLMResponseInfo(
  messages: AssistantToolMessageGroup,
): LLMResponseInfo {
  const usage = useMemo<ResponseUsage | null>(() => {
    return messages.reduce((acc: ResponseUsage | null, message) => {
      if (message.role === 'assistant' && message.metadata?.usage) {
        if (!acc) {
          return message.metadata.usage
        }
        return {
          prompt_tokens:
            acc.prompt_tokens + message.metadata.usage.prompt_tokens,
          completion_tokens:
            acc.completion_tokens + message.metadata.usage.completion_tokens,
          total_tokens: acc.total_tokens + message.metadata.usage.total_tokens,
        }
      }
      return acc
    }, null)
  }, [messages])

  const model = useMemo<ChatModel | undefined>(() => {
    const assistantMessageWithModel = messages.find(
      (message): message is ChatAssistantMessage =>
        message.role === 'assistant' && !!message.metadata?.model,
    )
    return assistantMessageWithModel?.metadata?.model
  }, [messages])

  const cost = useMemo<number | null>(() => {
    if (!model || !usage) {
      return null
    }
    return calculateLLMCost({
      model,
      usage,
    })
  }, [model, usage])

  const durationMs = useMemo<number | null>(() => {
    let totalDuration = 0
    let hasDuration = false
    for (const message of messages) {
      if (message.role === 'assistant') {
        const duration = message.metadata?.durationMs
        if (typeof duration === 'number') {
          hasDuration = true
          totalDuration += duration
        }
      }
    }
    return hasDuration ? totalDuration : null
  }, [messages])

  return {
    usage,
    model,
    cost,
    durationMs,
  }
}
