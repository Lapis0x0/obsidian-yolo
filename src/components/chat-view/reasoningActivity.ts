import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
} from '../../types/chat'

const hasVisibleAssistantActivity = (message: ChatAssistantMessage): boolean =>
  message.content.trim().length > 0 ||
  Boolean(message.reasoning?.trim()) ||
  Boolean(message.annotations?.length) ||
  Boolean(message.toolCallRequests?.length) ||
  Boolean(message.metadata?.providerMetadata?.hostedWebSearch?.length) ||
  Boolean(message.metadata?.errorMessage) ||
  message.metadata?.generationState === 'streaming'

const hasVisibleActivity = (
  message: AssistantToolMessageGroup[number],
): boolean =>
  message.role === 'assistant' ? hasVisibleAssistantActivity(message) : true

/**
 * Reasoning activity is a property of its position in the shared timeline,
 * not of a provider-specific event lifecycle. The latest reasoning-only
 * message stays active while the run is active; any later visible activity
 * (assistant text, another reasoning block, a tool call/result, etc.) settles
 * it for every runtime.
 */
export const isReasoningActivityActive = ({
  messages,
  messageIndex,
  isRunActive,
}: {
  messages: AssistantToolMessageGroup
  messageIndex: number
  isRunActive: boolean
}): boolean => {
  if (!isRunActive) return false
  const message = messages[messageIndex]
  if (
    message?.role !== 'assistant' ||
    !message.reasoning?.trim() ||
    message.content.trim() ||
    message.annotations?.length ||
    message.toolCallRequests?.length ||
    message.metadata?.providerMetadata?.hostedWebSearch?.length ||
    message.metadata?.errorMessage
  ) {
    return false
  }
  return !messages.slice(messageIndex + 1).some(hasVisibleActivity)
}
