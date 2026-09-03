// Pure path reading and filename generation: what a vault path *means* to the
// board (is it a note, is it a canvas, which kind of card does it render as —
// `fileNodeKind`), and the names the whiteboard gives what it creates in the
// vault: the `.yoloboard` files themselves (command + folder context menu,
// docs/plans/08-25-yolo-whiteboard/p1-design.md §5) and the notes a text
// card is converted into (§1.2, which puts them in `<board name> Cards/`).
// Both kinds share one conflict rule, defined here once, so the call sites
// can never drift on what "already taken" means.

const YOLOBOARD_EXTENSION = '.yoloboard'
const MARKDOWN_EXTENSION = '.md'

const CANVAS_EXTENSION = '.canvas'

/** Characters no vault file name may contain, plus path separators. */
const ILLEGAL_FILE_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g

/**
 * Whether a file node's path points at a note. The board's one markdown
 * rendering path (p3-canvas-parity D2/D11) is reached through this test, and
 * so is "can this card be edited" — a JSON Canvas `file` node holds any
 * vault file, and only the markdown ones have text a card can show or edit.
 */
export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(MARKDOWN_EXTENSION)
}

export function isCanvasPath(path: string): boolean {
  return path.toLowerCase().endsWith(CANVAS_EXTENSION)
}

/**
 * Which kind of card a `file` node's path renders as. A JSON Canvas file node
 * can point at anything in the vault, and the extension is the only thing that
 * says what to build for it — so this is the single table both the renderer
 * and the drop handler read, rather than each keeping its own list.
 *
 * The three media lists are exactly the extensions Obsidian itself registers
 * image/audio/video views for (read off `app.viewRegistry.typeByExtension` in
 * a running 1.13 instance) — behaviour alignment starts with agreeing on what
 * counts as an image (p3-canvas-parity D1). `unsupported` covers everything
 * left, PDF included (its card is M2).
 *
 * `html` is ours rather than Obsidian's: Obsidian registers no view for it at
 * all, so a `.html` file in a vault is inert. On a board it is a page, shown
 * in the same frame a web card uses — which is why it is a file kind and not
 * a second sort of `link` node: what it points at is a vault file, and every
 * behaviour that follows from that (renames, deletion, the missing-file card)
 * should follow from it here too.
 */
export type FileNodeKind =
  | 'markdown'
  | 'image'
  | 'audio'
  | 'video'
  | 'html'
  | 'unsupported'

const IMAGE_EXTENSIONS = [
  'bmp',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
] as const
const AUDIO_EXTENSIONS = [
  'mp3',
  'wav',
  'm4a',
  '3gp',
  'flac',
  'ogg',
  'oga',
  'opus',
] as const
/**
 * `.webm` is claimed by video, not audio: the container carries either, and a
 * `<video>` element plays an audio-only webm perfectly well (it just draws
 * nothing), while an `<audio>` element given a webm with a video track drops
 * the picture. Obsidian resolves the same ambiguity the same way.
 */
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'mov', 'mkv'] as const
const HTML_EXTENSIONS = ['html', 'htm'] as const

/** The extension a dropped HTML document is saved under. `.htm` is read but
 * never written: one spelling in, one spelling out. */
export const HTML_EXTENSION = '.html'

export function fileNodeKind(path: string): FileNodeKind {
  if (isMarkdownPath(path)) return 'markdown'
  const extension = extensionOf(path)
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension))
    return 'image'
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(extension))
    return 'audio'
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension))
    return 'video'
  if ((HTML_EXTENSIONS as readonly string[]).includes(extension)) return 'html'
  return 'unsupported'
}

/** Lowercased extension without the dot; '' for a name that has none. */
function extensionOf(path: string): string {
  const name = path.slice(
    Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1,
  )
  const dotIndex = name.lastIndexOf('.')
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : ''
}

/**
 * Vault-relative (or bare) file path -> its base name without extension.
 * One owner for both consumers: a file card's title / degraded label
 * (ui/lod.ts) and the name an imported `.canvas` hands to its `.yoloboard`.
 */
export function basenameWithoutExtension(path: string): string {
  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = slashIndex === -1 ? path : path.slice(slashIndex + 1)
  const dotIndex = name.lastIndexOf('.')
  return dotIndex > 0 ? name.slice(0, dotIndex) : name
}

/** The folder a vault path lives in; '' for a file at the vault root. */
export function folderPathOf(path: string): string {
  const slashIndex = path.lastIndexOf('/')
  return slashIndex === -1 ? '' : path.slice(0, slashIndex)
}

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

/**
 * File name for an HTML document dropped onto the board from outside the
 * vault. `fileName` is what the operating system called it, extension and
 * all; `fallbackBaseName` names the file when nothing legal survives
 * sanitizing (a document called `<>.html` is still a document).
 *
 * The extension is normalized rather than kept: `.htm` reads the same as
 * `.html` (`fileNodeKind`) and there is no reason for the vault to grow two
 * spellings of one thing. The same numeric-suffix conflict rule as whiteboards
 * and card notes applies.
 */
export function generateDroppedHtmlFileName(
  fileName: string,
  fallbackBaseName: string,
  existingNames: ReadonlySet<string>,
): string {
  const baseName =
    sanitizeFileName(basenameWithoutExtension(fileName)) || fallbackBaseName
  return generateUniqueFileName(baseName, HTML_EXTENSION, existingNames)
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
