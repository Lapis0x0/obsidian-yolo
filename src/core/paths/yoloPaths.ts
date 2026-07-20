import { normalizePath } from 'obsidian'

export const DEFAULT_YOLO_BASE_DIR = 'YOLO'
export const YOLO_SKILLS_SUBDIR = 'skills'
export const YOLO_SKILLS_INDEX_FILE_NAME = 'Skills.md'
export const YOLO_SNIPPETS_FILE_NAME = 'snippets.md'
export const YOLO_JSON_DB_DIR_NAME = '.yolo_json_db'
export const YOLO_VECTOR_DB_FILE_NAME = '.yolo_vector_db.tar.gz'
export const YOLO_DATA_JSON_FILE_NAME = '.yolo_data.json'
export const YOLO_LEARNING_SUBDIR = 'learning'
export const YOLO_LEARNING_SRS_DIR_NAME = 'learning-srs'
export const YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME = 'anki-import-journals'
// Fixed-name pointer file at vault root. Its content is a JSON object
// { "dataPath": "<vault-relative path to .yolo_data.json>" } used to locate
// the actual mirror file whose directory depends on `yolo.baseDir`.
export const YOLO_SYNC_POINTER_FILE_NAME = '.yolo_sync'
export const LEGACY_JSON_DB_DIR_NAME = '.smtcmp_json_db'
export const LEGACY_VECTOR_DB_FILE_NAME = '.smtcmp_vector_db.tar.gz'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

const RESERVED_HIDDEN_VAULT_ROOTS = new Set(['.git', '.trash'])

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

/** True when a vault-relative path contains a segment Obsidian will not index. */
export const hasHiddenYoloBaseDirSegment = (value: string): boolean =>
  normalizePath(value.trim())
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .some((segment) => segment.startsWith('.'))

/** Never switch an already-running plugin to a hidden root from external data. */
export const resolveExternalYoloBaseDir = (
  currentBaseDir: string,
  incomingBaseDir: string,
): string =>
  currentBaseDir !== incomingBaseDir &&
  hasHiddenYoloBaseDirSegment(incomingBaseDir)
    ? currentBaseDir
    : incomingBaseDir

/**
 * Returns the indexed equivalent of a historical hidden YOLO root, or null
 * when every segment is already visible. A segment made only of dots has no
 * safe name to migrate to, so it is deliberately left for manual repair.
 */
export const getVisibleYoloBaseDir = (
  value: string,
  options?: { reservedRoots?: readonly string[] },
): string | null => {
  const source = normalizeVaultRelativeDir(value)
  const firstSegment = source.split('/')[0]
  if (
    RESERVED_HIDDEN_VAULT_ROOTS.has(firstSegment) ||
    options?.reservedRoots?.includes(firstSegment)
  ) {
    return null
  }
  const targetSegments = source
    .split('/')
    .map((segment) =>
      segment.startsWith('.') ? segment.replace(/^\.+/, '') : segment,
    )

  if (targetSegments.some((segment) => segment.length === 0)) {
    return null
  }

  const target = targetSegments.join('/')
  return target === source ? null : target
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

export const getYoloSnippetsPath = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(`${getYoloBaseDir(settings)}/${YOLO_SNIPPETS_FILE_NAME}`)
}

export const getYoloLearningDir = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(`${getYoloBaseDir(settings)}/${YOLO_LEARNING_SUBDIR}`)
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

// The vault-stored `data.json` mirror sits under `yolo.baseDir` for UX
// consistency with other plugin files (.yolo_json_db, .yolo_vector_db.tar.gz).
// A sibling pointer file at vault root (`.yolo_sync`) records where this
// path is, so other devices can locate the mirror without needing the synced
// `baseDir` value upfront — breaking the bootstrap circular dependency.
export const getYoloDataJsonPath = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(
    `${getYoloBaseDir(settings)}/${YOLO_DATA_JSON_FILE_NAME}`,
  )
}

export const getYoloSyncPointerPath = (): string => {
  return normalizePath(YOLO_SYNC_POINTER_FILE_NAME)
}

export const getLegacyJsonDbRootDir = (): string => {
  return LEGACY_JSON_DB_DIR_NAME
}

export const getLegacyVectorDbPath = (): string => {
  return LEGACY_VECTOR_DB_FILE_NAME
}
