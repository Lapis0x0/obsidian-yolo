import type { ReactNode } from 'react'

import { LiveTaskCard } from '../../../components/chat-view/tool-cards/LiveTaskCard'
import type {
  ToolRenderer,
  ToolRendererProps,
} from '../../../components/chat-view/tool-renderers/types'
import {
  type ToolCallRequest,
  getToolCallArgumentsObject,
} from '../../../types/tool-call.types'

import { getTerminalCommandChatSummary } from './chat-summary'

// Ported verbatim from ToolMessage.tsx's private `extractTerminalCommandArgs`
// / `extractSyntheticLiveTaskOutput` helpers — same precedent as
// `delegate_subagent/ui.tsx` duplicating its own small pure extraction
// helpers rather than sharing them (D8: "small, single-tool-only pure
// functions with no reason to live anywhere else").
const extractTerminalCommandArgs = (
  rawArguments?: ToolCallRequest['arguments'],
): { command?: string; workingDirectory?: string } | undefined => {
  const parsed = getToolCallArgumentsObject(rawArguments)
  if (!parsed) return undefined
  const command =
    typeof parsed.command === 'string' ? parsed.command : undefined
  const workingDirectory =
    typeof parsed.cwd === 'string' ? parsed.cwd : undefined
  if (!command && !workingDirectory) return undefined
  return { command, workingDirectory }
}

const extractSyntheticLiveTaskOutput = (
  rawArguments?: ToolCallRequest['arguments'],
): { stdout?: string; stderr?: string } => {
  const parsed = getToolCallArgumentsObject(rawArguments)
  if (!parsed) return {}
  return {
    stdout: typeof parsed.stdout === 'string' ? parsed.stdout : undefined,
    stderr: typeof parsed.stderr === 'string' ? parsed.stderr : undefined,
  }
}

/**
 * Mounts the shared `LiveTaskCard` inside the generic collapsed card's
 * content area (`kind: 'body'` — NOT `'replace'`: unlike `SubagentCard`,
 * this augments the default header/collapse chrome rather than taking over
 * the whole tool-call block; see `tool-renderers/types.ts`'s doc comment).
 *
 * Only reached for the local `terminal_command` tool by name.
 * `ToolMessage.tsx` still mounts `LiveTaskCard` directly (not through this
 * renderer) for two other sources of the same "terminal-like" shape — CLI
 * `command_execution` capability calls and the legacy
 * `delegate_external_agent` tool name — because neither is tool-name-indexed
 * (D8: non-tool-name branches stay inline).
 *
 * `props.terminalCommandResult` (present only once a background session's
 * result has been hydrated from persisted state) takes priority over any
 * synthetic stdout/stderr embedded directly in the request arguments —
 * matching `ToolMessage.tsx`'s pre-D8 `syntheticLiveTaskOutput` computation
 * verbatim. `props.response` is expected to already be the caller's
 * `effectiveTerminalResponse` (hydrated from `terminalCommandResult` when
 * present) — that computation doesn't depend on which renderer ends up
 * displaying it, so it stays in `ToolMessage.tsx`, computed once.
 */
const render = ({
  toolCallId,
  request,
  response,
  onAbort,
  terminalCommandResult,
}: ToolRendererProps): ReactNode => {
  const syntheticLiveTaskOutput = terminalCommandResult
    ? {}
    : extractSyntheticLiveTaskOutput(request.arguments)

  return (
    <LiveTaskCard
      toolCallId={toolCallId}
      response={response}
      args={extractTerminalCommandArgs(request.arguments)}
      initialStdout={
        terminalCommandResult?.stdout ?? syntheticLiveTaskOutput.stdout
      }
      initialStderr={
        terminalCommandResult?.stderr ?? syntheticLiveTaskOutput.stderr
      }
      onAbort={onAbort}
    />
  )
}

export const terminalCommandRenderer: ToolRenderer = {
  kind: 'body',
  render,
  summary: getTerminalCommandChatSummary,
}
