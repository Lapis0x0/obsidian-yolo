import { truncateText } from '../chat-summary-support'

/**
 * Chat-surface summary for `js_eval` — ported verbatim from the
 * `toolName === 'js_eval'` branch of `ToolMessage.tsx`'s private
 * `getLocalToolSummaryText` (pre-D8). Wired into `TOOL_RENDERERS` as this
 * tool's `summary` field (phase2-migration.md D8).
 */
export const getJsEvalChatSummary = ({
  argumentsObject,
}: {
  argumentsObject: Record<string, unknown> | null
}): string | undefined => {
  const code =
    typeof argumentsObject?.code === 'string' ? argumentsObject.code : ''
  const preview = code.trim().replace(/\s+/g, ' ')
  return preview ? truncateText(preview, 80) : undefined
}
