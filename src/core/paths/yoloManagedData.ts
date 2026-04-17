import { App, normalizePath } from 'obsidian'

import {
  getLegacyJsonDbRootDir,
  getLegacyVectorDbPath,
  getYoloBaseDir,
  getYoloDataJsonPath,
  getYoloJsonDbRootDir,
  getYoloVectorDbPath,
} from './yoloPaths'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
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

export const ensureJsonDbRootDir = async (
  app: App,
  settings?: YoloSettingsLike | null,
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

export const ensureVectorDbPath = async (
  app: App,
  settings?: YoloSettingsLike | null,
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

const relocateDataJsonFile = async ({
  app,
  sourcePath,
  targetPath,
}: {
  app: App
  sourcePath: string
  targetPath: string
}): Promise<boolean> => {
  if (sourcePath === targetPath) {
    return true
  }
  if (!(await app.vault.adapter.exists(sourcePath))) {
    return true
  }

  try {
    await ensureParentDir(app, targetPath)
    if (await app.vault.adapter.exists(targetPath)) {
      // Target already has data — keep target, drop source to avoid overwriting.
      await removePathIfExists(app, sourcePath)
      return true
    }
    const content = await app.vault.adapter.read(sourcePath)
    await app.vault.adapter.write(targetPath, content)
    await removePathIfExists(app, sourcePath)
    return true
  } catch (error) {
    console.warn(
      `[YOLO] Failed to relocate data.json from "${sourcePath}" to "${targetPath}".`,
      error,
    )
    return false
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
  await ensureDir(app, getYoloBaseDir(toSettings))
  const sourceJsonCandidates = [
    getYoloJsonDbRootDir(fromSettings),
    getLegacyJsonDbRootDir(),
  ]
  const sourceVectorCandidates = [
    getYoloVectorDbPath(fromSettings),
    getLegacyVectorDbPath(),
  ]
  const targetJsonDir = getYoloJsonDbRootDir(toSettings)
  const targetVectorPath = getYoloVectorDbPath(toSettings)

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

  // When the YOLO base dir changes, also move the optional vault-stored
  // `data.json` mirror (used by the experimental `storeDataInVault` option).
  // A failure here is non-fatal — the mirror is best-effort.
  const sourceDataJsonPath = getYoloDataJsonPath(fromSettings)
  const targetDataJsonPath = getYoloDataJsonPath(toSettings)
  await relocateDataJsonFile({
    app,
    sourcePath: sourceDataJsonPath,
    targetPath: targetDataJsonPath,
  })

  return true
}

/**
 * Reads the vault-stored `data.json` mirror, if it exists. Returns null when
 * the file is missing or cannot be parsed as JSON.
 */
export const readVaultDataJson = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<Record<string, unknown> | null> => {
  const path = getYoloDataJsonPath(settings)
  if (!(await app.vault.adapter.exists(path))) {
    return null
  }
  try {
    const raw = await app.vault.adapter.read(path)
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch (error) {
    console.warn(
      `[YOLO] Failed to read vault data.json at "${path}"; falling back to plugin data.`,
      error,
    )
    return null
  }
}

/**
 * Writes settings to the vault-stored `data.json` mirror. Returns true on
 * success; failures are non-fatal and logged.
 */
export const writeVaultDataJson = async (
  app: App,
  settings: YoloSettingsLike | null,
  data: unknown,
): Promise<boolean> => {
  const path = getYoloDataJsonPath(settings)
  try {
    await ensureDir(app, getYoloBaseDir(settings))
    await app.vault.adapter.write(path, JSON.stringify(data, null, 2))
    return true
  } catch (error) {
    console.warn(`[YOLO] Failed to write vault data.json at "${path}".`, error)
    return false
  }
}

/**
 * Removes the vault-stored `data.json` mirror if present. Returns true when
 * the file is absent after the call.
 */
export const removeVaultDataJson = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<boolean> => {
  const path = getYoloDataJsonPath(settings)
  if (!(await app.vault.adapter.exists(path))) {
    return true
  }
  try {
    await app.vault.adapter.remove(path)
    return true
  } catch (error) {
    console.warn(`[YOLO] Failed to remove vault data.json at "${path}".`, error)
    return false
  }
}
