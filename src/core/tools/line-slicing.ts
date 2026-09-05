// Line-window slicing for text tool results.
//
// Lifted out of `fs_read/schema-helpers.ts` when `read_file` (the native
// `native_files` capability, docs/plans/09-05-yolo-max/p1-design.md §3)
// became a second consumer: two tools that hand the model a windowed view of
// a text file must produce the *same* window — same 1-based numbering, same
// `N|line` prefix, same "is there more below" bookkeeping — or the model
// learns two different reading protocols for the same job. Lives here rather
// than in either tool's directory per this package's rule (see
// `tool-args.ts`'s header): a helper moves into a tool's own directory only
// while that tool is its only consumer.

export type LineSliceRange =
  | { type: 'full' }
  | {
      type: 'lines'
      startLine: number
      endLine?: number
      maxLines?: number
    }

export type LineSliceResult = {
  /** Line-numbered text (`<n>|<line>`) — what the model sees. */
  outputContent: string
  /** The same selection without line numbers, for post-processing. */
  rawSelected: string
  totalLines: number
  returnedStartLine: number | null
  returnedEndLine: number | null
  hasMoreBelow: boolean
  nextStartLine: number | null
}

/**
 * Window size used when a targeted read gives `startLine` but neither
 * `endLine` nor `maxLines`. Deliberately small: the point of an open-ended
 * targeted read is a cheap peek that also reports `totalLines`, so the model
 * can then ask for the range it actually wants.
 */
export const DEFAULT_READ_MAX_LINES = 50

export const sliceLines = (
  lines: string[],
  range: LineSliceRange,
): LineSliceResult => {
  const totalLines = lines.length
  if (range.type === 'full') {
    const outputContent = lines
      .map((line, index) => `${index + 1}|${line}`)
      .join('\n')
    return {
      outputContent,
      rawSelected: lines.join('\n'),
      totalLines,
      returnedStartLine: totalLines > 0 ? 1 : null,
      returnedEndLine: totalLines > 0 ? totalLines : null,
      hasMoreBelow: false,
      nextStartLine: null,
    }
  }

  const startIndex = Math.min(Math.max(range.startLine - 1, 0), totalLines)
  const endExclusive = Math.min(
    totalLines,
    range.endLine ?? startIndex + (range.maxLines ?? DEFAULT_READ_MAX_LINES),
  )
  const selectedLines = lines.slice(startIndex, endExclusive)
  const outputContent = selectedLines
    .map((line, index) => `${startIndex + index + 1}|${line}`)
    .join('\n')
  const returnedCount = selectedLines.length
  const hasMoreBelow = endExclusive < totalLines
  return {
    outputContent,
    rawSelected: selectedLines.join('\n'),
    totalLines,
    returnedStartLine: returnedCount > 0 ? startIndex + 1 : null,
    returnedEndLine: returnedCount > 0 ? startIndex + returnedCount : null,
    hasMoreBelow,
    nextStartLine: hasMoreBelow ? endExclusive + 1 : null,
  }
}
