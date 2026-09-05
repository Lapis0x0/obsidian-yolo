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
  if (!isDecodableAsText(bytes)) {
    throw new Error(
      `${absolutePath} looks like a binary file (contains NUL bytes), not text. Inspect it with a shell command instead.`,
    )
  }
}

/**
 * The same judgment as a question rather than a guard, for the callers that
 * have something better to do than fail — the edit snapshot skips a binary
 * file instead of refusing the write that was already legal.
 */
export const isDecodableAsText = (bytes: Uint8Array): boolean =>
  !bytes.includes(0)
