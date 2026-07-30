import {
  Asterisk,
  LoaderCircle,
  Pin,
  PinOff,
  RefreshCw,
  SquareTerminal,
  Unlink,
} from 'lucide-react'

import { useLanguage } from '../../contexts/language-context'
import {
  CLI_RUNTIME_IDS,
  type CliRuntimeId,
  type CliSessionDiscoveryResult,
  type CliSessionListItem,
  type CliSessionRef,
  getCliSessionIndexKey,
  isCliRuntimeAvailable,
} from '../../core/cli-runtime'

export type CliSessionListSectionProps = {
  discoveryResult?: CliSessionDiscoveryResult
  loading: boolean
  currentRef?: CliSessionRef
  onSelect: (ref: CliSessionRef) => void
  onTogglePinned: (ref: CliSessionRef, pinned: boolean) => void
  /**
   * Requests the confirmation flow that may forget YOLO-owned metadata.
   * The receiver must confirm before calling CliSessionService.removeOverlay.
   */
  onRequestForgetOverlay: (ref: CliSessionRef) => void
  onRetryProvider: (runtimeId: CliRuntimeId) => void
}

const getRuntimeLabelKey = (runtimeId: CliRuntimeId): string =>
  runtimeId === 'claude-code'
    ? 'sidebar.runtimeSelector.claudeCodeLabel'
    : 'sidebar.runtimeSelector.codexLabel'

const RuntimeBadge = ({ runtimeId }: { runtimeId: CliRuntimeId }) => {
  const { t } = useLanguage()

  return (
    <span
      className={`yolo-cli-session-list__runtime-badge yolo-cli-session-list__runtime-badge--${runtimeId}`}
      data-runtime-id={runtimeId}
    >
      <span className="yolo-cli-session-list__runtime-icon" aria-hidden="true">
        {runtimeId === 'claude-code' ? (
          <Asterisk size={11} strokeWidth={2.2} />
        ) : (
          <SquareTerminal size={11} strokeWidth={2.2} />
        )}
      </span>
      {t(getRuntimeLabelKey(runtimeId))}
    </span>
  )
}

