import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { isAbsoluteNativePath } from '../../core/tools/native/paths'
import type { EditReviewSnapshot } from '../../database/edit-review/editReviewSnapshotStore'

const ensureDirectoryPathExists = async (
  app: App,
  path: string,
): Promise<void> => {
  const segments = normalizePath(path)
    .split('/')
    .filter((segment) => segment.length > 0)

  let currentPath = ''
  for (const segment of segments) {
    currentPath = currentPath.length > 0 ? `${currentPath}/${segment}` : segment
    const existing = app.vault.getAbstractFileByPath(currentPath)
    if (!existing) {
      await app.vault.createFolder(currentPath)
      continue
    }
    if (!(existing instanceof TFolder)) {
      throw new Error(`Path exists and is not a folder: ${currentPath}`)
    }
  }
}

/**
 * Reading and rewriting the file one edit-summary entry points at.
 *
 * A summary path is vault-relative for a file inside the vault and absolute
 * for one outside it (`toEditSummaryPath` in `core/tools/native/paths.ts`) —
 * only Max's native tools ever produce the second shape, and those files have
 * no `TFile` at all, so undo has to reach them through node's fs. Everything
 * above this helper stays one code path: the same snapshot comparison and the
 * same restore, whichever filesystem is underneath.
 */
export type EditTargetIo = {
  /** Current content, or `null` when the file does not exist. */
  read: () => Promise<string | null>
  /** Writes the file, creating it and its parent directories if needed. */
  write: (content: string) => Promise<void>
  /** Removes the file (to the trash where the platform has one). */
  trash: () => Promise<void>
}

/**
 * True for the summary paths that point outside the vault. The absolute shape
 * is exactly what {@link openEditTarget} routes to node's fs, and it is also
 * what the review overlay cannot show: that overlay is a diff layer on an
 * Obsidian editor view, and a file with no `TFile` has no view to layer onto.
 */
export const isOutsideVaultEditPath = (path: string): boolean =>
  isAbsoluteNativePath(path)

export const openEditTarget = async (
  app: App,
  path: string,
): Promise<EditTargetIo> => {
  if (!isOutsideVaultEditPath(path)) {
    const resolveFile = () => {
      const entry = app.vault.getAbstractFileByPath(path)
      return entry instanceof TFile ? entry : null
    }
    return {
      read: async () => {
        const file = resolveFile()
        return file ? await app.vault.read(file) : null
      },
      write: async (content) => {
        const file = resolveFile()
        if (file) {
          await app.vault.modify(file, content)
          return
        }
        const parentPath = path.split('/').slice(0, -1).join('/')
        if (parentPath.length > 0) {
          await ensureDirectoryPathExists(app, parentPath)
        }
        await app.vault.create(path, content)
      },
      trash: async () => {
        const file = resolveFile()
        if (file) {
          await app.fileManager.trashFile(file)
        }
      },
    }
  }

  // eslint-disable-next-line import/no-nodejs-modules -- absolute paths only ever come from the desktop-only native file tools, and the import is inside that branch so mobile never loads it
  const fs = await import('node:fs/promises')
  const isMissing = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'

  return {
    read: async () => {
      try {
        return await fs.readFile(path, 'utf-8')
      } catch (error) {
        if (isMissing(error)) {
          return null
        }
        throw error
      }
    },
    write: async (content) => {
      const parentPath = path.replace(/[\\/][^\\/]*$/, '')
      if (parentPath.length > 0 && parentPath !== path) {
        await fs.mkdir(parentPath, { recursive: true })
      }
      await fs.writeFile(path, content, 'utf-8')
    },
    trash: async () => {
      try {
        await fs.rm(path)
      } catch (error) {
        if (!isMissing(error)) {
          throw error
        }
      }
    },
  }
}

/**
 * Both snapshots have to be there *with their content* for undo or review to
 * mean anything. They can be missing because the edit was made on another
 * device (snapshots are device-local IndexedDB now), or contentless because
 * the file was over the snapshot size cap.
 */
export const usableSnapshotPair = (
  first: EditReviewSnapshot | null,
  latest: EditReviewSnapshot | null,
): { first: EditReviewSnapshot; latest: EditReviewSnapshot } | null =>
  first && latest && first.contentAvailable && latest.contentAvailable
    ? { first, latest }
    : null
