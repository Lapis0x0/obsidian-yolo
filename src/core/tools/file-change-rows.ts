import type {
  EditDiffRow,
  EditDiffRows,
  FileChangeRows,
} from '../../types/tool-call.types'
import {
  type AlignedDiffLine,
  createInlineDiffLines,
} from '../../utils/chat/diff'

// The shared builders of the file-change contract (`FileChangeRows`,
// `types/tool-call.types.ts`). Folding and truncation happen here, when the
// rows are *built*, not when they are drawn: `createInlineDiffLines` emits
// every unchanged line, so rows built without folding would carry the whole
// file into whatever persists them (a CLI call's `request.metadata`). The
// card only draws what it is handed.
//
// Budget allocation across files: each file gets its own budget. A call that
// touches several files builds one `FileChangeRows` per file with the same
// per-file limits a single-file call has, so no file's diff depends on which
// other files happened to share its call, and the multi-file list expands one
// file at a time by default — the render cost of what is on screen stays that
// of a single file.

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

const lineText = (line: AlignedDiffLine): string =>
  line.tokens.map((token) => token.text).join('')

const isChanged = (line: AlignedDiffLine): boolean => line.type !== 'unchanged'

/**
 * Turns `createInlineDiffLines`' flat line list into the rows the card
 * renders: line numbers assigned, far-away unchanged lines collapsed into
 * gap rows, and the whole thing cut off past `maxChangedLines`.
 */
export const buildEditDiffRows = ({
  lines,
  contextLines = EDIT_DIFF_CONTEXT_LINES,
  maxChangedLines = EDIT_DIFF_MAX_CHANGED_LINES,
}: {
  lines: AlignedDiffLine[]
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
 * The "new content only" render (`completeness: 'afterOnly'`): every
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
  const lines = splitLines(text)
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

// A trailing newline terminates the last line; it does not open an empty
// one. Without this every newline-terminated file ends in a phantom blank
// row (and a create reads as one line longer than its `+N`).
const splitLines = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.slice(0, -1) : lines
}

/** One file's diff from its full before/after texts. */
export const buildFileChangeRowsFromTexts = (
  path: string,
  beforeText: string,
  afterText: string,
): FileChangeRows => ({
  path,
  completeness: 'diff',
  ...buildEditDiffRows({
    lines: createInlineDiffLines(splitLines(beforeText), splitLines(afterText)),
  }),
})

/** One file's written content alone, for when the before-text is unobtainable. */
export const buildFileChangeRowsFromContent = (
  path: string,
  afterText: string,
): FileChangeRows => ({
  path,
  completeness: 'afterOnly',
  ...buildEditContentRows({ text: afterText }),
})