const CliSessionRow = ({
  session,
  isCurrent,
  onSelect,
  onTogglePinned,
  onRequestForgetOverlay,
}: {
  session: CliSessionListItem
  isCurrent: boolean
  onSelect: (ref: CliSessionRef) => void
  onTogglePinned: (ref: CliSessionRef, pinned: boolean) => void
  onRequestForgetOverlay: (ref: CliSessionRef) => void
}) => {
  const { t } = useLanguage()
  const sessionKey = getCliSessionIndexKey(session.ref)
  const pinLabel = t(
    session.isPinned ? 'sidebar.cliSessions.unpin' : 'sidebar.cliSessions.pin',
  )

  return (
    <li
      className={`yolo-cli-session-list__item${isCurrent ? ' is-current' : ''}`}
      data-session-key={sessionKey}
    >
      <button
        type="button"
        className="yolo-cli-session-list__select"
        data-action="select"
        aria-current={isCurrent ? 'true' : undefined}
        onClick={() => onSelect(session.ref)}
      >
        <span className="yolo-cli-session-list__heading">
          <RuntimeBadge runtimeId={session.ref.runtimeId} />
          {isCurrent ? (
            <span className="yolo-cli-session-list__current-badge">
              {t('sidebar.cliSessions.current')}
            </span>
          ) : null}
        </span>
        <span className="yolo-cli-session-list__title">{session.title}</span>
        {session.preview ? (
          <span className="yolo-cli-session-list__preview">
            {session.preview}
          </span>
        ) : null}
      </button>

      <span className="yolo-cli-session-list__actions">
        <button
          type="button"
          className={`clickable-icon yolo-cli-session-list__action yolo-cli-session-list__pin${
            session.isPinned ? ' is-pinned' : ''
          }`}
          data-action="toggle-pin"
          aria-label={pinLabel}
          title={pinLabel}
          aria-pressed={session.isPinned}
          onClick={() => onTogglePinned(session.ref, !session.isPinned)}
        >
          {session.isPinned ? (
            <PinOff size={14} aria-hidden="true" />
          ) : (
            <Pin size={14} aria-hidden="true" />
          )}
        </button>
        {session.hasOverlay ? (
          <button
            type="button"
            className="clickable-icon yolo-cli-session-list__action yolo-cli-session-list__forget"
            data-action="request-forget-overlay"
            aria-label={t('sidebar.cliSessions.forgetFromYolo')}
            title={t('sidebar.cliSessions.forgetFromYolo')}
            onClick={() => onRequestForgetOverlay(session.ref)}
          >
            <Unlink size={14} aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </li>
  )
}

export function CliSessionListSection({
  discoveryResult,
  loading,
  currentRef,
  onSelect,
  onTogglePinned,
  onRequestForgetOverlay,
  onRetryProvider,
}: CliSessionListSectionProps) {
  const { t } = useLanguage()

  if (!isCliRuntimeAvailable()) {
    return null
  }

  const sessions = discoveryResult?.sessions ?? []
  const errors = discoveryResult?.errors ?? {}
  const currentKey = currentRef ? getCliSessionIndexKey(currentRef) : undefined
  const hasErrors = CLI_RUNTIME_IDS.some((runtimeId) => errors[runtimeId])

  return (
    <section
      className="yolo-cli-session-list"
      aria-label={t('sidebar.cliSessions.sectionLabel')}
      aria-busy={loading}
    >
      <div className="yolo-cli-session-list__header">
        <h3 className="yolo-cli-session-list__section-title">
          {t('sidebar.cliSessions.title')}
        </h3>
        {loading && sessions.length > 0 ? (
          <LoaderCircle
            className="yolo-cli-session-list__refresh-spinner"
            size={13}
            aria-label={t('sidebar.cliSessions.loading')}
          />
        ) : null}
      </div>

      {hasErrors ? (
        <div className="yolo-cli-session-list__errors">
          {CLI_RUNTIME_IDS.map((runtimeId) => {
            const error = errors[runtimeId]
            if (!error) return null
            const provider = t(getRuntimeLabelKey(runtimeId))

            return (
              <div
                key={runtimeId}
                className="yolo-cli-session-list__error"
                data-runtime-id={runtimeId}
                role="alert"
              >
                <span className="yolo-cli-session-list__error-copy">
                  <span className="yolo-cli-session-list__error-provider">
                    {provider}
                  </span>
                  <span className="yolo-cli-session-list__error-message">
                    {error}
                  </span>
                </span>
                <button
                  type="button"
                  className="yolo-cli-session-list__retry"
                  data-action="retry-provider"
                  data-runtime-id={runtimeId}
                  aria-label={t('sidebar.cliSessions.retryProvider').replace(
                    '{provider}',
                    provider,
                  )}
                  onClick={() => onRetryProvider(runtimeId)}
                >
                  <RefreshCw size={12} aria-hidden="true" />
                  {t('common.retry')}
                </button>
              </div>
            )
          })}
        </div>
      ) : null}

      {loading && sessions.length === 0 ? (
        <div className="yolo-cli-session-list__state" role="status">
          <LoaderCircle
            className="yolo-cli-session-list__state-spinner"
            size={16}
            aria-hidden="true"
          />
          {t('sidebar.cliSessions.loading')}
        </div>
      ) : sessions.length > 0 ? (
        <ul className="yolo-cli-session-list__items">
          {sessions.map((session) => {
            const sessionKey = getCliSessionIndexKey(session.ref)
            return (
              <CliSessionRow
                key={sessionKey}
                session={session}
                isCurrent={sessionKey === currentKey}
                onSelect={onSelect}
                onTogglePinned={onTogglePinned}
                onRequestForgetOverlay={onRequestForgetOverlay}
              />
            )
          })}
        </ul>
      ) : !hasErrors ? (
        <div className="yolo-cli-session-list__state">
          {t('sidebar.cliSessions.empty')}
        </div>
      ) : null}
    </section>
  )
}
