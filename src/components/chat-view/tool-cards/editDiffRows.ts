import type { InlineDiffLine } from '../../../utils/chat/diff'

/**
 * How many unchanged lines stay visible on each side of a changed run.
 * Everything further away collapses into a single `gap` row.
 */
export const EDIT_DIFF_CONTEXT_LINES = 3

/**
 * How many *changed* lines one card renders before it stops. The cap counts
 * changed lines rather than total rows because the context lines around them
 * are already bounded by `EDIT_DIFF_CONTEXT_LINES`; a whole-file rewrite is
 * what actually threatens the render, and it is all changed lines.
 */
export const EDIT_DIFF_MAX_CHANGED_LINES = 300

/**
 * How many lines a plain "new content only" render shows — the same budget,
 * applied to every line, since none of them is a diff line.
 */
export const EDIT_DIFF_MAX_PLAIN_LINES = EDIT_DIFF_MAX_CHANGED_LINES

export type EditDiffChange = 'unchanged' | 'added' | 'removed' | 'modified'

export type EditDiffRow =
  | {
      type: 'line'
      change: EditDiffChange
      /** 1-based line number in the pre-edit text; absent for added lines. */
      oldLineNumber?: number
      /** 1-based line number in the post-edit text; absent for removed lines. */
      newLineNumber?: number
      text: string
    }
  | { type: 'gap'; hiddenLines: number }

export type EditDiffRows = {
  rows: EditDiffRow[]
  /**
   * Lines dropped by the cap, reported under the rendered rows. 0 when
   * nothing was cut.
   */
  hiddenTrailingLines: number
}

const lineText = (line: InlineDiffLine): string =>
  line.tokens.map((token) => token.text).join('')

const isChanged = (line: InlineDiffLine): boolean => line.type !== 'unchanged'

/**
 * Turns `createInlineDiffLines`' flat line list into the rows the card
 * renders: line numbers assigned, far-away unchanged lines collapsed into
 * gap rows, and the whole thing cut off past `maxChangedLines`.
 *
 * Split out of `EditDiffView.tsx` as a pure function so it is testable in
 * this repo's DOM-free Jest environment (same reasoning as
 * `ChatModeSelect.ts`'s exported helpers).
 */
export const buildEditDiffRows = ({
  lines,
  contextLines = EDIT_DIFF_CONTEXT_LINES,
  maxChangedLines = EDIT_DIFF_MAX_CHANGED_LINES,
}: {
  lines: InlineDiffLine[]
  contextLines?: number
  maxChangedLines?: number
}): EditDiffRows => {
  // Cut first, collapse second: the cut always lands on a changed line, so
  // the retained slice never ends with trailing context that would then need
  // collapsing of its own.
  let changedSeen = 0
  let cutIndex = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    if (!isChanged(lines[index])) continue
    changedSeen += 1
    if (changedSeen === maxChangedLines) {
      cutIndex = index + 1
      break
    }
  }
  const visible = lines.slice(0, cutIndex)
  const hiddenTrailingLines = lines.length - cutIndex

  // Kept = within `contextLines` of a changed line, itself included. Marked
  // by expanding outward from each changed line (O(n · contextLines)) rather
  // than by scanning the whole list per index — a one-line edit in a large
  // file leaves every one of its lines in `visible`.
  const keep = new Array<boolean>(visible.length).fill(false)
  for (let index = 0; index < visible.length; index += 1) {
    if (!isChanged(visible[index])) continue
    const from = Math.max(0, index - contextLines)
    const to = Math.min(visible.length - 1, index + contextLines)
    for (let near = from; near <= to; near += 1) {
      keep[near] = true
    }
  }

  const rows: EditDiffRow[] = []
  let oldLineNumber = 1
  let newLineNumber = 1
  let pendingGap = 0

  const flushGap = () => {
    if (pendingGap === 0) return
    rows.push({ type: 'gap', hiddenLines: pendingGap })
    pendingGap = 0
  }

  visible.forEach((line, index) => {
    const consumesOld = line.type !== 'added'
    const consumesNew = line.type !== 'removed'
    const currentOld = oldLineNumber
    const currentNew = newLineNumber
    if (consumesOld) oldLineNumber += 1
    if (consumesNew) newLineNumber += 1

    if (!keep[index]) {
      pendingGap += 1
      return
    }

    flushGap()
    rows.push({
      type: 'line',
      change: line.type,
      oldLineNumber: consumesOld ? currentOld : undefined,
      newLineNumber: consumesNew ? currentNew : undefined,
      text: lineText(line),
    })
  })
  flushGap()

  return { rows, hiddenTrailingLines }
}

/**
 * The "new content only" render (`EditDiffSource` kind `afterOnly`): every
 * line shown as-is with its new-file line number, capped the same way. No
 * collapsing — with no changed lines to anchor context around, collapsing
 * would hide the entire content.
 */
export const buildEditContentRows = ({
  text,
  maxLines = EDIT_DIFF_MAX_PLAIN_LINES,
}: {
  text: string
  maxLines?: number
}): EditDiffRows => {
  const lines = text.split('\n')
  const rows: EditDiffRow[] = lines.slice(0, maxLines).map((line, index) => ({
    type: 'line' as const,
    change: 'unchanged' as const,
    newLineNumber: index + 1,
    text: line,
  }))

  return {
    rows,
    hiddenTrailingLines: Math.max(0, lines.length - maxLines),
  }
}
