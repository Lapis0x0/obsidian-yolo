import { DataAdapter } from 'obsidian'

/**
 * Removes a directory only when it is empty, leaving a directory that still
 * has content untouched. Returns whether the directory is gone (a missing
 * path counts as gone; a non-folder path or remaining content returns false).
 *
 * Since Obsidian 1.13, the desktop adapter routes `rmdir(path, false)`
 * through Node's `fs.rm(path, { recursive: false })`, which rejects every
 * directory — even an empty one — with ERR_FS_EISDIR. Non-recursive `rmdir`
 * can therefore no longer express "delete only if empty"; the emptiness
 * check has to happen first, followed by a recursive delete of the verified
 * empty shell, which this helper centralizes.
 */
export const removeDirIfEmpty = async (
  adapter: DataAdapter,
  path: string,
): Promise<boolean> => {
  const stat = await adapter.stat(path)
  if (!stat) return true
  if (stat.type !== 'folder') return false
  const listing = await adapter.list(path)
  if (listing.files.length > 0 || listing.folders.length > 0) {
    return false
  }
  await adapter.rmdir(path, true)
  return true
}
