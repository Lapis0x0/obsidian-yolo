import { App } from 'obsidian'

import {
  getVisibleYoloBaseDir,
  getYoloBaseDir,
  hasHiddenYoloBaseDirSegment,
} from './yoloPaths'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

export type HiddenYoloBaseDirMigrationResult =
  | { status: 'not-needed' }
  | { status: 'manual-repair'; source: string }
  | { status: 'migrated' | 'source-missing'; source: string; target: string }
  | { status: 'target-exists'; source: string; target: string }
  | {
      status: 'failed'
      source: string
      target: string
      error: unknown
      rollbackFailed: boolean
    }

/**
 * Moves a legacy hidden base directory as one adapter operation, then commits
 * its replacement setting. A failed settings write is rolled back before the
 * caller observes a changed configuration.
 */
export const migrateHiddenYoloBaseDir = async ({
  app,
  settings,
  persistTargetBaseDir,
}: {
  app: App
  settings: YoloSettingsLike
  persistTargetBaseDir: (baseDir: string) => Promise<void>
}): Promise<HiddenYoloBaseDirMigrationResult> => {
  const source = getYoloBaseDir(settings)
  if (!hasHiddenYoloBaseDirSegment(source)) return { status: 'not-needed' }
  const target = getVisibleYoloBaseDir(source, {
    reservedRoots: [app.vault.configDir],
  })
  if (!target) return { status: 'manual-repair', source }

  const adapter = app.vault.adapter
  let sourceStat
  try {
    if (await adapter.exists(target)) {
      return { status: 'target-exists', source, target }
    }
    sourceStat = await adapter.stat(source)
  } catch (error) {
    return { status: 'failed', source, target, error, rollbackFailed: false }
  }
  if (!sourceStat) {
    try {
      await persistTargetBaseDir(target)
      return { status: 'source-missing', source, target }
    } catch (error) {
      return { status: 'failed', source, target, error, rollbackFailed: false }
    }
  }
  if (sourceStat.type !== 'folder') {
    return {
      status: 'failed',
      source,
      target,
      error: new Error('YOLO root source is not a folder'),
      rollbackFailed: false,
    }
  }

  const createdParents: string[] = []
  const parentSegments = target.split('/').slice(0, -1)
  try {
    let parent = ''
    for (const segment of parentSegments) {
      parent = parent ? `${parent}/${segment}` : segment
      const stat = await adapter.stat(parent)
      if (stat?.type === 'folder') continue
      if (stat) throw new Error('YOLO root target parent is not a folder')
      await adapter.mkdir(parent)
      createdParents.push(parent)
    }
  } catch (error) {
    await cleanupCreatedParents(adapter, createdParents)
    return { status: 'failed', source, target, error, rollbackFailed: false }
  }

  try {
    await adapter.rename(source, target)
  } catch (error) {
    // Some adapters report an error after a successful underlying rename.
    // Ownership checks make that case safe to complete rather than leaving a
    // moved directory behind with its old setting.
    let sourceStillExists = true
    let targetNowExists = false
    try {
      sourceStillExists = await adapter.exists(source)
      targetNowExists = await adapter.exists(target)
    } catch {
      // Keep the conservative defaults and report the original move error.
    }
    if (sourceStillExists || !targetNowExists) {
      await cleanupCreatedParents(adapter, createdParents)
      return {
        status: 'failed',
        source,
        target,
        error,
        rollbackFailed: false,
      }
    }
  }
  let moveVerified = false
  try {
    moveVerified =
      !(await adapter.exists(source)) && (await adapter.exists(target))
  } catch {
    // `rename` resolved successfully, so trust the adapter contract when the
    // optional ownership verification itself is unavailable.
    moveVerified = true
  }
  if (!moveVerified) {
    await cleanupCreatedParents(adapter, createdParents)
    return {
      status: 'failed',
      source,
      target,
      error: new Error('YOLO root move could not be verified'),
      rollbackFailed: false,
    }
  }

  try {
    await persistTargetBaseDir(target)
    return { status: 'migrated', source, target }
  } catch (error) {
    try {
      await adapter.rename(target, source)
      if ((await adapter.exists(target)) || !(await adapter.exists(source))) {
        throw new Error('YOLO root rollback could not be verified')
      }
      await cleanupCreatedParents(adapter, createdParents)
      return {
        status: 'failed',
        source,
        target,
        error,
        rollbackFailed: false,
      }
    } catch (rollbackError) {
      console.error(
        '[YOLO] Failed to roll back hidden base directory move',
        rollbackError,
      )
      return {
        status: 'failed',
        source,
        target,
        error,
        rollbackFailed: true,
      }
    }
  }
}

const cleanupCreatedParents = async (
  adapter: App['vault']['adapter'],
  parents: readonly string[],
): Promise<void> => {
  for (const parent of [...parents].reverse()) {
    try {
      await adapter.rmdir(parent, false)
    } catch {
      // It either was populated concurrently or was never created by us.
    }
  }
}
