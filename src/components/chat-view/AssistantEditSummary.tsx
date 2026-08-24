import { Loader2, Undo2 } from 'lucide-react'
import { type ReactElement, memo } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type {
  GroupEditSummary,
  GroupEditSummaryPathItem,
} from '../../utils/chat/editSummary'

const formatDelta = (value: number, sign: '+' | '-') => {
  return `${sign}${value}`
}

export const renderDeltaPair = (addedLines: number, removedLines: number) => {
  const items: Array<ReactElement> = []

  if (addedLines > 0) {
    items.push(
      <span key="added" className="yolo-agent-edit-summary-added">
        {formatDelta(addedLines, '+')}
      </span>,
    )
  }

  if (removedLines > 0) {
    items.push(
      <span key="removed" className="yolo-agent-edit-summary-removed">
        {formatDelta(removedLines, '-')}
      </span>,
    )
  }

  if (items.length > 0) {
    return items
  }

  return [
    <span key="zero" className="yolo-agent-edit-summary-neutral">
      0
    </span>,
  ]
}

const getOperationLabelKey = (
  operation: GroupEditSummaryPathItem['operation'],
) => {
  switch (operation) {
    case 'create':
      return 'chat.editSummary.operationCreate'
    case 'delete':
      return 'chat.editSummary.operationDelete'
    default:
      return null
  }
}

const AssistantEditSummary = memo(function AssistantEditSummary({
  summary,
  undoingTargetKey,
  onUndo,
  onUndoFile,
  onOpenFile,
  showUndo,
}: {
  summary: GroupEditSummary
  undoingTargetKey: string | null
  onUndo: () => void
  onUndoFile: (path: string) => void
  onOpenFile: (file: GroupEditSummaryPathItem) => void
  showUndo: boolean
}) {
  const { t } = useLanguage()
  const undoDisabled =
    undoingTargetKey !== null && undoingTargetKey !== 'all'
      ? true
      : !summary.hasUndoableFiles
  const isUndoingAll = undoingTargetKey === 'all'

  return (
    <div className="yolo-agent-edit-summary">
      <div className="yolo-agent-edit-summary-header">
        <div className="yolo-agent-edit-summary-totals">
          <span>
            {t(
              'chat.editSummary.filesChanged',
              '{count} file(s) changed',
            ).replace('{count}', String(summary.totalFiles))}
          </span>
          {summary.totalLineStatsAvailable
            ? renderDeltaPair(
                summary.totalAddedLines,
                summary.totalRemovedLines,
              )
            : null}
        </div>
        {showUndo ? (
          <button
            type="button"
            className="yolo-agent-edit-summary-undo"
            onClick={undoDisabled ? undefined : onUndo}
            disabled={undoDisabled}
          >
            {isUndoingAll ? (
              <Loader2 size={14} className="yolo-spinner" />
            ) : (
              <Undo2 size={14} />
            )}
            <span>
              {summary.hasUndoableFiles
                ? t('chat.editSummary.undo', 'Undo')
                : t('chat.editSummary.undone', 'Undone')}
            </span>
          </button>
        ) : null}
      </div>
      <div className="yolo-agent-edit-summary-list">
        {summary.files.map((file) => (
          <div key={file.path} className="yolo-agent-edit-summary-item">
            <button
              type="button"
              className="yolo-agent-edit-summary-path"
              onClick={() => onOpenFile(file)}
              title={file.path}
            >
              {getOperationLabelKey(file.operation) ? (
                <span
                  className={`yolo-agent-edit-summary-badge yolo-agent-edit-summary-badge--${file.operation}`}
                >
                  {t(
                    getOperationLabelKey(file.operation) ?? '',
                    file.operation === 'create' ? 'Created' : 'Deleted',
                  )}
                </span>
              ) : null}
              <span className="yolo-agent-edit-summary-path-text">
                {file.path}
              </span>
            </button>
            <div className="yolo-agent-edit-summary-item-trailing">
              {showUndo ? (
                <button
                  type="button"
                  className={`yolo-agent-edit-summary-undo yolo-agent-edit-summary-undo-icon${
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
                  aria-label={t(
                    'chat.editSummary.undoFile',
                    'Undo file change',
                  )}
                >
                  {undoingTargetKey === file.path ? (
                    <Loader2 size={14} className="yolo-spinner" />
                  ) : (
                    <Undo2 size={14} />
                  )}
                </button>
              ) : null}
              {file.lineStatsAvailable ? (
                <div className="yolo-agent-edit-summary-deltas">
                  {renderDeltaPair(file.addedLines, file.removedLines)}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})

export default AssistantEditSummary
