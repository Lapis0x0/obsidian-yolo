import { useCallback } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import type { ToolCallRequest } from '../../../types/tool-call.types'

import { buildSubagentApprovalSummary } from './subagentApprovalSummary'

export type SubagentPendingApproval = {
  toolCallId: string
  request: ToolCallRequest
}

type SubagentApprovalBlockProps = {
  /**
   * Parent conversation id — passed through to `approveToolCall` /
   * `rejectToolCall`. The service routes by `toolCallId` first, but this
   * field is kept for parity with the parent path and in case the service
   * later needs the parent conv for telemetry / scoping.
   */
  parentConversationId: string
  pendingApprovals: SubagentPendingApproval[]
}

export function SubagentApprovalBlock({
  parentConversationId,
  pendingApprovals,
}: SubagentApprovalBlockProps) {
  const plugin = usePlugin()
  const { t } = useLanguage()

  const handleApprove = useCallback(
    (toolCallId: string) =>
      plugin.getAgentService().approveToolCall({
        conversationId: parentConversationId,
        toolCallId,
      }),
    [plugin, parentConversationId],
  )

  const handleReject = useCallback(
    (toolCallId: string) => {
      plugin.getAgentService().rejectToolCall({
        conversationId: parentConversationId,
        toolCallId,
      })
    },
    [plugin, parentConversationId],
  )

  const handleApproveAll = useCallback(() => {
    void Promise.all(
      pendingApprovals.map((approval) => handleApprove(approval.toolCallId)),
    )
  }, [pendingApprovals, handleApprove])

  const handleRejectAll = useCallback(() => {
    for (const approval of pendingApprovals) {
      handleReject(approval.toolCallId)
    }
  }, [pendingApprovals, handleReject])

  const heading =
    pendingApprovals.length > 1
      ? t(
          'chat.subagent.approval.headingMulti',
          'Awaiting approval · {count}',
        ).replace('{count}', String(pendingApprovals.length))
      : t('chat.subagent.approval.heading', 'Awaiting approval')

  return (
    <div
      className="yolo-subagent-approval"
      role="group"
      aria-label={heading}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="yolo-subagent-approval__items">
        {pendingApprovals.map(({ toolCallId, request }) => {
          const summary = buildSubagentApprovalSummary(request)
          return (
            <div key={toolCallId} className="yolo-subagent-approval__item">
              <div className="yolo-subagent-approval__item-text">
                <span className="yolo-subagent-approval__item-label">
                  {summary.label}
                </span>
                {summary.detail && (
                  <span
                    className="yolo-subagent-approval__item-detail"
                    title={summary.detail}
                  >
                    {summary.detail}
                  </span>
                )}
              </div>
              <div className="yolo-subagent-approval__item-actions">
                <button
                  type="button"
                  className="yolo-subagent-approval__btn yolo-subagent-approval__btn--ghost"
                  onClick={() => handleReject(toolCallId)}
                  title={t('chat.subagent.approval.reject', 'Reject')}
                  aria-label={t('chat.subagent.approval.reject', 'Reject')}
                >
                  {t('chat.subagent.approval.reject', 'Reject')}
                </button>
                <button
                  type="button"
                  className="yolo-subagent-approval__btn yolo-subagent-approval__btn--primary"
                  onClick={() => void handleApprove(toolCallId)}
                  title={t('chat.subagent.approval.approve', 'Approve')}
                  aria-label={t('chat.subagent.approval.approve', 'Approve')}
                >
                  {t('chat.subagent.approval.approve', 'Approve')}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {pendingApprovals.length >= 2 && (
        <div className="yolo-subagent-approval__bulk">
          <button
            type="button"
            className="yolo-subagent-approval__bulk-btn yolo-subagent-approval__bulk-btn--ghost"
            onClick={handleRejectAll}
          >
            {t('chat.subagent.approval.rejectAll', 'Reject all')}
          </button>
          <button
            type="button"
            className="yolo-subagent-approval__bulk-btn yolo-subagent-approval__bulk-btn--primary"
            onClick={handleApproveAll}
          >
            {t('chat.subagent.approval.approveAll', 'Approve all')}
          </button>
        </div>
      )}
    </div>
  )
}
