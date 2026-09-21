import cx from 'clsx'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type {
  EditDiffRow,
  FileChangeRows,
} from '../../../types/tool-call.types'

const CHANGE_SIGN: Record<
  Extract<EditDiffRow, { type: 'line' }>['change'],
  string
> = {
  added: '+',
  removed: '-',
  unchanged: ' ',
}

/**
 * The expanded body of a file-editing tool card: the files a call changed,
 * each drawn by {@link EditDiffView}.
 *
 * One file renders as-is. Several files render as a list of their paths with
 * only the first one open — a CLI agent that rewrites a dozen files in one
 * call would otherwise flood the chat with every diff at once.
 *
 * Pure React — no `document` / `window` access at all, which is also what
 * keeps it correct in an Obsidian popout (AGENTS.md "Popout / Multi-window").
 */
export function FileChangeList({ files }: { files: FileChangeRows[] }) {
  const [openIndexes, setOpenIndexes] = useState<ReadonlySet<number>>(
    () => new Set([0]),
  )

  if (files.length === 1) {
    return (
      <div className="yolo-edit-diff">
        <FileChangePath path={files[0].path} />
        <EditDiffView file={files[0]} />
      </div>
    )
  }

  const toggle = (index: number) => {
    setOpenIndexes((current) => {
      const next = new Set(current)
      if (!next.delete(index)) {
        next.add(index)
      }
      return next
    })
  }

  return (
    <div className="yolo-edit-diff-files">
      {files.map((file, index) => {
        const isOpen = openIndexes.has(index)
        return (
          <div className="yolo-edit-diff" key={`${index}:${file.path}`}>
            <button
              type="button"
              className="yolo-edit-diff-file-toggle"
              aria-expanded={isOpen}
              title={file.path}
              onClick={() => toggle(index)}
            >
              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="yolo-edit-diff-path">{file.path}</span>
            </button>
            {isOpen && <EditDiffView file={file} />}
          </div>
        )
      })}
    </div>
  )
}

export function FileChangePath({ path }: { path: string }) {
  return (
    <div className="yolo-edit-diff-path" title={path}>
      {path}
    </div>
  )
}

/**
 * One file's diff, drawn exactly as handed over: the rows arrive already
 * numbered, folded and truncated (`core/tools/file-change-rows.ts`), so this
 * holds no diff logic of its own.
 */
export function EditDiffView({ file }: { file: FileChangeRows }) {
  const { t } = useLanguage()

  return (
    <>
      {file.completeness === 'afterOnly' && (
        <div className="yolo-edit-diff-notice">
          {t(
            'chat.toolCall.editDiff.originalUnavailable',
            '改前内容在本设备不可用，以下只是本次写入的新内容。',
          )}
        </div>
      )}
      <div className="yolo-edit-diff-body">
        {file.rows.map((row, index) =>
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
      {file.hiddenTrailingLines > 0 && (
        <div className="yolo-edit-diff-footer">
          {t(
            'chat.toolCall.editDiff.truncatedLines',
            '还有 {{count}} 行未显示',
          ).replace('{{count}}', String(file.hiddenTrailingLines))}
        </div>
      )}
    </>
  )
}
