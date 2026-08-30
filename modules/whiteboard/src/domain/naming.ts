// Pure filename generation for everything the whiteboard creates in the
// vault: the `.yoloboard` files themselves (command + folder context menu,
// docs/plans/08-25-yolo-whiteboard/p1-design.md §5) and the notes a text
// card is converted into (§1.2, which puts them in `<board name> Cards/`).
// Both kinds share one conflict rule, defined here once, so the call sites
// can never drift on what "already taken" means.

const YOLOBOARD_EXTENSION = '.yoloboard'
const MARKDOWN_EXTENSION = '.md'

/** Characters no vault file name may contain, plus path separators. */
const ILLEGAL_FILE_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g

/**
 * `baseName` is the locale's "Whiteboard" word (no extension, no path).
 * `existingNames` is the set of file *names* (not paths) already present in
 * the destination folder — collision is checked purely by name, matching
 * how a human would read "already taken" in that folder. Returns a bare
 * file name (still no path prefix); the caller joins it with the
 * destination folder.
 */
export function generateBoardFileName(
  baseName: string,
  existingNames: ReadonlySet<string>,
): string {
  return generateUniqueFileName(baseName, YOLOBOARD_EXTENSION, existingNames)
}

/**
 * File name for the note a text card becomes. `baseName` comes from
 * `cardNoteContent` below; the same numeric-suffix conflict rule as
 * whiteboards applies.
 */
export function generateCardNoteFileName(
  baseName: string,
  existingNames: ReadonlySet<string>,
): string {
  return generateUniqueFileName(baseName, MARKDOWN_EXTENSION, existingNames)
}

/** What a text card becomes when it is converted into a note: the file's
 * name, and the text written into it. */
export type CardNoteContent = Readonly<{ baseName: string; body: string }>

/**
 * Splits a card's markdown into the note name it implies and the body that
 * remains: its leading markdown heading becomes the file name, or `fallback`
 * when the card does not open with one.
 *
 * Only a real heading counts — a card whose first line is ordinary prose
 * would otherwise turn a whole sentence into a file name.
 *
 * The heading line is *removed* from the body when it is what named the
 * file, because a note card displays its file name as the card's title
 * (ui/canvas.ts's mountCard): leaving the heading in would show the same
 * words twice, once as chrome and once as text. Exactly the line that became
 * the name is dropped, together with the blank lines it was followed by — a
 * heading that did not name anything (it sanitized away to nothing, so
 * `fallback` was used) stays where the user put it.
 *
 * Name and body are derived together, in one function, so the two can never
 * disagree about which line was consumed.
 */
export function cardNoteContent(
  markdown: string,
  fallback: string,
): CardNoteContent {
  const newlineIndex = markdown.search(/\r?\n/)
  const firstLine =
    newlineIndex === -1 ? markdown : markdown.slice(0, newlineIndex)
  const heading = /^#{1,6}\s+(.+)$/.exec(firstLine.trim())
  const sanitized = heading ? sanitizeFileName(heading[1]) : ''
  if (!sanitized) return { baseName: fallback, body: markdown }
  const rest = newlineIndex === -1 ? '' : markdown.slice(newlineIndex)
  return { baseName: sanitized, body: rest.replace(/^(\r?\n)+/, '') }
}

function sanitizeFileName(value: string): string {
  return (
    value
      .replace(ILLEGAL_FILE_NAME_CHARS, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      // A leading dot hides the file; a trailing dot is rejected outright on
      // Windows. Both are easy to type at the end of a heading.
      .replace(/^\.+/, '')
      .replace(/\.+$/, '')
      .trim()
  )
}

function generateUniqueFileName(
  baseName: string,
  extension: string,
  existingNames: ReadonlySet<string>,
): string {
  const plain = `${baseName}${extension}`
  if (!existingNames.has(plain)) return plain

  let suffix = 1
  let candidate = `${baseName} ${suffix}${extension}`
  while (existingNames.has(candidate)) {
    suffix += 1
    candidate = `${baseName} ${suffix}${extension}`
  }
  return candidate
}
