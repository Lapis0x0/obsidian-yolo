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
  const doc = view.state.doc
  return buildContextText(
    (from, to) => doc.sliceString(from, to),
    doc.length,
    pos,
    settings,
  )
}

/** `buildQuickAskContextText` for a document held as a plain string. */
export function buildQuickAskContextTextFromSource(
  source: string,
  pos: number,
  settings: YoloSettings,
): string {
  return buildContextText(
    (from, to) => source.slice(from, to),
    source.length,
    pos,
    settings,
  )
}

function buildContextText(
  slice: (from: number, to: number) => string,
  length: number,
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
  const before = slice(Math.max(0, pos - beforeChars), pos)
  const after = slice(pos, Math.min(length, pos + afterChars))
  return before.length > 0 || after.length > 0
    ? `${before}${QUICK_ASK_CURSOR_MARKER}${after}`
    : ''
}
