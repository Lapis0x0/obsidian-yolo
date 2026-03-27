import type { RequestMessage } from '../../types/llm/request'

export const filterEmptyAssistantMessages = (
  requestMessages: RequestMessage[],
): RequestMessage[] => {
  return requestMessages.filter((message) => {
    if (message.role !== 'assistant') {
      return true
    }

    const hasContent = message.content.trim().length > 0
    const hasToolCalls =
      (message.tool_calls ?? []).filter(
        (toolCall) =>
          typeof toolCall.id === 'string' && toolCall.id.trim().length > 0,
      ).length > 0

    return hasContent || hasToolCalls
  })
}

export const filterRequestMessagesByToolBoundary = (
  requestMessages: RequestMessage[],
): RequestMessage[] => {
  const filteredRequestMessages: RequestMessage[] = []

  for (let index = 0; index < requestMessages.length; index += 1) {
    const message = requestMessages[index]

    if (message.role !== 'assistant') {
      if (message.role !== 'tool') {
        filteredRequestMessages.push(message)
      }
      continue
    }

    const normalizedToolCalls = (message.tool_calls ?? []).filter(
      (toolCall) => {
        return typeof toolCall.id === 'string' && toolCall.id.trim().length > 0
      },
    )

    if (normalizedToolCalls.length === 0) {
      filteredRequestMessages.push({
        ...message,
        tool_calls: undefined,
      })
      continue
    }

    const requiredToolCallIds = new Set(
      normalizedToolCalls.map((toolCall) => toolCall.id),
    )
    const matchedToolMessages: RequestMessage[] = []
    const matchedToolCallIds = new Set<string>()

    let cursor = index + 1
    for (; cursor < requestMessages.length; cursor += 1) {
      const nextMessage = requestMessages[cursor]
      if (nextMessage.role !== 'tool') {
        break
      }
      if (!requiredToolCallIds.has(nextMessage.tool_call.id)) {
        continue
      }
      matchedToolCallIds.add(nextMessage.tool_call.id)
      matchedToolMessages.push(nextMessage)
    }

    const matchedToolCalls = normalizedToolCalls.filter((toolCall) =>
      matchedToolCallIds.has(toolCall.id),
    )

    if (matchedToolCalls.length === 0) {
      filteredRequestMessages.push({
        ...message,
        tool_calls: undefined,
      })
      index = cursor - 1
      continue
    }

    filteredRequestMessages.push({
      ...message,
      tool_calls: matchedToolCalls,
    })
    filteredRequestMessages.push(...matchedToolMessages)
    index = cursor - 1
  }

  return filteredRequestMessages
}
