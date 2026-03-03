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
  const {
    latestAssistantMessage,
    latestAssistantWithUsage,
    latestAssistantWithDuration,
  } = useMemo(() => {
    let latestAssistantMessage: ChatAssistantMessage | undefined
    let latestAssistantWithUsage: ChatAssistantMessage | undefined
    let latestAssistantWithDuration: ChatAssistantMessage | undefined

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'assistant') {
        continue
      }

      latestAssistantMessage = latestAssistantMessage ?? message

      if (!latestAssistantWithUsage && message.metadata?.usage) {
        latestAssistantWithUsage = message
      }

      if (
        !latestAssistantWithDuration &&
        typeof message.metadata?.durationMs === 'number'
      ) {
        latestAssistantWithDuration = message
      }

      if (
        latestAssistantMessage &&
        latestAssistantWithUsage &&
        latestAssistantWithDuration
      ) {
        break
      }
    }

    return {
      latestAssistantMessage,
      latestAssistantWithUsage,
      latestAssistantWithDuration,
    }
  }, [messages])

  const usage = useMemo<ResponseUsage | null>(() => {
    return latestAssistantWithUsage?.metadata?.usage ?? null
  }, [latestAssistantWithUsage])

  const model = useMemo<ChatModel | undefined>(() => {
    return (
      latestAssistantWithUsage?.metadata?.model ??
      latestAssistantMessage?.metadata?.model
    )
  }, [latestAssistantMessage, latestAssistantWithUsage])

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
    return latestAssistantWithDuration?.metadata?.durationMs ?? null
  }, [latestAssistantWithDuration])

  return {
    usage,
    model,
    cost,
    durationMs,
  }
}
