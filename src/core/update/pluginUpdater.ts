import {
  App,
  type DataAdapter,
  FileSystemAdapter,
  Platform,
  apiVersion,
  normalizePath,
  requestUrl,
} from 'obsidian'

import type YoloPlugin from '../../main'

import {
  RELEASE_FILE_NAMES,
  type ReleaseFileName,
} from './installationIntegrity'
import {
  type ReleaseAssets,
  compareVersions,
  normalizePluginVersion,
} from './updateChecker'

const STAGING_ROOT = '.yolo-update-staging'
const REPAIR_META_FILE = 'repair-meta.json'

const RELEASE_FILES = {
  mainJs: RELEASE_FILE_NAMES.mainJs,
  manifestJson: RELEASE_FILE_NAMES.manifestJson,
  stylesCss: RELEASE_FILE_NAMES.stylesCss,
} as const

type StagedManifest = {
  version: string
  minAppVersion: string
}

export type PluginUpdateState =
  | { status: 'idle' }
  | {
      status: 'downloading'
      version: string
      progress: number
      repairFiles?: ReleaseFileName[]
    }
  | { status: 'ready'; version: string; repairFiles?: ReleaseFileName[] }
  | { status: 'applying'; version: string; repairFiles?: ReleaseFileName[] }
  | {
      status: 'error'
      version: string
      message: string
      repairFiles?: ReleaseFileName[]
    }

type RepairMeta = {
  version: string
  files: ReleaseFileName[]
}

export type RepairStagingStatus =
  | { ready: false }
  | {
      ready: true
      version: string
      files: ReleaseFileName[]
      minAppVersion: string
    }

export type StagingStatus =
  | { ready: false }
  | { ready: true; version: string; minAppVersion: string }

export type ApplyStagedUpdateResult =
  | { ok: true }
  | { ok: false; reason: 'not_ready' | 'min_app_version' | 'write_failed' }

export function canSelfUpdate(plugin: YoloPlugin): boolean {
  if (!Platform.isDesktop) {
    return false
  }
  const adapter = plugin.app.vault.adapter
  if (!(adapter instanceof FileSystemAdapter)) {
    return false
  }
  return Boolean(plugin.manifest.dir)
}

export function getStagingDir(pluginDir: string, version: string): string {
  return normalizePath(`${pluginDir}/${STAGING_ROOT}/${version}`)
}

export function getStagingRoot(pluginDir: string): string {
  return normalizePath(`${pluginDir}/${STAGING_ROOT}`)
}

function parseStagedManifest(raw: string): StagedManifest | null {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown
      minAppVersion?: unknown
    }
    const version =
      typeof parsed.version === 'string' ? parsed.version.trim() : ''
    const minAppVersion =
      typeof parsed.minAppVersion === 'string'
        ? parsed.minAppVersion.trim()
        : ''
    if (!version) {
      return null
    }
    return { version, minAppVersion }
  } catch {
    return null
  }
}

export function meetsMinAppVersion(
  appVersion: string | undefined,
  minAppVersion: string,
): boolean {
  if (!minAppVersion) {
    return true
  }
  if (!appVersion) {
    return true
  }
  return !compareVersions(appVersion, minAppVersion)
}

export function getRepairMetaPath(stagingDir: string): string {
  return normalizePath(`${stagingDir}/${REPAIR_META_FILE}`)
}

function parseRepairMeta(raw: string): RepairMeta | null {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown
      files?: unknown
    }
    const version =
      typeof parsed.version === 'string' ? parsed.version.trim() : ''
    if (!version || !Array.isArray(parsed.files) || parsed.files.length === 0) {
      return null
    }
    const files = parsed.files.filter(
      (file): file is ReleaseFileName =>
        file === RELEASE_FILE_NAMES.mainJs ||
        file === RELEASE_FILE_NAMES.manifestJson ||
        file === RELEASE_FILE_NAMES.stylesCss,
    )
    if (files.length === 0) {
      return null
    }
    return {
      version: normalizePluginVersion(version),
      files,
    }
  } catch {
    return null
  }
}

export async function getRepairStagingStatus(
  adapter: DataAdapter,
  stagingDir: string,
  expectedVersion?: string,
): Promise<RepairStagingStatus> {
  const metaPath = getRepairMetaPath(stagingDir)
  if (!(await adapter.exists(metaPath))) {
    return { ready: false }
  }

  const meta = parseRepairMeta(await adapter.read(metaPath))
  if (!meta) {
    return { ready: false }
  }

  if (
    expectedVersion &&
    meta.version !== normalizePluginVersion(expectedVersion)
  ) {
    return { ready: false }
  }

  for (const fileName of meta.files) {
    const filePath = normalizePath(`${stagingDir}/${fileName}`)
    if (!(await adapter.exists(filePath))) {
      return { ready: false }
    }
  }

  let minAppVersion = ''
  if (meta.files.includes(RELEASE_FILE_NAMES.manifestJson)) {
    const manifestPath = normalizePath(
      `${stagingDir}/${RELEASE_FILE_NAMES.manifestJson}`,
    )
    const manifest = parseStagedManifest(await adapter.read(manifestPath))
    if (!manifest) {
      return { ready: false }
    }
    if (normalizePluginVersion(manifest.version) !== meta.version) {
      return { ready: false }
    }
    minAppVersion = manifest.minAppVersion
  }

  return {
    ready: true,
    version: meta.version,
    files: meta.files,
    minAppVersion,
  }
}

