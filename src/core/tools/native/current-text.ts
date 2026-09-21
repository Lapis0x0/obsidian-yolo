import type { CurrentFileText } from '../file-change-resolver'
import { MAX_FILE_SIZE_BYTES } from '../tool-args'

import { isDecodableAsText } from './text'

/**
 * A file's current text on the real filesystem, for callers that compare it
 * with or diff it against something rather than write it: the pending-write
 * preview (`file-editing-ui.tsx`) and the CLI runtimes, which read what an
 * external agent is about to change or has just changed.
 *
 * Only a small text file comes back as text. Past `MAX_FILE_SIZE_BYTES` — the
 * size past which the write tools themselves stop snapshotting the
 * before-content — anything that is not a regular file, binary bytes, and any
 * I/O error are all `unreadable`: a caller of this has a sensible thing to do
 * without the text, so none of these is worth failing over.
 *
 * Desktop-only: `node:fs` is imported dynamically so mobile never loads it,
 * and the caller is responsible for only reaching this on desktop.
 */
export const readNativeCurrentText = async (
  absolutePath: string,
): Promise<CurrentFileText> => {
  try {
    // eslint-disable-next-line import/no-nodejs-modules -- desktop-only by contract (see above), dynamically imported so mobile never loads it
    const fs = await import('node:fs/promises')
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(absolutePath)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') {
        return { state: 'absent' }
      }
      throw error
    }
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE_BYTES) {
      return { state: 'unreadable' }
    }
    const bytes = new Uint8Array(await fs.readFile(absolutePath))
    return isDecodableAsText(bytes)
      ? { state: 'text', text: new TextDecoder().decode(bytes) }
      : { state: 'unreadable' }
  } catch {
    return { state: 'unreadable' }
  }
}
