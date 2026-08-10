import { App, TFile, TFolder, normalizePath } from 'obsidian'

/**
 * Vault-relative path validation and the trash/rename/mkdir service
 * functions shared by the `fs_write` tool (see `localFileTools.ts`) and the
 * bash tool's Vault filesystem adapter (see
 * `src/core/agent/bash/vaultBashFileSystem.ts`). Kept here, independent of
 * both callers, so neither has to depend on the other for these vault
 * semantics.
 */

export const validateVaultPath = (path: string): string => {
  const normalizedPath = normalizePath(path).trim()

  if (normalizedPath.length === 0) {
    throw new Error('Path is required.')
  }
  if (
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('./') ||
    normalizedPath.startsWith('../')
  ) {
    throw new Error('Path must be a vault-relative path.')
  }
  if (normalizedPath.includes('/../') || normalizedPath.endsWith('/..')) {
    throw new Error('Path cannot contain parent directory traversal.')
  }

  return normalizedPath
}

export const getParentFolderPath = (path: string): string => {
  const lastSlashIndex = path.lastIndexOf('/')
  return lastSlashIndex === -1 ? '' : path.slice(0, lastSlashIndex)
}

export const ensureFolderPathExists = async (
  app: App,
  path: string,
): Promise<void> => {
  const normalizedPath = validateVaultPath(path)
  const existing = app.vault.getAbstractFileByPath(normalizedPath)
  if (existing) {
    if (!(existing instanceof TFolder)) {
      throw new Error(`Path is not a folder: ${normalizedPath}`)
    }
    return
  }

  const parentFolderPath = getParentFolderPath(normalizedPath)
  if (parentFolderPath) {
    await ensureFolderPathExists(app, parentFolderPath)
  }

  await app.vault.createFolder(normalizedPath)
}

export const ensureParentFolderExists = async (
  app: App,
  path: string,
): Promise<void> => {
  const parentFolderPath = getParentFolderPath(path)
  if (!parentFolderPath) {
    return
  }
  await ensureFolderPathExists(app, parentFolderPath)
}

export type VaultRmResult = Readonly<{ targetKind: 'file' | 'folder' }>

/**
 * Move a vault path to trash via `fileManager.trashFile` (respects the
 * user's configured delete method — system trash / `.trash` / permanent).
 * Mirrors the retired `fs_delete` tool's semantics exactly, minus the
 * chat-undo/editSummary bookkeeping, which is a tool-protocol concern that
 * lives with `fs_write`'s callers, not with vault semantics.
 */
export async function trashVaultPath(
  app: App,
  path: string,
  options?: { recursive?: boolean },
): Promise<VaultRmResult> {
  const existing = app.vault.getAbstractFileByPath(path)
  if (!existing) {
    throw new Error(`Path not found: ${path}`)
  }

  if (existing instanceof TFile) {
    await app.fileManager.trashFile(existing)
    return { targetKind: 'file' }
  }

  if (existing instanceof TFolder) {
    if (!(options?.recursive ?? false) && existing.children.length > 0) {
      throw new Error(
        `Folder is not empty: ${path}. Set recursive=true to delete non-empty folders.`,
      )
    }
    await app.fileManager.trashFile(existing)
    return { targetKind: 'folder' }
  }

  throw new Error(`Unsupported delete target: ${path}`)
}

/** Mirrors the retired `fs_create_dir` tool's semantics. */
export async function createVaultFolder(app: App, path: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(path)
  if (existing) {
    throw new Error(`Path already exists: ${path}`)
  }
  await ensureParentFolderExists(app, path)
  await app.vault.createFolder(path)
}

/**
 * Move/rename via `fileManager.renameFile`, which rewrites every backlink
 * across the vault. Mirrors the retired `fs_move` tool's semantics exactly.
 */
export async function moveVaultPath(
  app: App,
  oldPath: string,
  newPath: string,
): Promise<void> {
  if (oldPath === newPath) {
    throw new Error('oldPath and newPath must be different.')
  }

  const source = app.vault.getAbstractFileByPath(oldPath)
  if (!source) {
    throw new Error(`Source path not found: ${oldPath}`)
  }

  const targetExists = app.vault.getAbstractFileByPath(newPath)
  if (targetExists) {
    throw new Error(`Target path already exists: ${newPath}`)
  }
  await ensureParentFolderExists(app, newPath)

  if (
    source instanceof TFolder &&
    (newPath === source.path || newPath.startsWith(`${source.path}/`))
  ) {
    throw new Error('Cannot move a folder into itself or its subfolder.')
  }

  await app.fileManager.renameFile(source, newPath)
}
