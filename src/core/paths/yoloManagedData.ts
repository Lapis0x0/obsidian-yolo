import { App, normalizePath } from 'obsidian'

import { CHAT_DIR } from '../../database/json/constants'

import { removeDirIfEmpty } from './vaultFs'
import {
  DEFAULT_YOLO_BASE_DIR,
  YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME,
  YOLO_COMPONENT_INTENT_DIR_NAME,
  YOLO_LEARNING_SRS_DIR_NAME,
  YOLO_MODULE_INTENT_DIR_NAME,
  YOLO_MODULE_SETTINGS_DIR_NAME,
  getLegacyJsonDbRootDir,
  getYoloBaseDir,
  getYoloDataJsonPath,
  getYoloJsonDbRootDir,
  getYoloSyncPointerPath,
  getYoloUserDataRootDir,
} from './yoloPaths'

/**
 * Top-level subdirectories that must survive vault sync, migrated from the
 * hidden `.yolo_json_db` root into the visible `data/` root by
 * `ensureUserDataRootDir`. Device-local runtime state (CLI session index,
 * model catalog, external agent tasks) deliberately stays out of this list —
 * see `YOLO_JSON_DB_DIR_NAME`'s doc comment in `yoloPaths.ts`.
 */
export const YOLO_USER_DATA_SUBDIR_NAMES = [
  CHAT_DIR,
  YOLO_LEARNING_SRS_DIR_NAME,
  YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME,
  YOLO_MODULE_SETTINGS_DIR_NAME,
  YOLO_MODULE_INTENT_DIR_NAME,
  YOLO_COMPONENT_INTENT_DIR_NAME,
] as const

/**
 * Chat subdirectories left behind by removed features: the timeline height
 * cache (superseded by the chat history window) and the progress cache of the
 * deleted `delegate_external_agent` tool. Nothing writes them any more, but
 * they were never cleaned up automatically — a long-running vault can hold
 * thousands of dead ~1KB files (one per conversation ever opened, including
 * deleted ones). Dropped on every startup before the migration runs so they
 * are never carried into the visible `data/` root, where Obsidian would index
 * them for good.
 */
const LEGACY_CHAT_CACHE_DIR_NAMES = [
  'timeline_height_cache',
  'external_agent_progress',
] as const

export type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

type TextTransform = (
  content: string,
  sourcePath: string,
  targetPath: string,
) => string

type LearningMigrationFile = {
  sourcePath: string
  targetPath: string
}

type LearningMigrationManifest = {
  version: 1
  sourceRoot: string
  targetRoot: string
  files: LearningMigrationFile[]
}

const LEARNING_PATH_MIGRATION_MARKER = '.learning-path-migration-v1'

export const YOLO_DATA_META_KEY = '__meta'

export type YoloDataMeta = {
  updatedAt: number
  deviceId: string
}

