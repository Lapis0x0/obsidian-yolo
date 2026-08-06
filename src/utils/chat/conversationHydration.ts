import type { ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

export const normalizeHydratedConversationMessages = (
  messages: ChatMessage[],
): { messages: ChatMessage[]; changed: boolean } => {
  let changed = false

  const nextMessages = messages.map((message) => {
    if (
      message.role === 'assistant' &&
      message.metadata?.generationState === 'streaming'
    ) {
      changed = true
      return {
        ...message,
        metadata: {
          ...message.metadata,
          generationState: 'aborted' as const,
        },
      }
    }

    if (message.role !== 'tool') {
      return message
    }

    let toolCallUpdated = false
    const nextToolCalls = message.toolCalls.map((toolCall) => {
      if (toolCall.response.status !== ToolCallResponseStatus.Running) {
        return toolCall
      }

      toolCallUpdated = true
      changed = true
      return {
        ...toolCall,
        response: { status: ToolCallResponseStatus.Aborted as const },
      }
    })

    if (!toolCallUpdated && message.metadata?.branchRunStatus !== 'running') {
      return message
    }

    if (message.metadata?.branchRunStatus === 'running') {
      changed = true
    }

    return {
      ...message,
      toolCalls: nextToolCalls,
      metadata:
        message.metadata?.branchRunStatus === 'running'
          ? {
              ...message.metadata,
              branchRunStatus: 'aborted' as const,
            }
          : message.metadata,
    }
  })

  return {
    messages: nextMessages,
    changed,
  }
}
