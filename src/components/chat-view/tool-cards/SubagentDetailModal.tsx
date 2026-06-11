import { Clock, Coins, Wrench, X } from 'lucide-react'
import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../../contexts/language-context'
import type {
  ChatMessage,
  ChatSubagentResultMessage,
} from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { groupAssistantAndToolMessages } from '../../../utils/chat/message-groups'
import { formatTokenCount } from '../../../utils/llm/formatTokenCount'
import AssistantToolMessageGroupItem from '../AssistantToolMessageGroupItem'

import { formatDuration, formatSubagentActivityLine } from './subagentCardUtils'

type SubagentDetailModalProps = {
  container: HTMLElement
  title: string
  modelName?: string
  prompt?: string
  taskId?: string
  effectiveStatus: ToolCallResponseStatus
  subagentResult?: ChatSubagentResultMessage
  liveTranscript?: ChatMessage[]
  activityLines: string[]
  onClose: () => void
}

function getStatusLabel(
  status: ToolCallResponseStatus,
  t: (key: string, fallback?: string) => string,
): string {
  switch (status) {
    case ToolCallResponseStatus.Running:
      return t('chat.liveTask.statusRunning', 'Running')
    case ToolCallResponseStatus.Success:
      return t('chat.liveTask.statusDone', 'Done')
    case ToolCallResponseStatus.Aborted:
      return t('chat.liveTask.statusAborted', 'Aborted')
    case ToolCallResponseStatus.Error:
      return t('chat.liveTask.statusError', 'Error')
    default:
      return status
  }
}

export function SubagentDetailModal({
  container,
  title,
  modelName,
  prompt,
  taskId,
  effectiveStatus,
  subagentResult,
  liveTranscript,
  activityLines,
  onClose,
}: SubagentDetailModalProps) {
  const { t } = useLanguage()
  const titleId = useId()

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const transcript =
    subagentResult?.transcript ??
    (liveTranscript && liveTranscript.length > 0 ? liveTranscript : undefined)
  const groupedTranscript =
    transcript && transcript.length > 0
      ? groupAssistantAndToolMessages(transcript)
      : null

  const visibleActivityLines = activityLines.filter(
    (line) =>
      !line.startsWith('[state] starting') &&
      !line.startsWith('[state] completed'),
  )

  return createPortal(
    <div
      className="yolo-subagent-detail-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="yolo-subagent-detail-panel">
        <div className="yolo-subagent-detail-header">
          <div className="yolo-subagent-detail-header-text">
            <div id={titleId} className="yolo-subagent-detail-title">
              {title}
            </div>
            <div className="yolo-subagent-detail-meta">
              {modelName && (
                <span className="yolo-subagent-detail-meta-item">
                  {modelName}
                </span>
              )}
              <span className="yolo-subagent-detail-meta-item">
                {getStatusLabel(effectiveStatus, t)}
              </span>
              {subagentResult && subagentResult.durationMs > 0 && (
                <span className="yolo-subagent-detail-meta-item">
                  <Clock size={12} />
                  {formatDuration(subagentResult.durationMs)}
                </span>
              )}
              {subagentResult && subagentResult.toolUseCount > 0 && (
                <span className="yolo-subagent-detail-meta-item">
                  <Wrench size={12} />
                  {t('chat.subagent.toolUseCount', '{count} tools').replace(
                    '{count}',
                    String(subagentResult.toolUseCount),
                  )}
                </span>
              )}
              {subagentResult &&
                subagentResult.usage &&
                subagentResult.usage.total_tokens > 0 && (
                  <span className="yolo-subagent-detail-meta-item">
                    <Coins size={12} />
                    {t('chat.subagent.tokenCount', '{count} tokens').replace(
                      '{count}',
                      formatTokenCount(subagentResult.usage.total_tokens),
                    )}
                  </span>
                )}
            </div>
          </div>
          <button
            type="button"
            className="clickable-icon yolo-subagent-detail-close"
            aria-label={t('common.close', 'Close')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="yolo-subagent-detail-body">
          {prompt && (
            <div className="yolo-subagent-detail-prompt">{prompt}</div>
          )}

          {groupedTranscript ? (
            groupedTranscript.map((messageOrGroup) =>
              Array.isArray(messageOrGroup) ? (
                <AssistantToolMessageGroupItem
                  key={messageOrGroup.at(0)?.id ?? taskId ?? title}
                  messages={messageOrGroup}
                  conversationId={taskId ?? 'subagent-transcript'}
                  suppressFooter
                  showInlineInfo={false}
                  showRetryAction={false}
                  showInsertAction={false}
                  showCopyAction={false}
                  showBranchAction={false}
                  showEditAction={false}
                  showDeleteAction={false}
                  showQuoteAction={false}
                  showRunningToolFooter={false}
                  isApplying={false}
                  activeApplyRequestKey={null}
                  onApply={() => {}}
                  onToolMessageUpdate={() => {}}
                  onEditStart={() => {}}
                  onEditCancel={() => {}}
                  onEditSave={() => {}}
                  onDeleteGroup={() => {}}
                  onRetryGroup={() => {}}
                  onBranchGroup={() => {}}
                  onOpenEditSummaryFile={() => {}}
                  onQuoteAssistantSelection={() => {}}
                />
              ) : null,
            )
          ) : visibleActivityLines.length > 0 ? (
            <div className="yolo-subagent-detail-activity">
              {visibleActivityLines
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line, index) => (
                  <div
                    key={`${index}-${line}`}
                    className="yolo-subagent-detail-activity-row"
                  >
                    {formatSubagentActivityLine(line)}
                  </div>
                ))}
            </div>
          ) : (
            <div className="yolo-subagent-detail-empty">
              {t('chat.subagent.noActivity', 'No activity yet.')}
            </div>
          )}
        </div>
      </div>
    </div>,
    container,
  )
}
