import type { EditorView } from '@codemirror/view'

import type { YoloSettings } from '../../../settings/schema/setting.types'

import { QUICK_ASK_CURSOR_MARKER } from './quickAsk.types'

const DEFAULT_QUICK_ASK_CONTEXT_BEFORE_CHARS = 5000
const DEFAULT_QUICK_ASK_CONTEXT_AFTER_CHARS = 2000

/**
 * The text around the cursor Quick Ask opens on, with the cursor marked.
 *
 * Every surface that opens a panel captures the same window of text, sized by
 * the same settings — what differs between them is the document, not how much
 * of it the model is shown.
 */
export function buildQuickAskContextText(
  view: EditorView,
  pos: number,
  settings: YoloSettings,
): string {
  const continuationOptions = settings.continuationOptions
  const beforeChars = Math.max(
    0,
    continuationOptions?.quickAskContextBeforeChars ??
      DEFAULT_QUICK_ASK_CONTEXT_BEFORE_CHARS,
  )
  const afterChars = Math.max(
    0,
    continuationOptions?.quickAskContextAfterChars ??
      DEFAULT_QUICK_ASK_CONTEXT_AFTER_CHARS,
  )
  const doc = view.state.doc
  const before = doc.sliceString(Math.max(0, pos - beforeChars), pos)
  const after = doc.sliceString(pos, Math.min(doc.length, pos + afterChars))
  return before.length > 0 || after.length > 0
    ? `${before}${QUICK_ASK_CURSOR_MARKER}${after}`
    : ''
}
