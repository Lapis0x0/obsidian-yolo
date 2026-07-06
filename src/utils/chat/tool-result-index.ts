import type {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
  ChatUserMessage,
} from '../../types/chat'

export function collectToolCallIdsFromGroupedMessages(
  groupedMessages: Array<ChatUserMessage | AssistantToolMessageGroup>,
): Set<string> {
  const ids = new Set<string>()

  for (const messageOrGroup of groupedMessages) {
    if (!Array.isArray(messageOrGroup)) {
      continue
    }

    for (const message of messageOrGroup) {
      if (message.role !== 'tool') {
        continue
      }

      for (const toolCall of message.toolCalls) {
        ids.add(toolCall.request.id)
      }
    }
  }

  return ids
}

export function buildTerminalCommandResultMap(
  messages: ChatMessage[],
  visibleToolCallIds: ReadonlySet<string>,
): Map<string, ChatTerminalCommandResultMessage> {
  const map = new Map<string, ChatTerminalCommandResultMessage>()

  for (const message of messages) {
    if (
      message.role !== 'terminal_command_result' ||
      !message.delegateToolCallId ||
      !visibleToolCallIds.has(message.delegateToolCallId)
    ) {
      continue
    }
    map.set(message.delegateToolCallId, message)
  }

  return map
}

export function buildSubagentResultMap(
  messages: ChatMessage[],
  visibleToolCallIds: ReadonlySet<string>,
): Map<string, ChatSubagentResultMessage> {
  const map = new Map<string, ChatSubagentResultMessage>()

  for (const message of messages) {
    if (
      message.role !== 'subagent_result' ||
      !message.delegateToolCallId ||
      !visibleToolCallIds.has(message.delegateToolCallId)
    ) {
      continue
    }
    map.set(message.delegateToolCallId, message)
  }

  return map
}

export function reuseShallowEqualMap<T>(
  previous: ReadonlyMap<string, T>,
  next: ReadonlyMap<string, T>,
): ReadonlyMap<string, T> {
  // Entry equality relies on immutable message objects. Result updates must
  // replace the entry object instead of mutating it in place.
  if (previous.size !== next.size) {
    return next
  }

  for (const [key, value] of next) {
    if (previous.get(key) !== value) {
      return next
    }
  }

  return previous
}
