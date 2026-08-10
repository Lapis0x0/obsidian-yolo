import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useLiveTaskStream } from '../../../hooks/useLiveTaskStream'
import { useSubagentTask } from '../../../hooks/useSubagentTask'
import type { ChatSubagentResultMessage } from '../../../types/chat'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'

import {
  SubagentApprovalBlock,
  type SubagentPendingApproval,
} from './SubagentApprovalBlock'
import {
  type SubagentCardArgs,
  buildSubagentCompletionSummary,
  collectSubagentActivityText,
  getLatestActivityLine,
  normalizeActivityLines,
  parseAcceptedSubagentResponse,
  resolveSubagentEffectiveStatus,
} from './subagentCardUtils'
import {
  SubagentCardView,
  type SubagentDisplayStatus,
} from './SubagentCardView'

type SubagentCardProps = {
  toolCallId: string
  response: ToolCallResponse
  conversationId: string
  args?: SubagentCardArgs
  subagentResult?: ChatSubagentResultMessage
  initialStdout?: string
  initialStderr?: string
  onAbort?: () => void
}

function toDisplayStatus(
  status: ToolCallResponseStatus,
): SubagentDisplayStatus {
  switch (status) {
    case ToolCallResponseStatus.Running:
      return 'running'
    case ToolCallResponseStatus.Success:
      return 'success'
    case ToolCallResponseStatus.Aborted:
      return 'aborted'
    case ToolCallResponseStatus.Error:
      return 'error'
    default:
      return 'dispatched'
  }
}

export function SubagentCard({
  toolCallId,
  response,
  conversationId,
  args,
  subagentResult,
  initialStdout,
  initialStderr,
  onAbort,
}: SubagentCardProps) {
  const { t } = useLanguage()
  const stream = useLiveTaskStream(toolCallId)
  const accepted = useMemo(
    () => parseAcceptedSubagentResponse(response),
    [response],
  )

  const effectiveStatus = resolveSubagentEffectiveStatus({
    subagentResult,
    stream,
    response,
  })
  const isRunning = effectiveStatus === ToolCallResponseStatus.Running

  const title =
    args?.title || subagentResult?.title || accepted.title || toolCallId
  const modelName = subagentResult?.modelName || accepted.modelName
  const taskId = subagentResult?.taskId || accepted.taskId
  const liveTask = useSubagentTask(taskId)

  const fallbackError =
    response.status === ToolCallResponseStatus.Error
      ? response.error
      : undefined

  const activityText = useMemo(
    () =>
      collectSubagentActivityText({
        subagentResult,
        stream,
        initialStderr,
        initialStdout,
        fallbackError,
      }),
    [subagentResult, stream, initialStderr, initialStdout, fallbackError],
  )

  const activityLines = useMemo(
    () => normalizeActivityLines(activityText),
    [activityText],
  )
  const liveAssistantSummary = useMemo(() => {
    const liveTranscript = liveTask?.liveTranscript
    if (!liveTranscript) return undefined
    for (let index = liveTranscript.length - 1; index >= 0; index -= 1) {
      const message = liveTranscript[index]
      if (message.role === 'assistant' && message.content.trim().length > 0) {
        return message.content.trim().split('\n').at(-1)
      }
    }
    return undefined
  }, [liveTask?.liveTranscript])

  const activitySubtitle = subagentResult
    ? buildSubagentCompletionSummary({ subagentResult, t })
    : liveAssistantSummary ||
      getLatestActivityLine(activityLines) ||
      (isRunning
        ? t('chat.subagent.planningNextMoves', 'Planning next moves')
        : t('chat.subagent.noActivity', 'No activity yet.'))

  const prompt = subagentResult?.prompt ?? liveTask?.prompt

  // Surface pending tool approvals inside the card. The subagent runtime
  // pauses at PendingApproval (loop-worker emits done; runChildAgent waits
  // on a gate), and `liveTask.liveTranscript` mirrors the runtime messages
  // — so the card can render approval buttons next to the running thinking
  // output. See `docs/plans/2026-06-18-subagent-tool-approval-routing.md`.
  const pendingApprovals = useMemo<SubagentPendingApproval[]>(() => {
    const transcript = liveTask?.liveTranscript ?? []
    const result: SubagentPendingApproval[] = []
    for (const message of transcript) {
      if (message.role !== 'tool') continue
      for (const toolCall of message.toolCalls) {
        if (
          toolCall.response.status === ToolCallResponseStatus.PendingApproval
        ) {
          result.push({
            toolCallId: toolCall.request.id,
            request: toolCall.request,
          })
        }
      }
    }
    return result
  }, [liveTask?.liveTranscript])
  const isAwaitingApproval = pendingApprovals.length > 0
  const subtitle = isAwaitingApproval
    ? pendingApprovals.length > 1
      ? t(
          'chat.subagent.approval.headingMulti',
          'Awaiting approval · {count}',
        ).replace('{count}', String(pendingApprovals.length))
      : t('chat.subagent.approval.heading', 'Awaiting approval')
    : activitySubtitle

  return (
    <SubagentCardView
      title={title}
      modelName={modelName}
      subtitle={subtitle}
      status={toDisplayStatus(effectiveStatus)}
      prompt={prompt}
      taskId={taskId}
      transcript={subagentResult?.transcript ?? liveTask?.liveTranscript}
      activityLines={activityLines}
      detailStats={
        subagentResult
          ? {
              durationMs: subagentResult.durationMs,
              toolUseCount: subagentResult.toolUseCount,
              totalTokens: subagentResult.usage?.total_tokens,
            }
          : undefined
      }
      onAbort={isRunning ? onAbort : undefined}
      footer={
        isAwaitingApproval ? (
          <SubagentApprovalBlock
            conversationId={conversationId}
            pendingApprovals={pendingApprovals}
          />
        ) : undefined
      }
    />
  )
}
