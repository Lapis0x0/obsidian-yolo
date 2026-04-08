import type { ChatAssistantMessage } from '../../types/chat'

type AssistantGenerationState =
  NonNullable<ChatAssistantMessage['metadata']>['generationState']

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

  return (
    generationState === 'streaming' || generationState === 'completed'
  )
}
