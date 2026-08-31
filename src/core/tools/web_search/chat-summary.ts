import { truncateText } from '../chat-summary-support'

/**
 * Chat-surface summary for `web_search` — ported verbatim from the
 * `toolName === 'web_search'` branch of `ToolMessage.tsx`'s private
 * `getLocalToolSummaryText` (pre-D8). Wired into `TOOL_RENDERERS` as this
 * tool's `summary` field (phase2-migration.md D8).
 */
export const getWebSearchChatSummary = ({
  argumentsObject,
}: {
  argumentsObject: Record<string, unknown> | null
}): string | undefined => {
  const query =
    typeof argumentsObject?.query === 'string' ? argumentsObject.query : ''
  if (query.trim().length === 0) {
    return undefined
  }
  const topic =
    typeof argumentsObject?.topic === 'string'
      ? argumentsObject.topic.trim()
      : ''
  const queryText = truncateText(query, 60)
  return topic ? `${topic} | ${queryText}` : queryText
}
