import type { ChatAssistantMessage, ChatMessage } from '../../types/chat'

type AssistantGenerationState = NonNullable<
  ChatAssistantMessage['metadata']
>['generationState']

export function shouldRenderAssistantToolPreview({
  generationState,
  toolCallRequestCount,
  hasToolMessages,
}: {
  generationState?: AssistantGenerationState
  toolCallRequestCount: number
  hasToolMessages: boolean
}): boolean {
  if (hasToolMessages || toolCallRequestCount <= 0) {
    return false
  }

  return generationState === 'streaming' || generationState === 'completed'
}

export function hasMatchingToolMessageForRequests(
  requestIds: readonly string[],
  messages: readonly ChatMessage[],
): boolean {
  if (requestIds.length === 0) return false
  const ids = new Set(requestIds)
  return messages.some(
    (message) =>
      message.role === 'tool' &&
      message.toolCalls.some((call) => ids.has(call.request.id)),
  )
}
