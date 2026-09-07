// Reading the vault text behind a board's note cards — the one I/O step
// every model-facing view of a board needs, kept apart from the pure
// assembly that consumes it (`domain/summary.ts`, `domain/cardContext.ts`).

import type { Board } from '../domain/fileFormat'
import { previewablePaths } from '../domain/summary'

/**
 * How much of a note card's backing file is read before it is clipped to a
 * preview. Generous next to the ~50 characters that survive, because what
 * gets dropped first is frontmatter and blank lines, and a note whose first
 * kilobyte is all frontmatter should still show a sentence.
 */
export const NOTE_PREVIEW_SOURCE_CHARS = 2000

/** The note minus its frontmatter, which is metadata rather than what the
 * card is about. */
export function noteBody(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return match ? markdown.slice(match[0].length) : markdown
}

/** Every note card's leading text, clipped — what a board summary previews
 * cards from. */
export async function readNotePreviews(
  host: YoloModuleHostApiV1,
  board: Board,
): Promise<Map<string, string>> {
  const previews = new Map<string, string>()
  for (const notePath of previewablePaths(board)) {
    try {
      const text = await host.vault.readText(notePath)
      previews.set(notePath, noteBody(text).slice(0, NOTE_PREVIEW_SOURCE_CHARS))
    } catch {
      // A card pointing at a file that is gone is a real state a board can be
      // in, and the summary already says which path it points at. Leaving the
      // preview out says "unresolved" without turning one broken reference
      // into a failed read of the whole board.
    }
  }
  return previews
}

/** One note card's whole text, or null when it cannot be read. */
export async function readNoteBody(
  host: YoloModuleHostApiV1,
  notePath: string,
): Promise<string | null> {
  try {
    return noteBody(await host.vault.readText(notePath))
  } catch {
    return null
  }
}
