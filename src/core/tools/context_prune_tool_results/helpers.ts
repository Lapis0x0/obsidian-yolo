import type { ChatMessage } from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { isContextPrunableToolName } from '../../../utils/chat/tool-context-pruning'

// `context_prune_tool_results` is this helper's only consumer, so it lives
// alongside that tool's own definition (phase2-migration.md D6 "注意").

export type ContextPruneMode = 'selected' | 'all'

export const getContextPruneMode = (
  args: Record<string, unknown>,
): ContextPruneMode => {
  const value = args.mode
  if (value === undefined) {
    return 'selected'
  }
  if (value !== 'selected' && value !== 'all') {
    throw new Error('mode must be one of: selected, all.')
  }
  return value
}

export const getContextPrunableToolCallIds = (
  messages: ChatMessage[] | undefined,
  currentToolCallId?: string,
): Set<string> => {
  const acceptedToolCallIds = new Set<string>()

  for (const message of messages ?? []) {
    if (message.role !== 'tool') {
      continue
    }

    if (
      currentToolCallId &&
      message.toolCalls.some(
        (toolCall) => toolCall.request.id === currentToolCallId,
      )
    ) {
      break
    }

    for (const toolCall of message.toolCalls) {
      if (
        isContextPrunableToolName(toolCall.request.name) &&
        toolCall.response.status === ToolCallResponseStatus.Success &&
        toolCall.response.data.type === 'text' &&
        toolCall.request.id.trim().length > 0
      ) {
        acceptedToolCallIds.add(toolCall.request.id)
      }
    }
  }

  return acceptedToolCallIds
}
