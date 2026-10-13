// What a card's text loses on leaving the editor: the blank lines Markdown
// never shows.
//
// A card is read in Obsidian's preview and written in its editor, and the two
// disagree about blank lines. The preview follows Markdown — any number of
// blank lines between two blocks is one break — while the editor shows every
// source line. Text pasted from elsewhere often arrives with runs of them, or
// with lines holding nothing but spaces (`\n\n  \n\n`), so the same card is a
// line or three taller per paragraph the moment it is clicked into. Folding
// each run into the one blank line that is all the preview ever drew makes the
// two agree without changing a pixel of what the card reads as.
//
// Only on leaving the editor, never while typing: a blank line typed a moment
// ago is where the next paragraph is about to go.

/**
 * The fence a trimmed line opens or closes a code block with, or null.
 *
 * Shared with `ui/lod.ts`'s reading-window snap, which has to agree with this
 * file about where a code block is: inside one, a blank line is content.
 */
export function fenceMarker(trimmed: string): '```' | '~~~' | null {
  if (trimmed.startsWith('```')) return '```'
  if (trimmed.startsWith('~~~')) return '~~~'
  return null
}

export type CollapsedBlankLines = Readonly<{
  markdown: string
  /**
   * Where a line of the original text is in the collapsed one. Takes the
   * fractional source line an editor's scroll position is read in; a blank
   * line that was folded away lands on the one its run became.
   */
  mapLine: (line: number) => number
}>

/**
 * Folds every run of blank lines — empty, or only whitespace — into a single
 * empty line, and drops those at the start and the end. Lines inside a fenced
 * code block are left exactly as they are.
 */
export function collapseBlankLines(markdown: string): CollapsedBlankLines {
  const lines = markdown.split('\n')
  const kept: string[] = []
  // Index into `kept` of each original line — of the line itself, or of the
  // blank line it was folded into.
  const target: number[] = []
  let openFence: string | null = null
  let pendingBlank = false
  for (const line of lines) {
    const trimmed = line.trim()
    const fence = fenceMarker(trimmed)
    if (openFence !== null) {
      // Only the marker that opened this block can close it: a `~~~` inside a
      // ``` block is content, not a fence.
      if (fence === openFence) openFence = null
      target.push(kept.length)
      kept.push(line)
      continue
    }
    if (trimmed === '') {
      // Held rather than written: a run ending the text writes nothing, and a
      // run ending at the next block writes one line however long it was.
      pendingBlank = kept.length > 0
      target.push(kept.length)
      continue
    }
    if (pendingBlank) {
      kept.push('')
      pendingBlank = false
    }
    openFence = fence
    target.push(kept.length)
    kept.push(line)
  }
  // A blank run before the first block already targets that block — it was
  // `kept.length` when the block was written. One after the last block targets
  // past the end, which the clamp puts back on the last line.
  const last = Math.max(kept.length - 1, 0)
  return {
    markdown: kept.join('\n'),
    mapLine: (line) => {
      if (!(line > 0)) return 0
      const whole = Math.floor(line)
      if (whole >= lines.length) return last
      return Math.min(target[whole] + (line - whole), last)
    },
  }
}
