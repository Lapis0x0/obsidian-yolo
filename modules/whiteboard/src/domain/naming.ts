// Pure filename generation for the "new whiteboard" creation entries (command
// + folder context menu, docs/plans/08-25-yolo-whiteboard/p1-design.md §5).
// Both entry points create a `.yoloboard` file named after the localized
// "Whiteboard"/"白板" base name, with a numeric suffix on collision — this is
// the single place that decides the exact candidate sequence, so the two
// call sites (src/host/createWhiteboard.ts) never have to duplicate or
// drift on the conflict rule.

const YOLOBOARD_EXTENSION = '.yoloboard'

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
  const plain = `${baseName}${YOLOBOARD_EXTENSION}`
  if (!existingNames.has(plain)) return plain

  let suffix = 1
  let candidate = `${baseName} ${suffix}${YOLOBOARD_EXTENSION}`
  while (existingNames.has(candidate)) {
    suffix += 1
    candidate = `${baseName} ${suffix}${YOLOBOARD_EXTENSION}`
  }
  return candidate
}
