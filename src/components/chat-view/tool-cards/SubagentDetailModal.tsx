import { Clock, Coins, Wrench, X } from 'lucide-react'
import { Suspense, lazy, useEffect, useId } from 'react'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../../contexts/language-context'
import type { ChatMessage } from '../../../types/chat'
import { groupAssistantAndToolMessages } from '../../../utils/chat/message-groups'
import { formatTokenCount } from '../../../utils/llm/formatTokenCount'

import { formatDuration, formatSubagentActivityLine } from './subagentCardUtils'
import type {
  SubagentDetailStats,
  SubagentDisplayStatus,
} from './SubagentCardView'

const AssistantToolMessageGroupItem = lazy(
  async () => import('../AssistantToolMessageGroupItem'),
)

type SubagentDetailModalProps = {
  container: HTMLElement
  title: string
  modelName?: string
  prompt?: string
  taskId?: string
  status: SubagentDisplayStatus
  transcript?: ChatMessage[]
  activityLines: string[]
  detailStats?: SubagentDetailStats
  isTranscriptLoading?: boolean
  onClose: () => void
}

function getStatusLabel(
  status: SubagentDisplayStatus,
  t: (key: string, fallback?: string) => string,
): string {
  switch (status) {
    case 'running':
      return t('chat.liveTask.statusRunning', 'Running')
    case 'success':
      return t('chat.liveTask.statusDone', 'Done')
    case 'aborted':
      return t('chat.liveTask.statusAborted', 'Aborted')
    case 'error':
      return t('chat.liveTask.statusError', 'Error')
    case 'dispatched':
      return t('chat.subagent.statusDispatched', 'Dispatched')
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
  status,
  transcript,
  activityLines,
  detailStats,
  isTranscriptLoading = false,
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
                {getStatusLabel(status, t)}
              </span>
              {detailStats?.durationMs && detailStats.durationMs > 0 && (
                <span className="yolo-subagent-detail-meta-item">
                  <Clock size={12} />
                  {formatDuration(detailStats.durationMs)}
                </span>
              )}
              {detailStats?.toolUseCount && detailStats.toolUseCount > 0 && (
                <span className="yolo-subagent-detail-meta-item">
                  <Wrench size={12} />
                  {t('chat.subagent.toolUseCount', '{count} tools').replace(
                    '{count}',
                    String(detailStats.toolUseCount),
                  )}
                </span>
              )}
              {detailStats?.totalTokens && detailStats.totalTokens > 0 && (
                <span className="yolo-subagent-detail-meta-item">
                  <Coins size={12} />
                  {t('chat.subagent.tokenCount', '{count} tokens').replace(
                    '{count}',
                    formatTokenCount(detailStats.totalTokens),
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

          {isTranscriptLoading ? (
            <div className="yolo-subagent-detail-empty">
              {t('chat.subagent.loadingActivity', 'Loading activity…')}
            </div>
          ) : groupedTranscript ? (
            groupedTranscript.map((messageOrGroup) =>
              Array.isArray(messageOrGroup) ? (
                <Suspense
                  key={messageOrGroup.at(0)?.id ?? taskId ?? title}
                  fallback={
                    <div className="yolo-subagent-detail-empty">
                      {t('chat.subagent.loadingActivity', 'Loading activity…')}
                    </div>
                  }
                >
                  <AssistantToolMessageGroupItem
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
                </Suspense>
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
