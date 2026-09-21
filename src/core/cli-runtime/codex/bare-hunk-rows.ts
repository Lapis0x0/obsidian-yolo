import type { EditDiffRow, EditDiffRows } from '../../../types/tool-call.types'
import { EDIT_DIFF_MAX_CHANGED_LINES } from '../../tools/file-change-rows'

// Codex reports an updated file as bare unified-diff hunks: no `---`/`+++`
// file header, only `@@ -a,b +c,d @@` headers followed by ` `/`-`/`+` lines
// (context radius 1). The header is what numbers the rows — without it a
// hunk from the middle of a file would read as starting at line 1.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

type Hunk = {
  oldStart: number
  newStart: number
  oldCount: number
  newCount: number
}

const parseHunkHeader = (line: string): Hunk | null => {
  const match = HUNK_HEADER.exec(line)
  if (!match) return null
  const oldCount = match[2] === undefined ? 1 : Number(match[2])
  const newCount = match[4] === undefined ? 1 : Number(match[4])
  // A side with count 0 names the line *after which* the hunk sits, so its
  // first line is one further on (`@@ -0,0 +1,2 @@` starts before line 1).
  return {
    oldStart: Number(match[1]) + (oldCount === 0 ? 1 : 0),
    newStart: Number(match[3]) + (newCount === 0 ? 1 : 0),
    oldCount,
    newCount,
  }
}

/**
 * Codex's bare hunks as numbered card rows. The unchanged stretch before
 * each hunk (the file's start included) becomes one `gap` row; nothing is
 * emitted after the last hunk, since the diff does not say how long the file
 * is. Each hunk's body is read by its header counts, so lines outside any
 * hunk body — `\ No newline at end of file`, Codex's `Moved to:` trailer —
 * are never taken for content. Stops after the shared changed-line budget;
 * the hunk lines left unread are reported as `hiddenTrailingLines`.
 */
export const parseBareHunkRows = (diff: string): EditDiffRows => {
  const rows: EditDiffRow[] = []
  let changedSeen = 0
  let hiddenTrailingLines = 0
  let nextOldLine = 1
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0

  for (const line of diff.split('\n')) {
    if (oldLeft === 0 && newLeft === 0) {
      const hunk = parseHunkHeader(line)
      if (!hunk) continue
      oldLeft = hunk.oldCount
      newLeft = hunk.newCount
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      if (changedSeen < EDIT_DIFF_MAX_CHANGED_LINES) {
        const hiddenLines = hunk.oldStart - nextOldLine
        if (hiddenLines > 0) rows.push({ type: 'gap', hiddenLines })
      }
      nextOldLine = hunk.oldStart + hunk.oldCount
      continue
    }

    const prefix = line[0]
    // An empty line inside a hunk body is a blank context line whose
    // leading space was stripped along the way.
    const change =
      prefix === '+'
        ? 'added'
        : prefix === '-'
          ? 'removed'
          : prefix === ' ' || line === ''
            ? 'unchanged'
            : null
    if (!change) continue

    if (change !== 'added') oldLeft -= 1
    if (change !== 'removed') newLeft -= 1

    if (changedSeen >= EDIT_DIFF_MAX_CHANGED_LINES) {
      hiddenTrailingLines += 1
      continue
    }

    rows.push({
      type: 'line',
      change,
      oldLineNumber: change === 'added' ? undefined : oldLine,
      newLineNumber: change === 'removed' ? undefined : newLine,
      text: line.slice(1),
    })
    if (change !== 'added') oldLine += 1
    if (change !== 'removed') newLine += 1
    if (change !== 'unchanged') changedSeen += 1
  }

  return { rows, hiddenTrailingLines }
}
