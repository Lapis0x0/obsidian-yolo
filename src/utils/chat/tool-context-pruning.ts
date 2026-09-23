import { getLocalFileToolServerName } from '../../core/mcp/localFileToolNames'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import type { ChatMessage } from '../../types/chat'
import type { ToolCallRequest } from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

const CONTEXT_PRUNE_TOOL_NAME = 'context_prune_tool_results'
const CONTEXT_COMPACT_TOOL_NAME = 'context_compact'
const LOAD_TOOL_SCHEMAS_TOOL_NAME = 'load_tool_schemas'

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
  // `load_tool_schemas` results carry the on-demand tool disclosure state for
  // the rest of the conversation — pruning them would silently drop the
  // schemas the model relies on to keep calling those tools. Compaction is the
  // long-term fallback (it copies schemas into `loadedDeferredToolSchemas`).
  return (
    normalized !== CONTEXT_PRUNE_TOOL_NAME &&
    normalized !== CONTEXT_COMPACT_TOOL_NAME &&
    normalized !== LOAD_TOOL_SCHEMAS_TOOL_NAME
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

/** What a pruned call's result reads as in later requests; the call itself stays. */
export const PRUNED_TOOL_RESULT_PLACEHOLDER = '[Result pruned from context]'

export const isContextPrunedToolCall = (
  request: Pick<ToolCallRequest, 'id' | 'name'>,
  prunedToolCallIds: ReadonlySet<string>,
): boolean =>
  prunedToolCallIds.has(request.id) && isContextPrunableToolName(request.name)
