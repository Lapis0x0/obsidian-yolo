import { summarizeShellCommand } from '../shell-command-summary'

/**
 * Chat-surface summary for `bash` — ported verbatim from the
 * `toolName === 'bash'` branch of `ToolMessage.tsx`'s private
 * `getLocalToolSummaryText` (pre-D8). Wired into `TOOL_RENDERERS` as this
 * tool's `summary` field (phase2-migration.md D8).
 */
export const getBashChatSummary = ({
  argumentsObject,
}: {
  argumentsObject: Record<string, unknown> | null
}): string | undefined => {
  const command =
    typeof argumentsObject?.command === 'string'
      ? argumentsObject.command.trim()
      : ''
  return command
    ? summarizeShellCommand(command, { streaming: false })
    : undefined
}
