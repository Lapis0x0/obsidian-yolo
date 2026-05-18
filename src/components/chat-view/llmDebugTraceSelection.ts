import {
  getLLMDebugTraceIdsForConversation,
  getLLMDebugTraceIdsForTurn,
  getLLMDebugTraces,
  getLinkedLLMDebugTraceIds,
} from '../../core/llm/debugCapture'
import type { AssistantToolMessageGroup } from '../../types/chat'

const CONVERSATION_TRACE_LOOKBACK_MS = 2 * 60 * 1000
const CONVERSATION_TRACE_LOOKAHEAD_MS = 30 * 1000

function mergeTraceIds(...traceIdGroups: string[][]): string[] {
  return Array.from(new Set(traceIdGroups.flat()))
}

function getTraceTimeRange(traceIds: string[]): {
  startedAt: number
  completedAt: number
} | null {
  const traces = getLLMDebugTraces(traceIds)
  if (traces.length === 0) {
    return null
  }

  return {
    startedAt: Math.min(...traces.map((trace) => trace.summary.startedAt)),
    completedAt: Math.max(
      ...traces.map(
        (trace) => trace.summary.completedAt ?? trace.summary.startedAt,
      ),
    ),
  }
}

function filterConversationTraceIdsForTurn(
  directTraceIds: string[],
  conversationTraceIds: string[],
): string[] {
  const timeRange = getTraceTimeRange(directTraceIds)
  if (!timeRange) {
    return []
  }

  return getLLMDebugTraces(conversationTraceIds)
    .filter(
      (trace) =>
        trace.summary.startedAt >=
          timeRange.startedAt - CONVERSATION_TRACE_LOOKBACK_MS &&
        trace.summary.startedAt <=
          timeRange.completedAt + CONVERSATION_TRACE_LOOKAHEAD_MS,
    )
    .map((trace) => trace.id)
}

export function getLLMDebugTraceIdsForMessages(
  messages: AssistantToolMessageGroup,
): string[] {
  const directTraceIds: string[] = []
  const conversationIds = new Set<string>()
  for (const message of messages) {
    const conversationId = message.metadata?.branchConversationId
    const sourceUserMessageId =
      message.metadata && 'sourceUserMessageId' in message.metadata
        ? message.metadata.sourceUserMessageId
        : undefined
    if (conversationId) {
      conversationIds.add(conversationId)
      if (sourceUserMessageId) {
        directTraceIds.push(
          ...getLLMDebugTraceIdsForTurn({
            conversationId,
            sourceUserMessageId,
          }),
        )
      }
    }
    if (message.role === 'assistant' && message.metadata?.llmDebugTraceId) {
      directTraceIds.push(message.metadata.llmDebugTraceId)
    }
  }

  if (directTraceIds.length === 0) {
    return []
  }

  directTraceIds.push(...getLinkedLLMDebugTraceIds(directTraceIds))

  const conversationTraceIds = Array.from(conversationIds).flatMap(
    (conversationId) =>
      getLLMDebugTraceIdsForConversation({
        conversationId,
      }),
  )

  return mergeTraceIds(
    directTraceIds,
    filterConversationTraceIdsForTurn(directTraceIds, conversationTraceIds),
  )
}

export function hasLLMDebugCacheForMessages(
  messages: AssistantToolMessageGroup,
): boolean {
  return hasLLMDebugCacheForTraceIds(getLLMDebugTraceIdsForMessages(messages))
}

export function hasLLMDebugCacheForTraceIds(traceIds: string[]): boolean {
  return getLLMDebugTraces(traceIds).length > 0
}

/**
 * True when an assistant message in the group was originally captured with a
 * debug trace (its metadata still carries `llmDebugTraceId`). Traces live in
 * memory only, so after an Obsidian restart this returns true while
 * `hasLLMDebugCacheForMessages` returns false — that gap is what surfaces the
 * "data expired on restart" tooltip on the Debug button.
 */
export function hasLLMDebugMetadataForMessages(
  messages: AssistantToolMessageGroup,
): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      typeof message.metadata?.llmDebugTraceId === 'string' &&
      message.metadata.llmDebugTraceId.length > 0,
  )
}
