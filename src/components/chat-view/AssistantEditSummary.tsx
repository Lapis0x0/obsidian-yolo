import { Loader2, Undo2 } from 'lucide-react'
import { memo } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type {
  GroupEditSummary,
  GroupEditSummaryPathItem,
} from '../../utils/chat/editSummary'

const formatDelta = (value: number, sign: '+' | '-') => {
  return `${sign}${value}`
}

const AssistantEditSummary = memo(function AssistantEditSummary({
  summary,
  undoingTargetKey,
  onUndo,
  onUndoFile,
  onOpenFile,
}: {
  summary: GroupEditSummary
  undoingTargetKey: string | null
  onUndo: () => void
  onUndoFile: (path: string) => void
  onOpenFile: (file: GroupEditSummaryPathItem) => void
}) {
  const { t } = useLanguage()
  const undoDisabled =
    undoingTargetKey !== null && undoingTargetKey !== 'all'
      ? true
      : !summary.hasUndoableFiles
  const isUndoingAll = undoingTargetKey === 'all'

  return (
    <div className="smtcmp-agent-edit-summary">
      <div className="smtcmp-agent-edit-summary-header">
        <div className="smtcmp-agent-edit-summary-totals">
          <span>
            {t(
              'chat.editSummary.filesChanged',
              '{count} file(s) changed',
            ).replace('{count}', String(summary.totalFiles))}
          </span>
          <span className="smtcmp-agent-edit-summary-added">
            {formatDelta(summary.totalAddedLines, '+')}
          </span>
          <span className="smtcmp-agent-edit-summary-removed">
            {formatDelta(summary.totalRemovedLines, '-')}
          </span>
        </div>
        <button
          type="button"
          className="smtcmp-agent-edit-summary-undo"
          onClick={undoDisabled ? undefined : onUndo}
          disabled={undoDisabled}
        >
          {isUndoingAll ? (
            <Loader2 size={14} className="smtcmp-spinner" />
          ) : (
            <Undo2 size={14} />
          )}
          <span>
            {summary.hasUndoableFiles
              ? t('chat.editSummary.undo', 'Undo')
              : t('chat.editSummary.undone', 'Undone')}
          </span>
        </button>
      </div>
      <div className="smtcmp-agent-edit-summary-list">
        {summary.files.map((file) => (
          <div key={file.path} className="smtcmp-agent-edit-summary-item">
            <button
              type="button"
              className="smtcmp-agent-edit-summary-path"
              onClick={() => onOpenFile(file)}
              title={file.path}
            >
              {file.path}
            </button>
            <span className="smtcmp-agent-edit-summary-added">
              {formatDelta(file.addedLines, '+')}
            </span>
            <span className="smtcmp-agent-edit-summary-removed">
              {formatDelta(file.removedLines, '-')}
            </span>
            <button
              type="button"
              className={`smtcmp-agent-edit-summary-undo smtcmp-agent-edit-summary-undo-icon${
                undoingTargetKey === file.path ? ' is-visible' : ''
              }`}
              onClick={
                file.undoStatus === 'available' && undoingTargetKey === null
                  ? () => onUndoFile(file.path)
                  : undefined
              }
              disabled={
                file.undoStatus !== 'available' || undoingTargetKey !== null
              }
              aria-label={t('chat.editSummary.undoFile', 'Undo file change')}
            >
              {undoingTargetKey === file.path ? (
                <Loader2 size={14} className="smtcmp-spinner" />
              ) : (
                <Undo2 size={14} />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
})

export default AssistantEditSummary
