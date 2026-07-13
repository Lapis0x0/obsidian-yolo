import { App, normalizePath } from 'obsidian'

import {
  DEFAULT_YOLO_BASE_DIR,
  YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME,
  YOLO_LEARNING_SRS_DIR_NAME,
  getLegacyJsonDbRootDir,
  getLegacyVectorDbPath,
  getYoloBaseDir,
  getYoloDataJsonPath,
  getYoloJsonDbRootDir,
  getYoloSyncPointerPath,
  getYoloVectorDbPath,
} from './yoloPaths'

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
      await app.vault.adapter.rmdir(path, false)
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

const removeDirIfEmpty = async (app: App, path: string): Promise<void> => {
  if (!(await app.vault.adapter.exists(path))) return
  const stat = await app.vault.adapter.stat(path)
  if (stat?.type !== 'folder') return
  const listing = await app.vault.adapter.list(path)
  if (listing.files.length === 0 && listing.folders.length === 0) {
    await app.vault.adapter.rmdir(path, false)
  }
}

const copyJsonDirectory = async (
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
    const content = await app.vault.adapter.read(filePath)
    await app.vault.adapter.write(targetPath, content)
  }

  for (const folderPath of listing.folders) {
    const relativePath = folderPath.slice(sourceDir.length + 1)
    const nextTargetDir = normalizePath(`${targetDir}/${relativePath}`)
    await copyJsonDirectory(app, folderPath, nextTargetDir)
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
  await app.vault.adapter.rmdir(rootDir, false)
}

const migrateJsonDirectory = async (
  app: App,
  sourceDir: string,
  targetDir: string,
): Promise<void> => {
  try {
    await copyJsonDirectory(app, sourceDir, targetDir)
  } catch (error) {
    await cleanupJsonDirectory(app, targetDir)
    throw error
  }

  await cleanupJsonDirectory(app, sourceDir)
}

const migrateBinaryFile = async (
  app: App,
  sourcePath: string,
  targetPath: string,
): Promise<void> => {
  try {
    const content = await app.vault.adapter.readBinary(sourcePath)
    await ensureParentDir(app, targetPath)
    await app.vault.adapter.writeBinary(targetPath, content)
  } catch (error) {
    await removePathIfExists(app, targetPath)
    throw error
  }

  await removePathIfExists(app, sourcePath)
}

const mergeBinaryFile = async (
  app: App,
  sourcePath: string,
  targetPath: string,
): Promise<void> => {
  await ensureParentDir(app, targetPath)
  if (await app.vault.adapter.exists(targetPath)) {
    await removePathIfExists(app, sourcePath)
    return
  }
  await migrateBinaryFile(app, sourcePath, targetPath)
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

export const ensureLearningJsonDbRootDir = async (
  app: App,
  settings: YoloSettingsLike | null,
): Promise<string> => {
  const sourceBaseDir = DEFAULT_YOLO_BASE_DIR
  const sourceRoot = getYoloJsonDbRootDir({
    yolo: { baseDir: sourceBaseDir },
  })
  const requestedTargetRoot = getYoloJsonDbRootDir(settings)
  if (requestedTargetRoot.startsWith(`${sourceRoot}/`)) {
    throw new Error(
      `YOLO base directory cannot be nested inside managed data: ${requestedTargetRoot}`,
    )
  }
  const targetRoot = await ensureJsonDbRootDir(app, settings)
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
  await removeDirIfEmpty(app, sourceRoot)
  await removeDirIfEmpty(app, sourceBaseDir)
  if (await app.vault.adapter.exists(markerPath)) {
    await app.vault.adapter.remove(markerPath)
  }
  return targetRoot
}

export const ensureVectorDbPath = async (
  app: App,
  settings: YoloSettingsLike | null,
): Promise<string> => {
  await ensureDir(app, getYoloBaseDir(settings))
  const targetPath = getYoloVectorDbPath(settings)
  if (await app.vault.adapter.exists(targetPath)) {
    return targetPath
  }

  const legacyPath = getLegacyVectorDbPath()
  if (!(await app.vault.adapter.exists(legacyPath))) {
    return targetPath
  }

  try {
    await migrateBinaryFile(app, legacyPath, targetPath)
    return targetPath
  } catch (error) {
    console.warn(
      `[YOLO] Failed to migrate vector database from "${legacyPath}" to "${targetPath}", fallback to legacy location.`,
      error,
    )
    return legacyPath
  }
}

const relocateJsonDbRootDir = async ({
  app,
  sourceCandidates,
  targetDir,
}: {
  app: App
  sourceCandidates: string[]
  targetDir: string
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
      await mergeJsonDirectory(app, sourceDir, targetDir)
    } else {
      await migrateJsonDirectory(app, sourceDir, targetDir)
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

const relocateVectorDbFile = async ({
  app,
  sourceCandidates,
  targetPath,
}: {
  app: App
  sourceCandidates: string[]
  targetPath: string
}): Promise<boolean> => {
  const sourcePath = await findFirstExistingPath(
    app,
    sourceCandidates.filter((candidate) => candidate !== targetPath),
  )
  if (!sourcePath) {
    return true
  }

  try {
    await mergeBinaryFile(app, sourcePath, targetPath)
    return true
  } catch (error) {
    console.warn(
      `[YOLO] Failed to relocate vector database from "${sourcePath}" to "${targetPath}".`,
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
  const currentVectorPath = getYoloVectorDbPath(fromSettings)
  const targetJsonDir = getYoloJsonDbRootDir(toSettings)
  const targetVectorPath = getYoloVectorDbPath(toSettings)
  if (targetJsonDir.startsWith(`${currentJsonDir}/`)) {
    console.warn(
      `[YOLO] Refusing to relocate managed data into its own source tree: "${targetJsonDir}".`,
    )
    return false
  }

  await ensureDir(app, getYoloBaseDir(toSettings))
  const sourceJsonCandidates = [currentJsonDir, getLegacyJsonDbRootDir()]
  const sourceVectorCandidates = [currentVectorPath, getLegacyVectorDbPath()]

  const jsonSucceeded = await relocateJsonDbRootDir({
    app,
    sourceCandidates: sourceJsonCandidates,
    targetDir: targetJsonDir,
  })
  if (!jsonSucceeded) {
    return false
  }

  const vectorSucceeded = await relocateVectorDbFile({
    app,
    sourceCandidates: sourceVectorCandidates,
    targetPath: targetVectorPath,
  })
  if (!vectorSucceeded) {
    const rolledBackJson = await relocateJsonDbRootDir({
      app,
      sourceCandidates: [targetJsonDir],
      targetDir: getYoloJsonDbRootDir(fromSettings),
    })
    if (!rolledBackJson) {
      console.warn(
        `[YOLO] Failed to roll back chat storage after vector relocation failed. Source root: "${targetJsonDir}".`,
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
