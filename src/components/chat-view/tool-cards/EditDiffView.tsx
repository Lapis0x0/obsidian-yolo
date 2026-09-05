import cx from 'clsx'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type { EditDiffSource } from '../../../core/tools/file-editing-diff'
import { createInlineDiffLines } from '../../../utils/chat/diff'

import {
  type EditDiffChange,
  buildEditContentRows,
  buildEditDiffRows,
} from './editDiffRows'

const CHANGE_SIGN: Record<EditDiffChange, string> = {
  added: '+',
  removed: '-',
  modified: '~',
  unchanged: ' ',
}

/**
 * The expanded body of a file-editing tool card: the file's path, then the
 * diff of what the call changed.
 *
 * Pure React — no `document` / `window` access at all, which is also what
 * keeps it correct in an Obsidian popout (AGENTS.md "Popout / Multi-window":
 * anything that did reach for the DOM would have to go through
 * `utils/dom/window-context.ts` to avoid the main window's globals).
 */
export function EditDiffView({ source }: { source: EditDiffSource }) {
  const { t } = useLanguage()

  const { rows, hiddenTrailingLines } = useMemo(() => {
    if (source.kind === 'afterOnly') {
      return buildEditContentRows({ text: source.afterText })
    }
    return buildEditDiffRows({
      lines: createInlineDiffLines(
        source.beforeText === '' ? [] : source.beforeText.split('\n'),
        source.afterText === '' ? [] : source.afterText.split('\n'),
      ),
    })
  }, [source])

  return (
    <div className="yolo-edit-diff">
      <div className="yolo-edit-diff-path" title={source.path}>
        {source.path}
      </div>
      {source.kind === 'afterOnly' && (
        <div className="yolo-edit-diff-notice">
          {t(
            'chat.toolCall.editDiff.originalUnavailable',
            '改前内容在本设备不可用，以下只是本次写入的新内容。',
          )}
        </div>
      )}
      <div className="yolo-edit-diff-body">
        {rows.map((row, index) =>
          row.type === 'gap' ? (
            <div className="yolo-edit-diff-gap" key={`gap-${index}`}>
              {t(
                'chat.toolCall.editDiff.collapsedLines',
                '⋯ 省略 {{count}} 行',
              ).replace('{{count}}', String(row.hiddenLines))}
            </div>
          ) : (
            <div
              className={cx(
                'yolo-edit-diff-row',
                `yolo-edit-diff-row--${row.change}`,
              )}
              key={`line-${index}`}
            >
              <span className="yolo-edit-diff-gutter" aria-hidden="true">
                {row.newLineNumber ?? row.oldLineNumber ?? ''}
              </span>
              <span className="yolo-edit-diff-sign" aria-hidden="true">
                {CHANGE_SIGN[row.change]}
              </span>
              <span className="yolo-edit-diff-text">{row.text}</span>
            </div>
          ),
        )}
      </div>
      {hiddenTrailingLines > 0 && (
        <div className="yolo-edit-diff-footer">
          {t(
            'chat.toolCall.editDiff.truncatedLines',
            '还有 {{count}} 行未显示',
          ).replace('{{count}}', String(hiddenTrailingLines))}
        </div>
      )}
    </div>
  )
}
