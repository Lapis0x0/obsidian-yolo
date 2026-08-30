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
 * `cardNoteBaseName` below; the same numeric-suffix conflict rule as
 * whiteboards applies.
 */
export function generateCardNoteFileName(
  baseName: string,
  existingNames: ReadonlySet<string>,
): string {
  return generateUniqueFileName(baseName, MARKDOWN_EXTENSION, existingNames)
}

/**
 * The note name a card's own text implies: its leading markdown heading, or
 * `fallback` when the card does not open with one.
 *
 * Only a real heading counts — a card whose first line is ordinary prose
 * would otherwise turn a whole sentence into a file name. The heading line
 * itself stays in the note body (the conversion must not silently rewrite
 * what the user wrote); this only reads it.
 */
export function cardNoteBaseName(markdown: string, fallback: string): string {
  const firstLine = markdown.split(/\r?\n/, 1)[0] ?? ''
  const heading = /^#{1,6}\s+(.+)$/.exec(firstLine.trim())
  const sanitized = heading ? sanitizeFileName(heading[1]) : ''
  return sanitized || fallback
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
