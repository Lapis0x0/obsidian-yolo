import { normalizePath } from 'obsidian'

export const DEFAULT_YOLO_BASE_DIR = 'YOLO'
export const YOLO_SKILLS_SUBDIR = 'skills'
export const YOLO_SKILLS_INDEX_FILE_NAME = 'Skills.md'
export const YOLO_SNIPPETS_FILE_NAME = 'snippets.md'
export const YOLO_JSON_DB_DIR_NAME = '.yolo_json_db'
// Cleanup-only: the retired PGlite-backed vector store used to snapshot here.
// The only remaining reader of this name is `DatabaseManager`'s legacy-artifact
// sweep (`cleanupLegacyVectorDbArtifacts`) — nothing writes it anymore, so
// don't reuse it as if it were a live storage path.
export const LEGACY_YOLO_VECTOR_DB_ARCHIVE_FILE_NAME = '.yolo_vector_db.tar.gz'
export const YOLO_DATA_JSON_FILE_NAME = '.yolo_data.json'
export const YOLO_LEARNING_SUBDIR = 'learning'
// Host-owned projection root for artifacts a module ships and the rest of the
// app must reach through ordinary Vault paths (currently: skill packages, see
// `moduleSkillMaterializer.ts`). Deliberately visible/indexed — a dot-prefixed
// directory would be invisible to Obsidian's file index and therefore to the
// agent's read tools, which is the whole reason the projection exists.
export const YOLO_MODULES_SUBDIR = 'modules'
export const YOLO_MODULE_SKILLS_SUBDIR = 'skills'
export const YOLO_LEARNING_SRS_DIR_NAME = 'learning-srs'
export const YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME = 'anki-import-journals'
// Visible root for user data that must survive vault sync (Obsidian Sync,
// Remotely Save, etc. do not sync dot-prefixed directories, so anything a
// user needs replicated across devices — chat history, module settings and
// intent — lives here instead of the hidden `.yolo_json_db`). Device-local
// runtime state (CLI session index, model catalog cache, ...) intentionally
// stays under the hidden root; see `ensureUserDataRootDir`.
export const YOLO_USER_DATA_DIR_NAME = 'data'
export const YOLO_MODULE_SETTINGS_DIR_NAME = 'module-settings'
export const YOLO_MODULE_INTENT_DIR_NAME = 'module-intent-v1'
export const YOLO_COMPONENT_INTENT_DIR_NAME = 'component-intent-v1'
// Fixed-name pointer file at vault root. Its content is a JSON object
// { "dataPath": "<vault-relative path to .yolo_data.json>" } used to locate
// the actual mirror file whose directory depends on `yolo.baseDir`.
export const YOLO_SYNC_POINTER_FILE_NAME = '.yolo_sync'
export const LEGACY_JSON_DB_DIR_NAME = '.smtcmp_json_db'
export const LEGACY_VECTOR_DB_FILE_NAME = '.smtcmp_vector_db.tar.gz'

export type YoloSettingsLike = {
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

/**
 * True when `path` is the YOLO base directory itself or nested inside it.
 * Every knowledge base excludes this directory unconditionally, regardless
 * of its own include/exclude rules — it's an always-on rule, not a per-base
 * toggle. Callers that compute "what would a sync touch" or "how many files
 * does this scope match" outside the actual index write path (pending-change
 * counts, the scope-estimate UI, auto-update dirty tracking) must apply this
 * too, or they'll report/act on files the real indexer would never write —
 * see `VectorManager.listIndexableFiles`, the one place this exclusion was
 * previously applied.
 */
export const isWithinYoloBaseDir = (
  path: string,
  settings?: YoloSettingsLike | null,
): boolean => {
  const yoloBaseDir = getYoloBaseDir(settings)
  return path === yoloBaseDir || path.startsWith(`${yoloBaseDir}/`)
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

/** Root of every module's host-owned Vault projection. */
export const getYoloModulesRootDir = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(`${getYoloBaseDir(settings)}/${YOLO_MODULES_SUBDIR}`)
}

/**
 * One module's host-owned Vault projection root. `moduleId` must already be a
 * validated module id (`assertModuleId`); these helpers only assemble paths.
 */
export const getYoloModuleDir = (
  moduleId: string,
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(`${getYoloModulesRootDir(settings)}/${moduleId}`)
}

/** Where a module's shipped skill packages are projected as real Vault files. */
export const getYoloModuleSkillsDir = (
  moduleId: string,
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(
    `${getYoloModuleDir(moduleId, settings)}/${YOLO_MODULE_SKILLS_SUBDIR}`,
  )
}

export const getYoloJsonDbRootDir = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(`${getYoloBaseDir(settings)}/${YOLO_JSON_DB_DIR_NAME}`)
}

export const getYoloUserDataRootDir = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(`${getYoloBaseDir(settings)}/${YOLO_USER_DATA_DIR_NAME}`)
}

/** True when `value` is the user-data root itself or lives inside it. */
export const isWithinYoloUserDataRoot = (
  value: string,
  settings?: YoloSettingsLike | null,
): boolean => {
  const root = getYoloUserDataRootDir(settings)
  const normalized = normalizePath(value)
  return normalized === root || normalized.startsWith(`${root}/`)
}

/** Cleanup-only path for the retired PGlite vector store's tarball snapshot; see the file name's own doc comment. */
export const getLegacyYoloVectorDbArchivePath = (
  settings?: YoloSettingsLike | null,
): string => {
  return normalizePath(
    `${getYoloBaseDir(settings)}/${LEGACY_YOLO_VECTOR_DB_ARCHIVE_FILE_NAME}`,
  )
}

// The vault-stored `data.json` mirror sits under `yolo.baseDir` for UX
// consistency with other plugin files (`.yolo_json_db`; the vector store
// itself is IndexedDB-backed and has no vault-file counterpart — see
// `src/database/vector-store/`). A sibling pointer file at vault root
// (`.yolo_sync`) records where this path is, so other devices can locate the
// mirror without needing the synced `baseDir` value upfront — breaking the
// bootstrap circular dependency.
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
