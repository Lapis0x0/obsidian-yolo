import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import type { ChatMessage, ChatToolMessage } from '../../types/chat'
import type { ToolCallRequest } from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

const CONTEXT_PRUNE_TOOL_NAME = 'context_prune_tool_results'
const CONTEXT_COMPACT_TOOL_NAME = 'context_compact'

const normalizeToolName = (toolName: string): string => {
  try {
    const parsed = parseToolName(toolName)
    if (parsed.serverName === getLocalFileToolServerName()) {
      return parsed.toolName
    }
  } catch {
    // Keep original tool name when it is already unqualified.
  }

  return toolName
}

export const isContextPruneToolName = (toolName: string): boolean => {
  return normalizeToolName(toolName) === CONTEXT_PRUNE_TOOL_NAME
}

export const isContextPrunableToolName = (toolName: string): boolean => {
  const normalized = normalizeToolName(toolName)
  return (
    normalized !== CONTEXT_PRUNE_TOOL_NAME &&
    normalized !== CONTEXT_COMPACT_TOOL_NAME
  )
}

const getPrunedToolCallIdsFromText = (text: string): string[] => {
  try {
    const parsed = JSON.parse(text) as {
      acceptedToolCallIds?: unknown
      prunedToolCallIds?: unknown
      toolCallIds?: unknown
    }

    const candidate = Array.isArray(parsed.acceptedToolCallIds)
      ? parsed.acceptedToolCallIds
      : Array.isArray(parsed.prunedToolCallIds)
        ? parsed.prunedToolCallIds
        : parsed.toolCallIds

    if (!Array.isArray(candidate)) {
      return []
    }

    return candidate
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(
        (value, index, arr) => value.length > 0 && arr.indexOf(value) === index,
      )
  } catch {
    return []
  }
}

export const collectContextPrunedToolCallIds = (
  messages: ChatMessage[],
): Set<string> => {
  const prunedToolCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'tool') {
      continue
    }

    for (const toolCall of message.toolCalls) {
      if (
        toolCall.response.status !== ToolCallResponseStatus.Success ||
        toolCall.response.data.type !== 'text' ||
        !isContextPruneToolName(toolCall.request.name)
      ) {
        continue
      }

      for (const prunedToolCallId of getPrunedToolCallIdsFromText(
        toolCall.response.data.text,
      )) {
        prunedToolCallIds.add(prunedToolCallId)
      }
    }
  }

  return prunedToolCallIds
}

export const filterContextPrunedAssistantToolCalls = (
  toolCalls: ToolCallRequest[] | undefined,
  prunedToolCallIds: ReadonlySet<string>,
): ToolCallRequest[] | undefined => {
  if (!toolCalls || toolCalls.length === 0 || prunedToolCallIds.size === 0) {
    return toolCalls
  }

  const nextToolCalls = toolCalls.filter((toolCall) => {
    return !(
      prunedToolCallIds.has(toolCall.id) &&
      isContextPrunableToolName(toolCall.name)
    )
  })

  return nextToolCalls.length > 0 ? nextToolCalls : undefined
}

export const filterContextPrunedToolCalls = (
  toolCalls: ChatToolMessage['toolCalls'],
  prunedToolCallIds: ReadonlySet<string>,
): ChatToolMessage['toolCalls'] => {
  if (toolCalls.length === 0 || prunedToolCallIds.size === 0) {
    return toolCalls
  }

  return toolCalls.filter((toolCall) => {
    return !(
      prunedToolCallIds.has(toolCall.request.id) &&
      isContextPrunableToolName(toolCall.request.name)
    )
  })
}
