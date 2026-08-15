import type { ReactNode } from 'react'

import { SubagentCard } from '../../../components/chat-view/tool-cards/SubagentCard'
import type { SubagentCardArgs } from '../../../components/chat-view/tool-cards/subagentCardUtils'
import type {
  ToolRenderer,
  ToolRendererProps,
} from '../../../components/chat-view/tool-renderers/types'
import {
  type ToolCallRequest,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../../types/tool-call.types'

// Ported verbatim from ToolMessage.tsx's private `extractSubagentArgs` /
// `extractSyntheticLiveTaskOutput` helpers (small, delegate_subagent-only
// pure functions with no reason to live anywhere else). The ToolMessage.tsx
// copies are untouched this phase (replacing its `if` chain is D8); once
// that lands, those copies collapse into these.
const extractSubagentArgs = (
  rawArguments?: ToolCallRequest['arguments'],
): SubagentCardArgs | undefined => {
  const parsed = getToolCallArgumentsObject(rawArguments)
  if (!parsed) return undefined
  const title =
    typeof parsed.description === 'string' ? parsed.description : undefined
  return title ? { title } : undefined
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
 * Mounts the shared `SubagentCard` (owned by `tool-cards/`, intentionally
 * NOT moved into `core/tools/` — see master.md §3.2 / phase1-skeleton.md D3:
 * it's a React component with its own hooks and sibling styling, and
 * dragging it into `core/tools/` would pull UI dependencies into core). This
 * file only adapts `ToolRendererProps` into `SubagentCard`'s existing prop
 * shape (D3 question 1's answer: those props — `toolCallId`, `response`,
 * `conversationId`, `args`, `subagentResult`, `initialStdout`/
 * `initialStderr`, `onAbort` — are all plain values or callbacks the caller
 * can hand in; nothing here needs message-tree/navigation state directly).
 *
 * Returns `null` while pending approval, matching the current
 * `isDelegateSubagentRequest(request) && effectiveStatus !==
 * PendingApproval` guard in ToolMessage.tsx — that state falls through to
 * the generic header/approval-footer UI instead of the card.
 */
const render = ({
  toolCallId,
  request,
  response,
  conversationId,
  subagentResult,
  onAbort,
}: ToolRendererProps): ReactNode => {
  if (response.status === ToolCallResponseStatus.PendingApproval) {
    return null
  }

  const syntheticLiveTaskOutput = extractSyntheticLiveTaskOutput(
    request.arguments,
  )

  return (
    <SubagentCard
      toolCallId={toolCallId}
      response={response}
      conversationId={conversationId}
      args={extractSubagentArgs(request.arguments)}
      subagentResult={subagentResult}
      initialStdout={syntheticLiveTaskOutput.stdout}
      initialStderr={syntheticLiveTaskOutput.stderr}
      onAbort={onAbort}
    />
  )
}

// `replace`, not `body`: SubagentCard takes over the entire tool-call block
// (ToolMessage.tsx:1520 `return`s it directly), rather than augmenting the
// default collapsed card the way LiveTaskCard does.
export const delegateSubagentRenderer: ToolRenderer = {
  kind: 'replace',
  render,
}
