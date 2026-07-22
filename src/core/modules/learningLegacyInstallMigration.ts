import type { DataAdapter } from 'obsidian'
import { normalizePath } from 'obsidian'

import type { YoloSettingsLike } from '../paths/yoloManagedData'
import {
  YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME,
  YOLO_LEARNING_SRS_DIR_NAME,
  getLegacyJsonDbRootDir,
  getYoloJsonDbRootDir,
  getYoloLearningDir,
} from '../paths/yoloPaths'

import type { ModuleCreateIfAbsentResult } from './moduleSettingsStore'

const LEARNING_MODULE_ID = 'learning'

export type LearningIntentEnableIfAbsent = (
  moduleId: string,
) => Promise<ModuleCreateIfAbsentResult>

export type LearningLegacyInstallMigrationResult =
  | 'not-used'
  | 'enabled'
  | 'already-decided'

export type LearningLegacyInstallMigrationOptions = Readonly<{
  adapter: Pick<DataAdapter, 'exists'>
  settings: YoloSettingsLike | null
  legacySettings: unknown
  enableIfAbsent: LearningIntentEnableIfAbsent
}>

/** Preserves access for users who demonstrably used Core-owned Learning. */
export async function migrateLearningLegacyInstallIntent({
  adapter,
  settings,
  legacySettings,
  enableIfAbsent,
}: LearningLegacyInstallMigrationOptions): Promise<LearningLegacyInstallMigrationResult> {
  if (
    !hasLegacyLearningSettingsEvidence(legacySettings) &&
    !(await hasLegacyLearningData(adapter, settings))
  ) {
    return 'not-used'
  }

  const result = await enableIfAbsent(LEARNING_MODULE_ID)
  return result === 'created' ? 'enabled' : 'already-decided'
}

export function hasLegacyLearningSettingsEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const settings = value as Record<string, unknown>
  // Core normalized modelId to the default chat model even for users who had
  // never opened Learning, so only the explicit acknowledgement proves use.
  return settings.betaNoticeAcknowledged === true
}

async function hasLegacyLearningData(
  adapter: Pick<DataAdapter, 'exists'>,
  settings: YoloSettingsLike | null,
): Promise<boolean> {
  const currentJsonRoot = getYoloJsonDbRootDir(settings)
  const legacyJsonRoot = getLegacyJsonDbRootDir()
  const paths = [
    getYoloLearningDir(settings),
    `${currentJsonRoot}/${YOLO_LEARNING_SRS_DIR_NAME}`,
    `${currentJsonRoot}/${YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME}`,
    `${legacyJsonRoot}/${YOLO_LEARNING_SRS_DIR_NAME}`,
    `${legacyJsonRoot}/${YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME}`,
  ]
  for (const path of paths) {
    if (await adapter.exists(normalizePath(path))) return true
  }
  return false
}
