import cx from 'clsx'
import { Bot, Check, Square, X } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useMemo, useRef, useState } from 'react'

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
import { SubagentDetailModal } from './SubagentDetailModal'

const DOTM_SQUARE_4_OUTER_ORDER = [
  0, 1, 2, 3, 4, 15, -1, -1, -1, 5, 14, -1, -1, -1, 6, 13, -1, -1, -1, 7, 12,
  11, 10, 9, 8,
] as const

const DOTM_SQUARE_4_MIDDLE_ORDER = [
  -1, -1, -1, -1, -1, -1, 0, 7, 6, -1, -1, 1, -1, 5, -1, -1, 2, 3, 4, -1, -1,
  -1, -1, -1, -1,
] as const

type SubagentCardProps = {
  toolCallId: string
  response: ToolCallResponse
  /**
   * Conversation id of the parent chat. Forwarded to the inline approval
   * block so approval clicks can route through `AgentService.approveToolCall`
   * with the correct scope.
   */
  conversationId: string
  args?: SubagentCardArgs
  subagentResult?: ChatSubagentResultMessage
  initialStdout?: string
  initialStderr?: string
  onAbort?: () => void
}

function DotmSquare4Loader() {
  return (
    <span className="yolo-dotm-square-4" aria-hidden="true">
      {DOTM_SQUARE_4_OUTER_ORDER.map((outerOrder, index) => {
        const middleOrder = DOTM_SQUARE_4_MIDDLE_ORDER[index]
        const order = outerOrder >= 0 ? outerOrder : middleOrder
        const className = cx(
          'yolo-dotm-square-4__dot',
          outerOrder >= 0 && 'yolo-dotm-square-4__dot--outer',
          middleOrder >= 0 && 'yolo-dotm-square-4__dot--middle',
          order < 0 && 'yolo-dotm-square-4__dot--inactive',
        )
        const style =
          order >= 0
            ? ({
                '--yolo-dotm-square-4-order': order,
              } as CSSProperties)
            : undefined

        return <span key={index} className={className} style={style} />
      })}
    </span>
  )
}

function SubagentStatusIcon({ status }: { status: ToolCallResponseStatus }) {
  switch (status) {
    case ToolCallResponseStatus.Running:
      return <DotmSquare4Loader />
    case ToolCallResponseStatus.Success:
      return <Check size={14} />
    case ToolCallResponseStatus.Aborted:
    case ToolCallResponseStatus.Error:
      return <X size={14} />
    default:
      return <Bot size={14} />
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
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [detailContainer, setDetailContainer] = useState<HTMLElement | null>(
    null,
  )
  const cardRef = useRef<HTMLDivElement | null>(null)

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
    <>
      <div
        ref={cardRef}
        className={cx(
          'yolo-subagent-card',
          isRunning && 'yolo-subagent-card--running',
          effectiveStatus === ToolCallResponseStatus.Success &&
            'yolo-subagent-card--success',
          effectiveStatus === ToolCallResponseStatus.Error &&
            'yolo-subagent-card--error',
          effectiveStatus === ToolCallResponseStatus.Aborted &&
            'yolo-subagent-card--aborted',
        )}
      >
        <div className="yolo-subagent-card__row">
          <button
            type="button"
            className="yolo-subagent-card__main"
            onClick={() => {
              const chatContainer =
                cardRef.current?.closest<HTMLElement>('.yolo-chat-container') ??
                null
              if (!chatContainer) return
              setDetailContainer(chatContainer)
              setIsModalOpen(true)
            }}
            aria-label={t('chat.subagent.openDetails', 'View subagent details')}
          >
            <span className="yolo-subagent-card__icon">
              <SubagentStatusIcon status={effectiveStatus} />
            </span>
            <span className="yolo-subagent-card__content">
              <span className="yolo-subagent-card__primary">
                <span className="yolo-subagent-card__title">{title}</span>
                {modelName && (
                  <span className="yolo-subagent-card__model">{modelName}</span>
                )}
              </span>
              <span className="yolo-subagent-card__summary">{subtitle}</span>
            </span>
          </button>
          {isRunning && onAbort && (
            <button
              type="button"
              className="yolo-subagent-card__abort-btn"
              onClick={(event) => {
                event.stopPropagation()
                void onAbort()
              }}
              title={t('chat.toolCall.abort', 'Abort')}
            >
              <Square size={12} />
            </button>
          )}
        </div>
        {isAwaitingApproval && (
          <SubagentApprovalBlock
            parentConversationId={conversationId}
            pendingApprovals={pendingApprovals}
          />
        )}
      </div>

      {isModalOpen && detailContainer && (
        <SubagentDetailModal
          container={detailContainer}
          title={title}
          modelName={modelName}
          prompt={prompt}
          taskId={taskId}
          effectiveStatus={effectiveStatus}
          subagentResult={subagentResult}
          liveTranscript={liveTask?.liveTranscript}
          activityLines={activityLines}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </>
  )
}
