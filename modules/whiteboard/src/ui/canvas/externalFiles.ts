// Files from outside the vault — dropped from the operating system or pasted
// — brought in the one way both gestures share: as attachments, filed where
// the user's attachment setting files a picture pasted into a note written at
// the board's path. Placing the cards is the caller's: a paste lands them as
// a selected fragment (./clipboardController.ts), a drop where it let go
// (./dropImport.ts).

import { importedFileName } from '../../domain/naming'

import type { CanvasCore } from './core'

/**
 * Writes `files` into the vault and returns the paths written. One at a time:
 * each free path is chosen against the files already written, so two brought
 * in together cannot be handed the same one. A failure is reported with
 * `failureNotice` and ends the import; what landed before it is returned, a
 * card still worth having.
 */
export async function importExternalFiles(
  core: CanvasCore,
  files: readonly File[],
  failureNotice: string,
): Promise<string[]> {
  const { vault } = core.host
  const sourcePath = core.getSourcePath()
  const paths: string[] = []
  try {
    for (const file of files) {
      const path = await vault.getAvailableAttachmentPath(
        importedFileName(file.name, core.t('file.importedBaseName')),
        sourcePath,
      )
      await vault.createBinary(path, await file.arrayBuffer())
      paths.push(path)
    }
  } catch (error) {
    core.reportError('importExternalFiles', error)
    core.host.ui.notice(failureNotice)
  }
  return paths
}