export type YoloDataReadResult = {
  raw: Record<string, unknown>
  meta: YoloDataMeta | null
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export const extractYoloDataMeta = (
  raw: unknown,
): YoloDataReadResult | null => {
  if (!isPlainObject(raw)) {
    return null
  }
  const candidate = raw[YOLO_DATA_META_KEY]
  let meta: YoloDataMeta | null = null
  if (
    isPlainObject(candidate) &&
    typeof candidate.updatedAt === 'number' &&
    typeof candidate.deviceId === 'string'
  ) {
    meta = {
      updatedAt: candidate.updatedAt,
      deviceId: candidate.deviceId,
    }
  }
  // Strip meta key from a shallow copy so callers can parse settings cleanly.
  const { [YOLO_DATA_META_KEY]: _ignored, ...rest } = raw
  return { raw: rest, meta }
}

export const stampYoloDataMeta = (
  data: unknown,
  meta: YoloDataMeta,
): Record<string, unknown> => {
  const base = isPlainObject(data) ? { ...data } : {}
  base[YOLO_DATA_META_KEY] = meta
  return base
}

const ensureDir = async (app: App, dirPath: string): Promise<void> => {
  try {
    await app.vault.adapter.mkdir(dirPath)
  } catch (error) {
    if (await app.vault.adapter.exists(dirPath)) {
      return
    }
    throw error
  }
}

const ensureParentDir = async (app: App, targetPath: string): Promise<void> => {
  const normalized = normalizePath(targetPath)
  const slashIndex = normalized.lastIndexOf('/')
  if (slashIndex <= 0) {
    return
  }
  await ensureDir(app, normalized.slice(0, slashIndex))
}

const removePathIfExists = async (app: App, path: string): Promise<void> => {
  if (!(await app.vault.adapter.exists(path))) {
    return
  }
  try {
    const stat = await app.vault.adapter.stat(path)
    if (stat?.type === 'folder') {
      // A directory that still has content stays in place: a merge may have
      // deliberately kept files for the next launch to retry, and warning on
      // every periodic cleanup pass would be pure noise.
      await removeDirIfEmpty(app.vault.adapter, path)
      return
    }
    await app.vault.adapter.remove(path)
  } catch (error) {
    console.warn(
      `[YOLO] Failed to remove path "${path}" after migration`,
      error,
    )
  }
}

const copyJsonDirectory = async (
  app: App,
  sourceDir: string,
  targetDir: string,
  transform?: TextTransform,
): Promise<void> => {
  await ensureDir(app, targetDir)
  const listing = await app.vault.adapter.list(sourceDir)

  for (const filePath of listing.files) {
    const relativePath = filePath.slice(sourceDir.length + 1)
    const targetPath = normalizePath(`${targetDir}/${relativePath}`)
    await ensureParentDir(app, targetPath)
    const content = await app.vault.adapter.read(filePath)
    const finalContent = transform
      ? transform(content, filePath, targetPath)
      : content
    await app.vault.adapter.write(targetPath, finalContent)
  }

  for (const folderPath of listing.folders) {
    const relativePath = folderPath.slice(sourceDir.length + 1)
    const nextTargetDir = normalizePath(`${targetDir}/${relativePath}`)
    await copyJsonDirectory(app, folderPath, nextTargetDir, transform)
  }
}

const mergeJsonDirectory = async (
  app: App,
  sourceDir: string,
  targetDir: string,
): Promise<void> => {
  await ensureDir(app, targetDir)
  const listing = await app.vault.adapter.list(sourceDir)

  for (const filePath of listing.files) {
    const relativePath = filePath.slice(sourceDir.length + 1)
    const targetPath = normalizePath(`${targetDir}/${relativePath}`)
    await ensureParentDir(app, targetPath)
    if (await app.vault.adapter.exists(targetPath)) {
      await removePathIfExists(app, filePath)
      continue
    }
    const content = await app.vault.adapter.read(filePath)
    await app.vault.adapter.write(targetPath, content)
    await removePathIfExists(app, filePath)
  }

  for (const folderPath of listing.folders) {
    const relativePath = folderPath.slice(sourceDir.length + 1)
    const nextTargetDir = normalizePath(`${targetDir}/${relativePath}`)
    await mergeJsonDirectory(app, folderPath, nextTargetDir)
  }

  await removePathIfExists(app, sourceDir)
}

/**
 * Recursively merges `sourceDir` into `targetDir`, keeping whichever copy of
 * a same-named file is newer (`adapter.stat().mtime`). This is the self-heal
 * path for a mixed-version device fleet: an older plugin build may still
 * write to the hidden `.yolo_json_db` root, and a sync tool can replicate
 * that write to a device that has already migrated to the visible `data/`
 * root. Blindly preferring the already-migrated target (as the plain
 * `mergeJsonDirectory` above does for the baseDir-relocation case) would
 * silently drop that newer write, which is unacceptable for user data.
 *
 * Safety matches the existing copy-then-cleanup convention: a source file is
 * only removed once its content (or the already-newer target content) is
 * confirmed to be the thing left standing. If this throws partway through, no
 * source file that hasn't been processed yet has been touched, so the caller
 * can safely retry on the next launch without any risk of data loss.
 *
 * `transform`, when given, rewrites a file's content before it's written to
 * `targetPath` (see `rewriteAnkiJournalSrsPath`'s callers) — used to keep an
 * Anki import journal's recorded `srsPath` pointing at wherever its SRS
 * sidecar actually ends up after this same move.
 */
const mergeJsonDirectoryPreferNewer = async (
  app: App,
  sourceDir: string,
  targetDir: string,
  transform?: TextTransform,
): Promise<void> => {
  await ensureDir(app, targetDir)
  const listing = await app.vault.adapter.list(sourceDir)

  for (const filePath of listing.files) {
    const relativePath = filePath.slice(sourceDir.length + 1)
    const targetPath = normalizePath(`${targetDir}/${relativePath}`)
    await ensureParentDir(app, targetPath)

    // Captured once and reused as the TOCTOU baseline below: re-reading it
    // right before deleting the source lets us detect a rewrite that landed
    // *during* this merge (e.g. a sync tool flushing a write mid-migration).
    const sourceStatBefore = await app.vault.adapter.stat(filePath)

    // Deletes the source file only if it is still exactly what
    // `sourceStatBefore` observed. If a sync tool touched it in the window
    // between that stat and now, its newer content would otherwise be lost
    // (the copy already made, or the decision to keep target, would both
    // predate that write) — skip the delete and let the next launch's merge
    // pick it up instead of dropping data.
    const safeRemoveSource = async (): Promise<void> => {
      const sourceStatNow = await app.vault.adapter.stat(filePath)
      if (
        (sourceStatNow?.mtime ?? null) !== (sourceStatBefore?.mtime ?? null)
      ) {
        return
      }
      await removePathIfExists(app, filePath)
    }

    if (await app.vault.adapter.exists(targetPath)) {
      const targetStat = await app.vault.adapter.stat(targetPath)
      const sourceIsNewer =
        (sourceStatBefore?.mtime ?? 0) > (targetStat?.mtime ?? 0)
      if (!sourceIsNewer) {
        // Equal mtimes intentionally fall here too: a real concurrent edit
        // on both sides can't be arbitrated at the file layer, so target
        // simply wins — same as it always has for this comparison.
        await safeRemoveSource()
        continue
      }
    }

    const content = await app.vault.adapter.read(filePath)
    const finalContent = transform
      ? transform(content, filePath, targetPath)
      : content
    await app.vault.adapter.write(targetPath, finalContent)
    await safeRemoveSource()
  }

  for (const folderPath of listing.folders) {
    const relativePath = folderPath.slice(sourceDir.length + 1)
    const nextTargetDir = normalizePath(`${targetDir}/${relativePath}`)
    await mergeJsonDirectoryPreferNewer(
      app,
      folderPath,
      nextTargetDir,
      transform,
    )
  }

  await removePathIfExists(app, sourceDir)
}

const copyTextDirectoryReplacing = async (
  app: App,
  sourceDir: string,
  targetDir: string,
  transform: TextTransform = (content) => content,
): Promise<LearningMigrationFile[]> => {
  await ensureDir(app, targetDir)
  const listing = await app.vault.adapter.list(sourceDir)
  const copied: LearningMigrationFile[] = []

  for (const filePath of listing.files) {
    const relativePath = filePath.slice(sourceDir.length + 1)
    const targetPath = normalizePath(`${targetDir}/${relativePath}`)
    await ensureParentDir(app, targetPath)
    const content = transform(
      await app.vault.adapter.read(filePath),
      filePath,
      targetPath,
    )
    await app.vault.adapter.write(targetPath, content)
    copied.push({ sourcePath: filePath, targetPath })
  }

  for (const folderPath of listing.folders) {
    const relativePath = folderPath.slice(sourceDir.length + 1)
    copied.push(
      ...(await copyTextDirectoryReplacing(
        app,
        folderPath,
        normalizePath(`${targetDir}/${relativePath}`),
        transform,
      )),
    )
  }

  return copied
}

const cleanupJsonDirectory = async (
  app: App,
  rootDir: string,
): Promise<void> => {
  if (!(await app.vault.adapter.exists(rootDir))) {
    return
  }
  const listing = await app.vault.adapter.list(rootDir)
  for (const filePath of listing.files) {
    await removePathIfExists(app, filePath)
  }
  for (const folderPath of listing.folders) {
    await cleanupJsonDirectory(app, folderPath)
  }
  await removePathIfExists(app, rootDir)
}

const cleanupDirectoryStrict = async (
  app: App,
  rootDir: string,
): Promise<void> => {
  if (!(await app.vault.adapter.exists(rootDir))) return
  const listing = await app.vault.adapter.list(rootDir)
  for (const filePath of listing.files) {
    await app.vault.adapter.remove(filePath)
  }
  for (const folderPath of listing.folders) {
    await cleanupDirectoryStrict(app, folderPath)
  }
  // Non-recursive rmdir rejects every directory on Obsidian 1.13+ (see
  // vaultFs.ts); the directory was just drained, so a recursive delete
  // removes exactly the empty shell.
  await app.vault.adapter.rmdir(rootDir, true)
}

const migrateJsonDirectory = async (
  app: App,
  sourceDir: string,
  targetDir: string,
  transform?: TextTransform,
): Promise<void> => {
  try {
    await copyJsonDirectory(app, sourceDir, targetDir, transform)
  } catch (error) {
    await cleanupJsonDirectory(app, targetDir)
    throw error
  }

  await cleanupJsonDirectory(app, sourceDir)
}

const findFirstExistingPath = async (
  app: App,
  candidates: string[],
): Promise<string | null> => {
  for (const candidate of candidates) {
    if (await app.vault.adapter.exists(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * Settings are required at write boundaries so vault data can never silently
 * fall back to the default YOLO root when a caller forgets user configuration.
 */
export const ensureJsonDbRootDir = async (
  app: App,
  settings: YoloSettingsLike | null,
): Promise<string> => {
  await ensureDir(app, getYoloBaseDir(settings))
  const targetDir = getYoloJsonDbRootDir(settings)
  if (await app.vault.adapter.exists(targetDir)) {
    return targetDir
  }

  const legacyDir = getLegacyJsonDbRootDir()
  if (!(await app.vault.adapter.exists(legacyDir))) {
    return targetDir
  }

  try {
    await migrateJsonDirectory(app, legacyDir, targetDir)
    return targetDir
  } catch (error) {
    console.warn(
      `[YOLO] Failed to migrate chat storage from "${legacyDir}" to "${targetDir}", fallback to legacy location.`,
      error,
    )
    return legacyDir
  }
}

/**
 * Ensures `<baseDir>/data` (the visible, sync-friendly root for user data —
 * see `YOLO_USER_DATA_SUBDIR_NAMES`) exists and holds the latest copy of
 * every managed subdirectory that a mixed-version device fleet may have left
 * behind under the hidden `.yolo_json_db` root.
 *
 * Runs on every startup. When nothing needs migrating (the common case after
 * the first successful run) this is a handful of cheap `exists()` checks.
 *
 * Each subdirectory is migrated independently and failures are isolated: if
 * one subdirectory's merge throws (e.g. a transient I/O error), the
 * unmigrated files are left completely untouched at their old hidden-root
 * location (see `mergeJsonDirectoryPreferNewer`'s safety contract) and the
 * next launch retries automatically — the caller still gets the visible root
 * back so every *other* already-migrated subdirectory keeps working. Only a
 * hard failure to prepare the root folder itself falls back to the legacy
 * hidden root wholesale, mirroring `ensureJsonDbRootDir`.
 */
// Deduplicates concurrent calls for the same (app, userDataRoot) pair — the
// host startup call in `main.ts` and a user-data store's lazy first-touch
// `prepareDataDir` can both fire around the same time, and running the same
// migration twice in parallel would race on the same files. Keyed by the
// resolved root path (not settings identity) so callers with equivalent
// settings share one in-flight run; cleared once that run settles so a later
// call (a real subsequent launch, or after `baseDir` changes) starts fresh.
const inFlightUserDataRootMigrations = new WeakMap<
  App,
  Map<string, Promise<string>>
>()

export const ensureUserDataRootDir = async (
  app: App,
  settings: YoloSettingsLike | null,
): Promise<string> => {
  const rootKey = getYoloUserDataRootDir(settings)
  let byRoot = inFlightUserDataRootMigrations.get(app)
  if (!byRoot) {
    byRoot = new Map()
    inFlightUserDataRootMigrations.set(app, byRoot)
  }
  const inFlight = byRoot.get(rootKey)
  if (inFlight) {
    return inFlight
  }

  const promise = ensureUserDataRootDirUnlocked(app, settings).finally(() => {
    if (byRoot?.get(rootKey) === promise) {
      byRoot.delete(rootKey)
    }
  })
  byRoot.set(rootKey, promise)
  return promise
}

/**
 * Drops the dead cache directories listed in `LEGACY_CHAT_CACHE_DIR_NAMES`
 * from one chat root. Runs against both the hidden and the visible root: a
 * device that already migrated has them under the visible root, one that has
 * not still has them under the hidden one.
 *
 * Failures are swallowed — this is opportunistic cleanup and must never block
 * the migration that follows it.
 */
const removeLegacyChatCacheDirs = async (
  app: App,
  root: string,
): Promise<void> => {
  for (const dirName of LEGACY_CHAT_CACHE_DIR_NAMES) {
    const path = normalizePath(`${root}/${CHAT_DIR}/${dirName}`)
    try {
      if (await app.vault.adapter.exists(path)) {
        await app.vault.adapter.rmdir(path, true)
      }
    } catch (error) {
      console.warn(`[YOLO] Failed to remove legacy cache dir "${path}".`, error)
    }
  }
}

/**
 * Moves one managed subdirectory from the hidden root to the visible one.
 *
 * A whole-tree `rename` is one filesystem operation regardless of file count,
 * where the per-file merge costs ~10 adapter round-trips each. That gap is
 * what makes the difference load-bearing on mobile: during `onload` every
 * round-trip competes with Obsidian's cold-start vault indexing and measures
 * ~830ms instead of the ~17ms it takes once the app is idle, so a vault with a
 * few thousand chat files blocks plugin startup for tens of minutes. The same
 * tree renames in a single ~2.8s call.
 *
 * The fast path is only safe when the target is absent (`rename` rejects an
 * existing destination on both desktop and mobile rather than merging into it)
 * and when no `transform` is needed, since rewriting file contents requires
 * reading them. Everything else falls through to the merge, which stays the
 * authority on conflict resolution.
 */
const migrateUserDataSubdir = async (
  app: App,
  sourceDir: string,
  targetDir: string,
  transform: TextTransform | undefined,
): Promise<void> => {
  if (!transform && !(await app.vault.adapter.exists(targetDir))) {
    try {
      await app.vault.adapter.rename(sourceDir, targetDir)
      return
    } catch (error) {
      // The target may have appeared between the check above and the rename
      // (a sync tool landing the directory), or this adapter may not support
      // renaming a folder at all — `DataAdapter.rename` promises neither
      // atomicity nor a defined post-failure state. Re-read what is actually
      // on disk instead of assuming nothing happened: a vanished source means
      // the rename did take effect, and anything else is handed to the merge,
      // which already reconciles a partially populated target by mtime.
      console.warn(
        `[YOLO] Fast-path rename of "${sourceDir}" to "${targetDir}" failed, falling back to per-file merge.`,
        error,
      )
      if (!(await app.vault.adapter.exists(sourceDir))) {
        return
      }
    }
  }

  await mergeJsonDirectoryPreferNewer(app, sourceDir, targetDir, transform)
}

const ensureUserDataRootDirUnlocked = async (
  app: App,
  settings: YoloSettingsLike | null,
): Promise<string> => {
  const jsonDbRoot = await ensureJsonDbRootDir(app, settings)
  const userDataRoot = getYoloUserDataRootDir(settings)

  try {
    await ensureDir(app, userDataRoot)
  } catch (error) {
    console.warn(
      `[YOLO] Failed to prepare user data root "${userDataRoot}", fallback to legacy managed data location.`,
      error,
    )
    return jsonDbRoot
  }

  // Before the migration, so the dead files are deleted in place instead of
  // being carried into the visible root first.
  await removeLegacyChatCacheDirs(app, jsonDbRoot)
  await removeLegacyChatCacheDirs(app, userDataRoot)

  for (const subdirName of YOLO_USER_DATA_SUBDIR_NAMES) {
    const sourceDir = normalizePath(`${jsonDbRoot}/${subdirName}`)
    if (!(await app.vault.adapter.exists(sourceDir))) {
      continue
    }
    const targetDir = normalizePath(`${userDataRoot}/${subdirName}`)
    // Anki import journals pin an absolute `srsPath` to their SRS sidecar
    // (see `rewriteAnkiJournalSrsPath`'s doc comment) — moving the journal
    // without rewriting that field would leave it pointing at the
    // now-vacated hidden root. A leftover `phase: 'verified'` journal in
    // that state makes `recoverAnkiImports` (in the Learning module) treat
    // an already-successful import as failed and delete everything it
    // created — this rewrite is what prevents that.
    const transform: TextTransform | undefined =
      subdirName === YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME
        ? (content) =>
            rewriteAnkiJournalSrsPath(content, jsonDbRoot, userDataRoot)
        : undefined
    try {
      await migrateUserDataSubdir(app, sourceDir, targetDir, transform)
    } catch (error) {
      console.warn(
        `[YOLO] Failed to migrate "${sourceDir}" to "${targetDir}"; will retry on next launch.`,
        error,
      )
    }
  }

  return userDataRoot
}

const rewriteAnkiJournalSrsPath = (
  content: string,
  sourceRoot: string,
  targetRoot: string,
): string => {
  try {
    const journal = JSON.parse(content) as Record<string, unknown>
    const sourcePrefix = `${sourceRoot}/${YOLO_LEARNING_SRS_DIR_NAME}/`
    if (
      typeof journal.srsPath === 'string' &&
      journal.srsPath.startsWith(sourcePrefix)
    ) {
      journal.srsPath = `${targetRoot}/${YOLO_LEARNING_SRS_DIR_NAME}/${journal.srsPath.slice(sourcePrefix.length)}`
      return JSON.stringify(journal, null, 2)
    }
  } catch {
    // Recovery will report malformed journals; migration must preserve them.
  }
  return content
}

/**
 * Builds a `TextTransform` that applies `rewriteAnkiJournalSrsPath` only to
 * files under the Anki import journal subdirectory, leaving every other
 * moved file (chats, module settings/intent, the SRS files themselves)
 * untouched. Used when relocating the whole visible user-data root at once
 * (`relocateYoloManagedData`), where a single recursive copy/merge walks
 * every subdirectory together and can't otherwise tell them apart.
 */
const makeAnkiJournalSrsPathTransform = (
  sourceRoot: string,
  targetRoot: string,
): TextTransform => {
  const journalDirPrefix = `${sourceRoot}/${YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME}/`
  return (content, sourcePath) =>
    sourcePath.startsWith(journalDirPrefix)
      ? rewriteAnkiJournalSrsPath(content, sourceRoot, targetRoot)
      : content
}

const parseLearningMigrationManifest = (
  content: string,
  sourceRoot: string,
  targetRoot: string,
): LearningMigrationManifest => {
  const value = JSON.parse(content) as Partial<LearningMigrationManifest>
  const sourcePrefixes = [
    `${sourceRoot}/${YOLO_LEARNING_SRS_DIR_NAME}/`,
    `${sourceRoot}/${YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME}/`,
  ]
  if (
    value.version !== 1 ||
    value.sourceRoot !== sourceRoot ||
    value.targetRoot !== targetRoot ||
    !Array.isArray(value.files) ||
    value.files.some(
      (file) =>
        !file ||
        typeof file.sourcePath !== 'string' ||
        typeof file.targetPath !== 'string' ||
        !sourcePrefixes.some((prefix) => file.sourcePath.startsWith(prefix)) ||
        !file.targetPath.startsWith(`${targetRoot}/`),
    )
  ) {
    throw new Error(`Invalid learning path migration marker: ${targetRoot}`)
  }
  return value as LearningMigrationManifest
}

const restoreMissingMigrationTargets = async (
  app: App,
  manifest: LearningMigrationManifest,
): Promise<void> => {
  const journalPrefix = `${manifest.sourceRoot}/${YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME}/`
  for (const file of manifest.files) {
    if (await app.vault.adapter.exists(file.targetPath)) continue
    if (!(await app.vault.adapter.exists(file.sourcePath))) {
      throw new Error(
        `Learning migration lost both source and target: ${file.targetPath}`,
      )
    }
    await ensureParentDir(app, file.targetPath)
    const sourceContent = await app.vault.adapter.read(file.sourcePath)
    const content = file.sourcePath.startsWith(journalPrefix)
      ? rewriteAnkiJournalSrsPath(
          sourceContent,
          manifest.sourceRoot,
          manifest.targetRoot,
        )
      : sourceContent
    await app.vault.adapter.write(file.targetPath, content)
  }
}

/**
 * NOTE: not currently called from any runtime path. Learning became an
 * independent module (`modules/learning/`) that resolves its own storage
 * root directly from the current `baseDir` (see
 * `modules/learning/src/host/srsStorage.ts`'s `getLocationKey`), so the
 * historical "default baseDir → custom baseDir" bug this function guards
 * against can no longer occur — the module never reads a stale default path.
 * Kept (and adapted to the visible user-data root below) because it is still
 * covered by `yoloManagedData.test.ts`; flagged for a follow-up decision on
 * whether to delete it or wire it back in.
 */
export const ensureLearningJsonDbRootDir = async (
  app: App,
  settings: YoloSettingsLike | null,
): Promise<string> => {
  const sourceBaseDir = DEFAULT_YOLO_BASE_DIR
  const sourceRoot = getYoloJsonDbRootDir({
    yolo: { baseDir: sourceBaseDir },
  })
  const requestedTargetRoot = getYoloUserDataRootDir(settings)
  if (requestedTargetRoot.startsWith(`${sourceRoot}/`)) {
    throw new Error(
      `YOLO base directory cannot be nested inside managed data: ${requestedTargetRoot}`,
    )
  }
  const targetRoot = await ensureUserDataRootDir(app, settings)
  if (sourceRoot === targetRoot) return targetRoot

  await ensureDir(app, targetRoot)
  const markerPath = normalizePath(
    `${targetRoot}/${LEARNING_PATH_MIGRATION_MARKER}`,
  )
  const sourceSrsDir = normalizePath(
    `${sourceRoot}/${YOLO_LEARNING_SRS_DIR_NAME}`,
  )
  const sourceJournalDir = normalizePath(
    `${sourceRoot}/${YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME}`,
  )
  const hasSourceSrs = await app.vault.adapter.exists(sourceSrsDir)
  const hasSourceJournals = await app.vault.adapter.exists(sourceJournalDir)
  const migrationPending = await app.vault.adapter.exists(markerPath)
  let manifest: LearningMigrationManifest

  if ((hasSourceSrs || hasSourceJournals) && !migrationPending) {
    const files: LearningMigrationFile[] = []
    if (hasSourceSrs) {
      files.push(
        ...(await copyTextDirectoryReplacing(
          app,
          sourceSrsDir,
          normalizePath(`${targetRoot}/${YOLO_LEARNING_SRS_DIR_NAME}`),
        )),
      )
    }
    if (hasSourceJournals) {
      files.push(
        ...(await copyTextDirectoryReplacing(
          app,
          sourceJournalDir,
          normalizePath(`${targetRoot}/${YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME}`),
          (content) =>
            rewriteAnkiJournalSrsPath(content, sourceRoot, targetRoot),
        )),
      )
    }
    manifest = { version: 1, sourceRoot, targetRoot, files }
    await app.vault.adapter.write(markerPath, JSON.stringify(manifest, null, 2))
  } else if (migrationPending) {
    manifest = parseLearningMigrationManifest(
      await app.vault.adapter.read(markerPath),
      sourceRoot,
      targetRoot,
    )
  } else {
    return targetRoot
  }

  await restoreMissingMigrationTargets(app, manifest)
  if (hasSourceSrs) await cleanupDirectoryStrict(app, sourceSrsDir)
  if (hasSourceJournals) await cleanupDirectoryStrict(app, sourceJournalDir)
  await removeDirIfEmpty(app.vault.adapter, sourceRoot)
  await removeDirIfEmpty(app.vault.adapter, sourceBaseDir)
  if (await app.vault.adapter.exists(markerPath)) {
    await app.vault.adapter.remove(markerPath)
  }
  return targetRoot
}

const relocateJsonDbRootDir = async ({
  app,
  sourceCandidates,
  targetDir,
  preferNewerMerge = false,
  transform,
}: {
  app: App
  sourceCandidates: string[]
  targetDir: string
  /**
   * Use `mergeJsonDirectoryPreferNewer` instead of the plain, first-wins
   * `mergeJsonDirectory` when `targetDir` already exists. The hidden
   * `.yolo_json_db` root and the vector DB keep the plain merge (unchanged
   * semantics — those aren't exposed to the same mixed-version-fleet risk
   * this was added for); the visible user-data root opts in because a
   * baseDir change on one device shouldn't silently discard a newer write
   * that another device already synced into the target location.
   */
  preferNewerMerge?: boolean
  transform?: TextTransform
}): Promise<boolean> => {
  const sourceDir = await findFirstExistingPath(
    app,
    sourceCandidates.filter((candidate) => candidate !== targetDir),
  )
  if (!sourceDir) {
    return true
  }

  try {
    if (await app.vault.adapter.exists(targetDir)) {
      if (preferNewerMerge) {
        await mergeJsonDirectoryPreferNewer(
          app,
          sourceDir,
          targetDir,
          transform,
        )
      } else {
        await mergeJsonDirectory(app, sourceDir, targetDir)
      }
    } else {
      await migrateJsonDirectory(app, sourceDir, targetDir, transform)
    }
    return true
  } catch (error) {
    console.warn(
      `[YOLO] Failed to relocate chat storage from "${sourceDir}" to "${targetDir}".`,
      error,
    )
    return false
  }
}

// Move the optional vault-stored `data.json` mirror alongside `baseDir`
// changes. Failure is non-fatal — the mirror is best-effort and the next
// successful `writeVaultDataJson` will overwrite the target anyway.
const relocateDataJsonFile = async ({
  app,
  sourcePath,
  targetPath,
}: {
  app: App
  sourcePath: string
  targetPath: string
}): Promise<void> => {
  if (sourcePath === targetPath) {
    return
  }
  if (!(await app.vault.adapter.exists(sourcePath))) {
    return
  }
  try {
    await ensureParentDir(app, targetPath)
    // If target already exists, we still drop source to avoid orphan. The
    // caller (`saveSettings`) invokes `writeVaultDataJson` right after, which
    // overwrites target with the latest in-memory settings — so whatever was
    // at target gets refreshed regardless.
    if (!(await app.vault.adapter.exists(targetPath))) {
      const content = await app.vault.adapter.read(sourcePath)
      await app.vault.adapter.write(targetPath, content)
    }
    await removePathIfExists(app, sourcePath)
  } catch (error) {
    console.warn(
      `[YOLO] Failed to relocate data.json mirror from "${sourcePath}" to "${targetPath}".`,
      error,
    )
  }
}

export const relocateYoloManagedData = async ({
  app,
  fromSettings,
  toSettings,
}: {
  app: App
  fromSettings?: YoloSettingsLike | null
  toSettings?: YoloSettingsLike | null
}): Promise<boolean> => {
  const currentJsonDir = getYoloJsonDbRootDir(fromSettings)
  const currentUserDataDir = getYoloUserDataRootDir(fromSettings)
  const targetJsonDir = getYoloJsonDbRootDir(toSettings)
  const targetUserDataDir = getYoloUserDataRootDir(toSettings)
  if (targetJsonDir.startsWith(`${currentJsonDir}/`)) {
    console.warn(
      `[YOLO] Refusing to relocate managed data into its own source tree: "${targetJsonDir}".`,
    )
    return false
  }
  if (targetUserDataDir.startsWith(`${currentUserDataDir}/`)) {
    console.warn(
      `[YOLO] Refusing to relocate managed data into its own source tree: "${targetUserDataDir}".`,
    )
    return false
  }

  await ensureDir(app, getYoloBaseDir(toSettings))
  const sourceJsonCandidates = [currentJsonDir, getLegacyJsonDbRootDir()]
  const sourceUserDataCandidates = [currentUserDataDir]

  const jsonSucceeded = await relocateJsonDbRootDir({
    app,
    sourceCandidates: sourceJsonCandidates,
    targetDir: targetJsonDir,
  })
  if (!jsonSucceeded) {
    return false
  }

  const userDataSucceeded = await relocateJsonDbRootDir({
    app,
    sourceCandidates: sourceUserDataCandidates,
    targetDir: targetUserDataDir,
    preferNewerMerge: true,
    transform: makeAnkiJournalSrsPathTransform(
      currentUserDataDir,
      targetUserDataDir,
    ),
  })
  if (!userDataSucceeded) {
    const rolledBackJson = await relocateJsonDbRootDir({
      app,
      sourceCandidates: [targetJsonDir],
      targetDir: getYoloJsonDbRootDir(fromSettings),
    })
    if (!rolledBackJson) {
      console.warn(
        `[YOLO] Failed to roll back chat storage after user data relocation failed. Source root: "${targetJsonDir}".`,
      )
    }
    return false
  }

  // Move the optional vault-stored mirror alongside baseDir changes. The
  // pointer file is updated by the subsequent `writeVaultDataJson` call in
  // `saveSettings` (if the feature is on); if the feature is off, a stale
  // pointer may remain — that's fine, `readVaultDataJson` gracefully returns
  // null when the pointer target is missing.
  await relocateDataJsonFile({
    app,
    sourcePath: getYoloDataJsonPath(fromSettings),
    targetPath: getYoloDataJsonPath(toSettings),
  })

  return true
}

const readPointerDataPath = async (app: App): Promise<string | null> => {
  const pointerPath = getYoloSyncPointerPath()
  if (!(await app.vault.adapter.exists(pointerPath))) {
    return null
  }
  try {
    const raw = await app.vault.adapter.read(pointerPath)
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { dataPath?: unknown }).dataPath === 'string'
    ) {
      return normalizePath((parsed as { dataPath: string }).dataPath)
    }
    return null
  } catch (error) {
    console.warn(
      `[YOLO] Failed to read sync pointer at "${pointerPath}".`,
      error,
    )
    return null
  }
}

/**
 * Reads the vault-stored `data.json` mirror.
 *
 *   - If the pointer FILE EXISTS (regardless of whether its contents
 *     parse), it is authoritative. We try to read what it points to;
 *     any failure (target missing, unreadable, pointer JSON corrupt,
 *     pointer schema invalid) returns null without touching the default
 *     path. Falling back here would risk migrating a stale default
 *     mirror that doesn't correspond to the user's actual `baseDir`.
 *   - Only when the pointer file is ABSENT do we fall back to the
 *     settings-derived default path. This handles the partial legacy
 *     state where a user manually deleted the pointer but the mirror
 *     file still lives at `YOLO/.yolo_data.json`.
 *
 * Used only by the one-time legacy-mirror migration in `main.ts`.
 */
export const readVaultDataJson = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<YoloDataReadResult | null> => {
  const readPath = async (
    candidatePath: string,
  ): Promise<YoloDataReadResult | null> => {
    if (!(await app.vault.adapter.exists(candidatePath))) return null
    try {
      const raw = await app.vault.adapter.read(candidatePath)
      const parsed = JSON.parse(raw) as unknown
      return extractYoloDataMeta(parsed)
    } catch (error) {
      console.warn(
        `[YOLO] Failed to read vault data mirror at "${candidatePath}".`,
        error,
      )
      return null
    }
  }
  const pointerPath = getYoloSyncPointerPath()
  const pointerExists = await app.vault.adapter.exists(pointerPath)
  if (pointerExists) {
    // Pointer file exists: trust it as authoritative. Resolve target
    // path; any failure to do so (corrupt JSON, missing dataPath
    // field, unreadable target) returns null — do NOT fall back.
    const pointerDataPath = await readPointerDataPath(app)
    if (pointerDataPath === null) return null
    return readPath(pointerDataPath)
  }
  // Pointer file is genuinely absent: fall back to the settings-derived
  // default path so partial legacy states are still recoverable.
  return readPath(getYoloDataJsonPath(settings))
}

/**
 * Removes both the pointer file and the data mirror it points to. Falls back
 * to the settings-derived data path when the pointer is missing or invalid,
 * so a stale/partial state still gets cleaned up. Used only by the
 * one-time legacy-mirror migration in `main.ts`; no live code path writes
 * to the mirror anymore.
 */
export const removeVaultDataJson = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<boolean> => {
  const pointerPath = getYoloSyncPointerPath()
  const dataPathFromPointer = await readPointerDataPath(app)
  const dataPath = dataPathFromPointer ?? getYoloDataJsonPath(settings)
  try {
    if (await app.vault.adapter.exists(dataPath)) {
      await app.vault.adapter.remove(dataPath)
    }
    if (await app.vault.adapter.exists(pointerPath)) {
      await app.vault.adapter.remove(pointerPath)
    }
    return true
  } catch (error) {
    console.warn(
      `[YOLO] Failed to remove vault data mirror (pointer="${pointerPath}", data="${dataPath}").`,
      error,
    )
    return false
  }
}