export async function getStagingStatus(
  adapter: DataAdapter,
  stagingDir: string,
  expectedVersion?: string,
): Promise<StagingStatus> {
  const mainPath = normalizePath(`${stagingDir}/${RELEASE_FILES.mainJs}`)
  const manifestPath = normalizePath(
    `${stagingDir}/${RELEASE_FILES.manifestJson}`,
  )
  const stylesPath = normalizePath(`${stagingDir}/${RELEASE_FILES.stylesCss}`)

  if (
    !(await adapter.exists(mainPath)) ||
    !(await adapter.exists(manifestPath)) ||
    !(await adapter.exists(stylesPath))
  ) {
    return { ready: false }
  }

  const manifestRaw = await adapter.read(manifestPath)
  const manifest = parseStagedManifest(manifestRaw)
  if (!manifest) {
    return { ready: false }
  }

  const normalized = normalizePluginVersion(manifest.version)
  if (
    expectedVersion &&
    normalized !== normalizePluginVersion(expectedVersion)
  ) {
    return { ready: false }
  }

  return {
    ready: true,
    version: normalized,
    minAppVersion: manifest.minAppVersion,
  }
}

async function ensureDir(adapter: DataAdapter, dir: string): Promise<void> {
  if (!(await adapter.exists(dir))) {
    await adapter.mkdir(dir)
  }
}

async function removeStagingDir(
  adapter: DataAdapter,
  stagingDir: string,
): Promise<void> {
  if (await adapter.exists(stagingDir)) {
    await adapter.rmdir(stagingDir, true)
  }
}

/** Removes the entire update staging tree so only one release is kept at a time. */
export async function clearStagingRoot(
  adapter: DataAdapter,
  pluginDir: string,
): Promise<void> {
  await removeStagingDir(adapter, getStagingRoot(pluginDir))
}

async function downloadBinary(url: string): Promise<ArrayBuffer> {
  const response = await requestUrl({ url, method: 'GET' })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Download failed (${response.status})`)
  }
  return response.arrayBuffer
}

async function downloadText(url: string): Promise<string> {
  const response = await requestUrl({ url, method: 'GET' })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Download failed (${response.status})`)
  }
  return response.text
}

export async function downloadReleaseToStaging(params: {
  adapter: DataAdapter
  pluginDir: string
  version: string
  assets: ReleaseAssets
  onProgress?: (progress: number) => void
}): Promise<void> {
  const { adapter, pluginDir, version, assets, onProgress } = params
  const stagingDir = getStagingDir(pluginDir, version)

  await clearStagingRoot(adapter, pluginDir)
  await ensureDir(adapter, stagingDir)

  try {
    onProgress?.(0)
    const mainBuffer = await downloadBinary(assets.mainJs.url)
    await adapter.writeBinary(
      normalizePath(`${stagingDir}/${RELEASE_FILES.mainJs}`),
      mainBuffer,
    )
    onProgress?.(60)

    const stylesText = await downloadText(assets.stylesCss.url)
    await adapter.write(
      normalizePath(`${stagingDir}/${RELEASE_FILES.stylesCss}`),
      stylesText,
    )
    onProgress?.(80)

    const manifestText = await downloadText(assets.manifestJson.url)
    await adapter.write(
      normalizePath(`${stagingDir}/${RELEASE_FILES.manifestJson}`),
      manifestText,
    )
    onProgress?.(100)

    const status = await getStagingStatus(adapter, stagingDir, version)
    if (!status.ready) {
      throw new Error('Staged release failed integrity check')
    }
  } catch (error) {
    await clearStagingRoot(adapter, pluginDir)
    throw error
  }
}

function assetForFile(
  assets: ReleaseAssets,
  fileName: ReleaseFileName,
): { url: string } {
  switch (fileName) {
    case RELEASE_FILE_NAMES.mainJs:
      return assets.mainJs
    case RELEASE_FILE_NAMES.manifestJson:
      return assets.manifestJson
    case RELEASE_FILE_NAMES.stylesCss:
      return assets.stylesCss
  }
}

