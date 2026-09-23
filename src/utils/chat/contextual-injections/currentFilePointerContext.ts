import type { InjectedContextPart } from '../../../types/chat'
import { isImageTFile } from '../../llm/image'

import type { CurrentFilePointerInjection } from './types'

/**
 * Render the Sidebar Chat "current file pointer". Pointer-only by design —
 * file content is NOT inlined; the agent uses read_file when it needs more.
 * An image file is attached as vision content, kept by path until the request
 * is built.
 */
export function renderCurrentFilePointerInjection(
  injection: CurrentFilePointerInjection,
): InjectedContextPart[] {
  const { file, viewState } = injection

  if (isImageTFile(file)) {
    const pointerLines = [
      '# Current Context (auto-attached image)',
      'The user is currently viewing this image file.',
      '',
      `File: ${file.path}`,
    ]
    return [
      { type: 'image', path: file.path },
      { type: 'text', text: `${pointerLines.join('\n')}\n\n` },
    ]
  }

  const lines: string[] = []

  if (!viewState || viewState.kind === 'other') {
    lines.push(
      '# Current Context (auto-attached, content NOT included)',
      'The user is currently viewing this file. Use an available file-reading tool if you need its content.',
      '',
      `File: ${file.path}`,
    )
    if (viewState?.totalLines !== undefined) {
      lines.push(`Total: ${viewState.totalLines} lines`)
    }
  } else if (viewState.kind === 'markdown-edit') {
    lines.push(
      '# Current Context (auto-attached, content NOT included)',
      'The user is currently viewing this file. Use an available file-reading tool if you need its content.',
      '',
      `File: ${file.path}`,
      `Total: ${viewState.totalLines} lines`,
      `Visible: lines ${viewState.visibleStartLine}-${viewState.visibleEndLine}`,
      `Cursor: line ${viewState.cursorLine}`,
    )
  } else {
    // pdf
    lines.push(
      '# Current Context (auto-attached, content NOT included)',
      'The user is currently viewing this PDF. Use an available file-reading tool if you need its content.',
      '',
      `File: ${file.path}`,
      `Total: ${viewState.totalPages} pages`,
      `Currently on: page ${viewState.currentPage}`,
    )
  }

  return [{ type: 'text', text: `${lines.join('\n')}\n\n` }]
}
