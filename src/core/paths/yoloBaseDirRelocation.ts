import { App, TFolder } from 'obsidian'

export type YoloBaseDirRelocationResult =
  | { status: 'not-needed' | 'cancelled' }
  | {
      status: 'migrated' | 'adopted' | 'created'
      source: string
      target: string
    }
  | {
      status: 'target-conflict'
      source: string
      target: string
      reason: 'file' | 'non-empty-folder' | 'nested-target'
    }
  | { status: 'protected-source'; source: string; target: string }
  | {
      status: 'failed'
      source: string
      target: string
      error: unknown
      rollbackFailed: boolean
    }

type RelocationOptions = {
  app: App
  source: string
  target: string
  persistTargetBaseDir: (baseDir: string) => Promise<void>
  confirmAdoptExistingTarget: (target: string) => Promise<boolean>
}

/**
 * Moves the complete YOLO workspace and commits its new setting as one
 * recoverable operation. Existing non-empty targets are never merged.
 */
export async function relocateYoloBaseDir({
  app,
  source,
  target,
  persistTargetBaseDir,
  confirmAdoptExistingTarget,
}: RelocationOptions): Promise<YoloBaseDirRelocationResult> {
  if (source === target) return { status: 'not-needed' }
  if (target.startsWith(`${source}/`)) {
    return {
      status: 'target-conflict',
      source,
      target,
      reason: 'nested-target',
    }
  }

  const sourceRoot = source.split('/')[0]
  if (
    sourceRoot === app.vault.configDir ||
    sourceRoot === '.git' ||
    sourceRoot === '.trash'
  ) {
    return { status: 'protected-source', source, target }
  }

  const adapter = app.vault.adapter
  try {
    const [sourceStat, targetStat] = await Promise.all([
      adapter.stat(source),
      adapter.stat(target),
    ])

    if (targetStat?.type === 'file') {
      return { status: 'target-conflict', source, target, reason: 'file' }
    }

    const targetIsNonEmpty =
      targetStat?.type === 'folder'
        ? await isFolderNonEmpty(app, target)
        : false

    if (!sourceStat) {
      if (targetIsNonEmpty && !(await confirmAdoptExistingTarget(target))) {
        return { status: 'cancelled' }
      }

      const createdFolders: string[] = []
      if (!targetStat) await ensureFolder(app, target, createdFolders)
      try {
        await persistTargetBaseDir(target)
        return {
          status: targetStat ? 'adopted' : 'created',
          source,
          target,
        }
      } catch (error) {
        await cleanupCreatedFolders(app, createdFolders)
        return {
          status: 'failed',
          source,
          target,
          error,
          rollbackFailed: false,
        }
      }
    }

    if (sourceStat.type !== 'folder') {
      return {
        status: 'failed',
        source,
        target,
        error: new Error(`YOLO root is not a folder: ${source}`),
        rollbackFailed: false,
      }
    }
    if (targetIsNonEmpty) {
      return {
        status: 'target-conflict',
        source,
        target,
        reason: 'non-empty-folder',
      }
    }

    const createdParents: string[] = []
    await ensureParentFolders(app, target, createdParents)
    const replacedEmptyTarget = targetStat?.type === 'folder'
    if (replacedEmptyTarget) await removeEmptyFolder(app, target)

    try {
      await moveFolder(app, source, target)
    } catch (error) {
      try {
        const [sourceAfterMove, targetAfterMove] = await Promise.all([
          adapter.stat(source),
          adapter.stat(target),
        ])
        if (!sourceAfterMove && targetAfterMove?.type === 'folder') {
          await moveFolder(app, target, source)
        }
        if (replacedEmptyTarget) await ensureFolder(app, target, [])
        await cleanupCreatedFolders(app, createdParents)
        return {
          status: 'failed',
          source,
          target,
          error,
          rollbackFailed: false,
        }
      } catch (rollbackError) {
        console.error(
          '[YOLO] Failed to recover after YOLO root move error',
          rollbackError,
        )
        return { status: 'failed', source, target, error, rollbackFailed: true }
      }
    }

    try {
      await persistTargetBaseDir(target)
      return { status: 'migrated', source, target }
    } catch (error) {
      try {
        await moveFolder(app, target, source)
        if (replacedEmptyTarget) await ensureFolder(app, target, [])
        await cleanupCreatedFolders(app, createdParents)
        return {
          status: 'failed',
          source,
          target,
          error,
          rollbackFailed: false,
        }
      } catch (rollbackError) {
        console.error(
          '[YOLO] Failed to roll back YOLO root relocation',
          rollbackError,
        )
        return { status: 'failed', source, target, error, rollbackFailed: true }
      }
    }
  } catch (error) {
    return { status: 'failed', source, target, error, rollbackFailed: false }
  }
}

async function isFolderNonEmpty(app: App, path: string): Promise<boolean> {
  const listing = await app.vault.adapter.list(path)
  return listing.files.length > 0 || listing.folders.length > 0
}

async function ensureParentFolders(
  app: App,
  path: string,
  createdFolders: string[],
): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf('/'))
  if (parent) await ensureFolder(app, parent, createdFolders)
}

async function ensureFolder(
  app: App,
  path: string,
  createdFolders: string[],
): Promise<void> {
  const segments = path.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    const stat = await app.vault.adapter.stat(current)
    if (stat?.type === 'folder') continue
    if (stat) throw new Error(`Path is not a folder: ${current}`)
    await app.vault.createFolder(current)
    createdFolders.push(current)
  }
}

async function moveFolder(
  app: App,
  source: string,
  target: string,
): Promise<void> {
  const indexed = app.vault.getAbstractFileByPath(source)
  if (indexed instanceof TFolder) {
    await app.fileManager.renameFile(indexed, target)
    return
  }
  await app.vault.adapter.rename(source, target)
}

async function removeEmptyFolder(app: App, path: string): Promise<void> {
  const indexed = app.vault.getAbstractFileByPath(path)
  if (indexed instanceof TFolder) {
    // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- The empty destination is restored on rollback; trash would create a duplicate recovery artifact.
    await app.vault.delete(indexed, false)
    return
  }
  await app.vault.adapter.rmdir(path, false)
}

async function cleanupCreatedFolders(app: App, folders: readonly string[]) {
  for (const folder of [...folders].reverse()) {
    try {
      await removeEmptyFolder(app, folder)
    } catch {
      // Keep folders that gained content concurrently.
    }
  }
}