export async function downloadRepairFilesToStaging(params: {
  adapter: DataAdapter
  pluginDir: string
  version: string
  assets: ReleaseAssets
  files: ReleaseFileName[]
  onProgress?: (progress: number) => void
}): Promise<void> {
  const { adapter, pluginDir, version, assets, files, onProgress } = params
  const normalized = normalizePluginVersion(version)
  const uniqueFiles = [...new Set(files)]
  if (uniqueFiles.length === 0) {
    throw new Error('No repair files requested')
  }

  const stagingDir = getStagingDir(pluginDir, normalized)
  await clearStagingRoot(adapter, pluginDir)
  await ensureDir(adapter, stagingDir)

  try {
    const step = 100 / uniqueFiles.length
    for (let index = 0; index < uniqueFiles.length; index += 1) {
      const fileName = uniqueFiles[index]
      const asset = assetForFile(assets, fileName)
      if (fileName === RELEASE_FILE_NAMES.mainJs) {
        const mainBuffer = await downloadBinary(asset.url)
        await adapter.writeBinary(
          normalizePath(`${stagingDir}/${fileName}`),
          mainBuffer,
        )
      } else {
        const text = await downloadText(asset.url)
        await adapter.write(normalizePath(`${stagingDir}/${fileName}`), text)
      }
      onProgress?.(Math.round(step * (index + 1)))
    }

    const repairMeta: RepairMeta = {
      version: normalized,
      files: uniqueFiles,
    }
    await adapter.write(
      getRepairMetaPath(stagingDir),
      JSON.stringify(repairMeta),
    )

    const status = await getRepairStagingStatus(adapter, stagingDir, normalized)
    if (!status.ready) {
      throw new Error('Staged repair failed integrity check')
    }
  } catch (error) {
    await clearStagingRoot(adapter, pluginDir)
    throw error
  }
}

async function copyStagedFile(
  adapter: DataAdapter,
  stagingDir: string,
  pluginDir: string,
  fileName: string,
  binary: boolean,
): Promise<void> {
  const source = normalizePath(`${stagingDir}/${fileName}`)
  const target = normalizePath(`${pluginDir}/${fileName}`)
  if (binary) {
    const content = await adapter.readBinary(source)
    await adapter.writeBinary(target, content)
    return
  }
  const content = await adapter.read(source)
  await adapter.write(target, content)
}

export async function applyStagedUpdate(
  app: App,
  plugin: YoloPlugin,
  version: string,
): Promise<ApplyStagedUpdateResult> {
  const pluginDir = plugin.manifest.dir
  if (!pluginDir) {
    return { ok: false, reason: 'write_failed' }
  }

  const adapter = app.vault.adapter
  const stagingDir = getStagingDir(pluginDir, version)
  const status = await getStagingStatus(adapter, stagingDir, version)
  if (!status.ready) {
    return { ok: false, reason: 'not_ready' }
  }

  if (
    status.minAppVersion &&
    !meetsMinAppVersion(apiVersion, status.minAppVersion)
  ) {
    return { ok: false, reason: 'min_app_version' }
  }

  try {
    await copyStagedFile(
      adapter,
      stagingDir,
      pluginDir,
      RELEASE_FILES.mainJs,
      true,
    )
    await copyStagedFile(
      adapter,
      stagingDir,
      pluginDir,
      RELEASE_FILES.stylesCss,
      false,
    )
    await copyStagedFile(
      adapter,
      stagingDir,
      pluginDir,
      RELEASE_FILES.manifestJson,
      false,
    )
  } catch {
    return { ok: false, reason: 'write_failed' }
  }

  await clearStagingRoot(adapter, pluginDir)

  // Reload the whole app so Obsidian loads the newly written plugin files.
  // Do not disable/enable from inside the plugin being replaced: disablePlugin
  // unloads this code before the async chain finishes and leaves the update
  // toast stuck on "Installing…".
  window.location.reload()

  return { ok: true }
}

const REPAIR_APPLY_ORDER: ReleaseFileName[] = [
  RELEASE_FILE_NAMES.mainJs,
  RELEASE_FILE_NAMES.stylesCss,
  RELEASE_FILE_NAMES.manifestJson,
]

export async function applyRepairFiles(
  app: App,
  plugin: YoloPlugin,
  version: string,
): Promise<ApplyStagedUpdateResult> {
  const pluginDir = plugin.manifest.dir
  if (!pluginDir) {
    return { ok: false, reason: 'write_failed' }
  }

  const adapter = app.vault.adapter
  const stagingDir = getStagingDir(pluginDir, version)
  const status = await getRepairStagingStatus(adapter, stagingDir, version)
  if (!status.ready) {
    return { ok: false, reason: 'not_ready' }
  }

  if (
    status.files.includes(RELEASE_FILE_NAMES.manifestJson) &&
    status.minAppVersion &&
    !meetsMinAppVersion(apiVersion, status.minAppVersion)
  ) {
    return { ok: false, reason: 'min_app_version' }
  }

  try {
    for (const fileName of REPAIR_APPLY_ORDER) {
      if (!status.files.includes(fileName)) {
        continue
      }
      await copyStagedFile(
        adapter,
        stagingDir,
        pluginDir,
        fileName,
        fileName === RELEASE_FILE_NAMES.mainJs,
      )
    }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }

  await clearStagingRoot(adapter, pluginDir)
  window.location.reload()
  return { ok: true }
}
