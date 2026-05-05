import type { App } from 'obsidian'

import type { SmartComposerSettings } from '../../../settings/schema/setting.types'
import type { RequestMessage } from '../../../types/llm/request'
import { isImageTFile, tFileToImageDataUrl } from '../../llm/image'

import type { CurrentFilePointerInjection } from './types'

export type CurrentFilePointerRenderContext = {
  app: App
  settings: SmartComposerSettings
}

/**
 * Render the Sidebar Chat "current file pointer". Pointer-only by design —
 * file content is NOT inlined; the agent uses read_file when it needs more.
 * Image files are attached as vision content alongside a pointer text part.
 */
export async function renderCurrentFilePointerInjection(
  injection: CurrentFilePointerInjection,
  ctx: CurrentFilePointerRenderContext,
): Promise<RequestMessage> {
  const { file, viewState } = injection

  if (isImageTFile(file)) {
    const pointerLines = [
      '# Current Context (auto-attached image)',
      'The user is currently viewing this image file.',
      '',
      `File: ${file.path}`,
    ]
    const pointerText = `${pointerLines.join('\n')}\n\n`
    try {
      const dataUrl = await tFileToImageDataUrl(ctx.app, file, {
        cache: { enabled: true, settings: ctx.settings },
      })
      return {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: pointerText },
        ],
      }
    } catch (error) {
      // Graceful degradation: if image can't be read, send pointer only
      console.warn(
        '[YOLO] Failed to read current file image, falling back to pointer',
        file.path,
        error,
      )
      return {
        role: 'user',
        content: pointerText,
      }
    }
  }

  const lines: string[] = []

  if (!viewState || viewState.kind === 'other') {
    lines.push(
      '# Current Context (auto-attached, content NOT included)',
      'The user is currently viewing this file. Use read_file if you need its content.',
      '',
      `File: ${file.path}`,
    )
    if (viewState?.totalLines !== undefined) {
      lines.push(`Total: ${viewState.totalLines} lines`)
    }
  } else if (viewState.kind === 'markdown-edit') {
    lines.push(
      '# Current Context (auto-attached, content NOT included)',
      'The user is currently viewing this file. Use read_file if you need its content.',
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
      'The user is currently viewing this PDF. Use read_file if you need its content.',
      '',
      `File: ${file.path}`,
      `Total: ${viewState.totalPages} pages`,
      `Currently on: page ${viewState.currentPage}`,
    )
  }

  return {
    role: 'user',
    content: `${lines.join('\n')}\n\n`,
  }
}
