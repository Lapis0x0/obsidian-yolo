/**
 * Render the passive `<browser_context>` injection.
 *
 * Mirrors how `<ide_selection>` / `<editor-snapshot>` work for vault notes:
 * when the user's active leaf is a supported webview (core Web Viewer or
 * .url WebView Opener) and they send a chat message, the model is told the
 * page's URL/title and scroll position — without the model having to call
 * fs_read.
 *
 * Body is constructed at render time so the URL/title/metadata reflect the
 * webview's state at request build time, not at chat-input submit time.
 */

import {
  findActiveWebviewHandle,
  readActiveWebviewSnapshot,
} from '../../../core/browser/activeWebviewProbe'
import type { RequestMessage } from '../../../types/llm/request'

import type { BrowserContextInjection } from './types'

const escapeXml = (raw: string): string =>
  raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function renderBrowserContextInjection(
  injection: BrowserContextInjection,
): Promise<RequestMessage | null> {
  const handle = findActiveWebviewHandle(injection.app)
  if (!handle) return null

  const snapshot = await readActiveWebviewSnapshot(handle, {
    maxSelectionChars: 0,
  })
  if (!snapshot) return null

  const lines: string[] = ['<browser_context>', '  <active_page>']
  lines.push(`    <page_id>${escapeXml(snapshot.pageId)}</page_id>`)
  lines.push(`    <url>${escapeXml(snapshot.url)}</url>`)
  lines.push(`    <title>${escapeXml(snapshot.title)}</title>`)
  if (snapshot.meta) {
    lines.push(
      `    <document_height_px>${snapshot.meta.documentHeight}</document_height_px>`,
    )
    lines.push(
      `    <viewport_height_px>${snapshot.meta.viewportHeight}</viewport_height_px>`,
    )
    lines.push(`    <scroll_y_px>${snapshot.meta.scrollY}</scroll_y_px>`)
  }
  lines.push('  </active_page>')
  lines.push('</browser_context>')

  return {
    role: 'user',
    content: lines.join('\n'),
  }
}
