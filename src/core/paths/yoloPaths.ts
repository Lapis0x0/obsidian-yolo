import { normalizePath } from 'obsidian'

export const DEFAULT_YOLO_BASE_DIR = 'YOLO'
export const YOLO_SKILLS_SUBDIR = 'skills'
export const YOLO_SKILLS_INDEX_FILE_NAME = 'Skills.md'
export const YOLO_JSON_DB_DIR_NAME = '.yolo_json_db'
export const YOLO_VECTOR_DB_FILE_NAME = '.yolo_vector_db.tar.gz'
export const LEGACY_JSON_DB_DIR_NAME = '.smtcmp_json_db'
export const LEGACY_VECTOR_DB_FILE_NAME = '.smtcmp_vector_db.tar.gz'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

export const normalizeVaultRelativeDir = (
  value: string | undefined,
): string => {
  const normalized = normalizePath((value ?? '').trim())
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.endsWith('/..')
  ) {
    return DEFAULT_YOLO_BASE_DIR
  }

  return normalized
}

export const getYoloBaseDir = (settings?: YoloSettingsLike | null): string => {
  return normalizeVaultRelativeDir(settings?.yolo?.baseDir)
}

export const getYoloSkillsDir = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(`${getYoloBaseDir(settings)}/${YOLO_SKILLS_SUBDIR}`)
}

export const getYoloSkillsDirPrefix = (
  settings?: YoloSettingsLike | null,
): string => {
  return `${getYoloSkillsDir(settings)}/`
}

export const getYoloSkillsIndexPath = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(
    `${getYoloSkillsDir(settings)}/${YOLO_SKILLS_INDEX_FILE_NAME}`,
  )
}

export const getYoloJsonDbRootDir = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(`${getYoloBaseDir(settings)}/${YOLO_JSON_DB_DIR_NAME}`)
}

export const getYoloVectorDbPath = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(
    `${getYoloBaseDir(settings)}/${YOLO_VECTOR_DB_FILE_NAME}`,
  )
}

export const getLegacyJsonDbRootDir = (): string => {
  return LEGACY_JSON_DB_DIR_NAME
}

export const getLegacyVectorDbPath = (): string => {
  return LEGACY_VECTOR_DB_FILE_NAME
}
