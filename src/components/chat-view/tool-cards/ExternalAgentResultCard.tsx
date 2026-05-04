// 异步派遣完成后的结果卡片
// 显示：标题 · provider · 状态徽章 + 展开/折叠输出
import cx from 'clsx'
import { Check, Clock, Link, Loader2, X } from 'lucide-react'
import { useRef } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type {
  AsyncTaskStatus,
  ChatExternalAgentResultMessage,
} from '../../../types/chat'

type ExternalAgentResultCardProps = {
  message: ChatExternalAgentResultMessage
  /** 点击链接图标时聚焦到原派遣消息 */
  onFocusDelegateMessage?: (messageId: string) => void
}

export function ExternalAgentResultCard({
  message,
  onFocusDelegateMessage,
}: ExternalAgentResultCardProps) {
  const { t } = useLanguage()
  const detailsRef = useRef<HTMLDetailsElement>(null)

  const durationSec = Math.round(message.durationMs / 1000)

  return (
    <div className="yolo-external-agent-result-card">
      <div className="yolo-external-agent-result-card__header">
        <StatusBadge status={message.status} t={t} />
        <span className="yolo-external-agent-result-card__title">
          {message.title}
        </span>
        <span className="yolo-external-agent-result-card__meta">
          {message.provider}
        </span>
        <span className="yolo-external-agent-result-card__meta">
          <Clock size={11} />
          {durationSec}s
        </span>
        {onFocusDelegateMessage && (
          <button
            type="button"
            className="yolo-external-agent-result-card__link-btn"
            title={t(
              'chat.externalAgentResult.jumpToDelegate',
              'Jump to original delegate message',
            )}
            onClick={() =>
              void onFocusDelegateMessage(message.delegateAssistantMessageId)
            }
          >
            <Link size={12} />
          </button>
        )}
      </div>

      {(message.stdout || message.stderr) && (
        <details
          ref={detailsRef}
          className="yolo-external-agent-result-card__details"
        >
          <summary className="yolo-external-agent-result-card__summary">
            {t('chat.externalAgentResult.showOutput', 'Show output')}
          </summary>
          {message.stdout && (
            <div className="yolo-external-agent-result-card__section">
              <div className="yolo-external-agent-result-card__section-label">
                {t('chat.externalAgent.output', 'Output')}
              </div>
              <pre className="yolo-external-agent-result-card__console">
                {message.stdout}
              </pre>
            </div>
          )}
          {message.stderr && (
            <div className="yolo-external-agent-result-card__section">
              <div className="yolo-external-agent-result-card__section-label">
                {t('chat.externalAgent.progress', 'Progress')}
              </div>
              <pre className="yolo-external-agent-result-card__console yolo-external-agent-result-card__console--progress">
                {message.stderr}
              </pre>
            </div>
          )}
        </details>
      )}
    </div>
  )
}

function StatusBadge({
  status,
  t,
}: {
  status: AsyncTaskStatus
  t: (key: string, fallback?: string) => string
}) {
  switch (status) {
    case 'completed':
      return (
        <span
          className={cx(
            'yolo-external-agent-result-card__badge',
            'yolo-external-agent-result-card__badge--completed',
          )}
        >
          <Check size={11} />
          {t('chat.externalAgentResult.statusCompleted', 'Completed')}
        </span>
      )
    case 'failed':
      return (
        <span
          className={cx(
            'yolo-external-agent-result-card__badge',
            'yolo-external-agent-result-card__badge--failed',
          )}
        >
          <X size={11} />
          {t('chat.externalAgentResult.statusFailed', 'Failed')}
        </span>
      )
    case 'cancelled':
      return (
        <span
          className={cx(
            'yolo-external-agent-result-card__badge',
            'yolo-external-agent-result-card__badge--cancelled',
          )}
        >
          <X size={11} />
          {t('chat.externalAgentResult.statusCancelled', 'Cancelled')}
        </span>
      )
    case 'timed_out':
      return (
        <span
          className={cx(
            'yolo-external-agent-result-card__badge',
            'yolo-external-agent-result-card__badge--failed',
          )}
        >
          <Clock size={11} />
          {t('chat.externalAgentResult.statusTimedOut', 'Timed out')}
        </span>
      )
    case 'killed_by_shutdown':
      return (
        <span
          className={cx(
            'yolo-external-agent-result-card__badge',
            'yolo-external-agent-result-card__badge--cancelled',
          )}
        >
          <Loader2 size={11} />
          {t('chat.externalAgentResult.statusKilledByShutdown', 'Stopped')}
        </span>
      )
  }
}
