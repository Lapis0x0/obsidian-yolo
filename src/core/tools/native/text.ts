/**
 * Rejects bytes that are not text before they are decoded and handed to the
 * model. A lone NUL byte is the same cheap heuristic `grep` and `git` use:
 * no valid UTF-8 text file contains one, and without the check a binary read
 * turns into a screenful of replacement characters that costs tokens and
 * teaches the model nothing.
 *
 * Lives beside `paths.ts` rather than inside it: this is a question about a
 * file's *bytes*, not about where the file is.
 */
export const assertDecodableAsText = (
  bytes: Uint8Array,
  absolutePath: string,
): void => {
  if (bytes.includes(0)) {
    throw new Error(
      `${absolutePath} looks like a binary file (contains NUL bytes), not text. Inspect it with a shell command instead.`,
    )
  }
}
