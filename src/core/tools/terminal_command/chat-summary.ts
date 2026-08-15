import { truncateText } from '../chat-summary-support'
import { summarizeShellCommand } from '../shell-command-summary'

/**
 * Chat-surface summary for `terminal_command` — ported verbatim from the
 * `toolName === 'terminal_command'` branch of `ToolMessage.tsx`'s private
 * `getLocalToolSummaryText` (pre-D8). Wired into `TOOL_RENDERERS` as this
 * tool's `summary` field (phase2-migration.md D8).
 *
 * `labels` only carries the three session-follow-up strings this tool needs
 * — a structural subset of `ToolMessage.tsx`'s `ToolLabels`, not an import
 * of it (that type lives in a `components/` file; importing it here would
 * violate the "core does not import components" boundary and — since
 * `ToolLabels` is defined in `ToolMessage.tsx`, which itself will import
 * `TOOL_RENDERERS` — would create a cycle). The real `ToolLabels` object
 * structurally satisfies this narrower shape, so callers just pass it
 * through unchanged.
 */
export type TerminalCommandSummaryLabels = {
  terminalCommandSessionPoll: (sessionId: number) => string
  terminalCommandSessionKill: (sessionId: number) => string
  terminalCommandSessionInput: (
    sessionId: number,
    inputPreview: string,
  ) => string
}

const asInteger = (value: unknown): number | undefined => {
  return Number.isInteger(value) ? (value as number) : undefined
}

export const getTerminalCommandChatSummary = ({
  argumentsObject,
  labels,
}: {
  argumentsObject: Record<string, unknown> | null
  labels: TerminalCommandSummaryLabels
}): string | undefined => {
  const command =
    typeof argumentsObject?.command === 'string'
      ? argumentsObject.command.trim()
      : ''
  if (command) {
    return summarizeShellCommand(command, {
      streaming: argumentsObject?.background === true,
    })
  }

  const sessionId = asInteger(argumentsObject?.session_id)
  if (typeof sessionId !== 'number') {
    return undefined
  }

  if (argumentsObject?.kill === true) {
    return labels.terminalCommandSessionKill(sessionId)
  }

  const input =
    typeof argumentsObject?.input === 'string'
      ? argumentsObject.input.trim()
      : ''
  if (input) {
    const preview = truncateText(input.replace(/\s+/g, ' '), 60)
    return labels.terminalCommandSessionInput(sessionId, preview)
  }

  return labels.terminalCommandSessionPoll(sessionId)
}
