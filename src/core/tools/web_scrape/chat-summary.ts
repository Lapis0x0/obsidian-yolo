import { truncateText } from '../chat-summary-support'

/**
 * Chat-surface summary for `web_scrape` — ported verbatim from the
 * `toolName === 'web_scrape'` branch of `ToolMessage.tsx`'s private
 * `getLocalToolSummaryText`. Wired into `TOOL_RENDERERS` as this tool's
 * `summary` field.
 */
export const getWebScrapeChatSummary = ({
  argumentsObject,
}: {
  argumentsObject: Record<string, unknown> | null
}): string | undefined => {
  const url =
    typeof argumentsObject?.url === 'string' ? argumentsObject.url : ''
  return url ? truncateText(url, 80) : undefined
}
