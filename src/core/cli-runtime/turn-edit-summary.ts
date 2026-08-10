import type { ChatMessage, ChatToolMessage } from '../../types/chat'
import type { ToolEditSummary } from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

export const attachCliTurnEditSummary = (
  messages: readonly ChatMessage[],
  sourceUserMessageId: string,
  editSummary: ToolEditSummary,
): readonly ChatMessage[] => {
  const sourceIndex = messages.findIndex(
    (message) => message.role === 'user' && message.id === sourceUserMessageId,
  )
  if (sourceIndex < 0) return messages
  const nextUserIndex = messages.findIndex(
    (message, index) => index > sourceIndex && message.role === 'user',
  )
  const endIndex = nextUserIndex < 0 ? messages.length : nextUserIndex
  for (let index = endIndex - 1; index > sourceIndex; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'tool') continue
    for (
      let toolCallIndex = message.toolCalls.length - 1;
      toolCallIndex >= 0;
      toolCallIndex -= 1
    ) {
      const toolCall = message.toolCalls[toolCallIndex]
      if (toolCall.response.status !== ToolCallResponseStatus.Success) continue
      const successfulResponse = toolCall.response
      const nextToolMessage: ChatToolMessage = {
        ...message,
        toolCalls: message.toolCalls.map((candidate, candidateIndex) =>
          candidateIndex === toolCallIndex
            ? {
                ...candidate,
                response: {
                  ...successfulResponse,
                  data: {
                    ...successfulResponse.data,
                    metadata: {
                      ...successfulResponse.data.metadata,
                      editSummary,
                    },
                  },
                },
              }
            : candidate,
        ),
      }
      const next = [...messages]
      next[index] = nextToolMessage
      return Object.freeze(next)
    }
  }
  return messages
}
