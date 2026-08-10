import cx from 'clsx'
import { Bot, Check, Square, X } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type { ChatMessage } from '../../../types/chat'

import { SubagentDetailModal } from './SubagentDetailModal'

export type SubagentDisplayStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'aborted'
  | 'dispatched'

export type SubagentDetailStats = {
  durationMs?: number
  toolUseCount?: number
  totalTokens?: number
}

type SubagentCardViewProps = {
  title: string
  subtitle: string
  status: SubagentDisplayStatus
  modelName?: string
  prompt?: string
  taskId?: string
  transcript?: readonly ChatMessage[]
  activityLines?: string[]
  detailStats?: SubagentDetailStats
  isTranscriptLoading?: boolean
  footer?: ReactNode
  onAbort?: () => void
  onDetailOpenChange?: (isOpen: boolean) => void
}

const DOTM_SQUARE_4_OUTER_ORDER = [
  0, 1, 2, 3, 4, 15, -1, -1, -1, 5, 14, -1, -1, -1, 6, 13, -1, -1, -1, 7, 12,
  11, 10, 9, 8,
] as const

const DOTM_SQUARE_4_MIDDLE_ORDER = [
  -1, -1, -1, -1, -1, -1, 0, 7, 6, -1, -1, 1, -1, 5, -1, -1, 2, 3, 4, -1, -1,
  -1, -1, -1, -1,
] as const

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

function SubagentStatusIcon({ status }: { status: SubagentDisplayStatus }) {
  switch (status) {
    case 'running':
      return <DotmSquare4Loader />
    case 'success':
      return <Check size={14} />
    case 'aborted':
    case 'error':
      return <X size={14} />
    default:
      return <Bot size={14} />
  }
}

export function SubagentCardView({
  title,
  subtitle,
  status,
  modelName,
  prompt,
  taskId,
  transcript,
  activityLines = [],
  detailStats,
  isTranscriptLoading = false,
  footer,
  onAbort,
  onDetailOpenChange,
}: SubagentCardViewProps) {
  const { t } = useLanguage()
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [detailContainer, setDetailContainer] = useState<HTMLElement | null>(
    null,
  )
  const cardRef = useRef<HTMLDivElement | null>(null)

  const setModalOpen = (isOpen: boolean) => {
    setIsModalOpen(isOpen)
    onDetailOpenChange?.(isOpen)
  }

  return (
    <>
      <div
        ref={cardRef}
        className={cx(
          'yolo-subagent-card',
          status === 'running' && 'yolo-subagent-card--running',
          status === 'success' && 'yolo-subagent-card--success',
          status === 'error' && 'yolo-subagent-card--error',
          status === 'aborted' && 'yolo-subagent-card--aborted',
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
              setModalOpen(true)
            }}
            aria-label={t('chat.subagent.openDetails', 'View subagent details')}
          >
            <span className="yolo-subagent-card__icon">
              <SubagentStatusIcon status={status} />
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
          {status === 'running' && onAbort && (
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
        {footer}
      </div>

      {isModalOpen && detailContainer && (
        <SubagentDetailModal
          container={detailContainer}
          title={title}
          modelName={modelName}
          prompt={prompt}
          taskId={taskId}
          status={status}
          transcript={transcript ? [...transcript] : undefined}
          activityLines={activityLines}
          detailStats={detailStats}
          isTranscriptLoading={isTranscriptLoading}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}
