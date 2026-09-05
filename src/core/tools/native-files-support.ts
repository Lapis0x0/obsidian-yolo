import type { App } from 'obsidian'

import { resolveNativePath } from '../agent/native-scope'

import { getTextArg } from './tool-args'

// Shared by the three `native_files` tools (`read_file` / `write_file` /
// `edit_file`) — the path contract they advertise to the model and the
// resolution they run on it must be one thing, not three copies that can
// drift apart.

/**
 * The `path` property description every native file tool exposes. Written
 * for the model: it has to be able to tell these apart from the vault-backed
 * `fs_*` tools, which take vault-relative paths and resolve wikilinks.
 */
export const NATIVE_PATH_ARG_DESCRIPTION =
  'Filesystem path. Absolute ("/Users/me/x.md", "C:\\\\work\\\\x.md"), home-relative ("~/x.md"), ' +
  'or relative to the vault root. Any extension, hidden directories, and locations outside the ' +
  'vault are all allowed. This is a real path on disk — never a wikilink, a skill path, or a ' +
  'browser:// page id.'

/** Reads the `path` argument and resolves it to an absolute path. */
export const resolveNativeFilePathArg = async (
  app: App,
  args: Record<string, unknown>,
): Promise<string> => resolveNativePath(app, getTextArg(args, 'path'))

/**
 * Rejects bytes that are not text before they are decoded and handed to the
 * model. A lone NUL byte is the same cheap heuristic `grep` and `git` use:
 * no valid UTF-8 text file contains one, and without the check a binary read
 * turns into a screenful of replacement characters that costs tokens and
 * teaches the model nothing.
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
