import { App, normalizePath, requestUrl } from 'obsidian'

import {
  createPGliteRuntimeManifest,
  type PGliteRuntimeFileName,
  type PGliteRuntimeManifest,
} from './pgliteRuntimeMetadata'

type RuntimeCurrentFile = {
  version: string
  readyAt: number
}

export type PGliteRuntimeStatus =
  | {
      kind: 'missing'
      expectedVersion: string
      dir: string
      checkedAt: number
    }
  | {
      kind: 'downloading'
      expectedVersion: string
      dir: string
      checkedAt: number
      currentFile?: PGliteRuntimeFileName
    }
  | {
      kind: 'ready'
      version: string
      dir: string
      checkedAt: number
      readyAt: number | null
    }
  | {
      kind: 'failed'
      expectedVersion: string
      dir: string
      checkedAt: number
      reason: string
    }

type PGliteRuntimeManagerOptions = {
  app: App
  pluginId: string
  pluginDir?: string
  runtimeVersion: string
}

const CURRENT_FILE_NAME = 'current.json'
const LOCAL_MANIFEST_FILE_NAME = 'manifest.json'

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

  const stat = await app.vault.adapter.stat(path)
  if (stat?.type === 'folder') {
    await app.vault.adapter.rmdir(path, true)
    return
  }

  await app.vault.adapter.remove(path)
}

const toHex = (buffer: ArrayBuffer): string => {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

const computeSha256 = async (buffer: ArrayBuffer): Promise<string> => {
  return toHex(await crypto.subtle.digest('SHA-256', buffer))
}

export class PGliteRuntimeManager {
  private readonly app: App
  private readonly runtimeVersion: string
  private readonly runtimeRootDir: string
  private readonly currentFilePath: string
  private readonly manifest: PGliteRuntimeManifest
  private preparePromise: Promise<{ version: string; dir: string }> | null =
    null
  private volatileStatus: PGliteRuntimeStatus | null = null

  constructor(options: PGliteRuntimeManagerOptions) {
    this.app = options.app
    this.runtimeVersion = options.runtimeVersion
    const pluginBaseDir = options.pluginDir
      ? normalizePath(options.pluginDir)
      : normalizePath(
          `${options.app.vault.configDir}/plugins/${options.pluginId}`,
        )
    this.runtimeRootDir = normalizePath(`${pluginBaseDir}/runtime/pglite`)
    this.currentFilePath = normalizePath(
      `${this.runtimeRootDir}/${CURRENT_FILE_NAME}`,
    )
    this.manifest = createPGliteRuntimeManifest(this.runtimeVersion)
  }

  getRuntimeRootDir(): string {
    return this.runtimeRootDir
  }

  async getStatus(): Promise<PGliteRuntimeStatus> {
    if (
      this.volatileStatus?.kind === 'downloading' ||
      this.volatileStatus?.kind === 'failed'
    ) {
      return {
        ...this.volatileStatus,
        checkedAt: Date.now(),
      }
    }

    const checkedAt = Date.now()
    const current = await this.readCurrentFile()

    if (!current || current.version !== this.runtimeVersion) {
      const missingStatus: PGliteRuntimeStatus = {
        kind: 'missing',
        expectedVersion: this.runtimeVersion,
        dir: this.getVersionDir(this.runtimeVersion),
        checkedAt,
      }
      this.volatileStatus = missingStatus
      return missingStatus
    }

    const versionDir = this.getVersionDir(current.version)
    const ready = await this.hasAllRuntimeFiles(versionDir)
    if (!ready) {
      const failedStatus: PGliteRuntimeStatus = {
        kind: 'failed',
        expectedVersion: this.runtimeVersion,
        dir: versionDir,
        checkedAt,
        reason: 'Local runtime files are incomplete.',
      }
      this.volatileStatus = failedStatus
      return failedStatus
    }

    const readyStatus: PGliteRuntimeStatus = {
      kind: 'ready',
      version: current.version,
      dir: versionDir,
      checkedAt,
      readyAt: current.readyAt ?? null,
    }
    this.volatileStatus = readyStatus
    return readyStatus
  }

  async ensureReady(): Promise<{ version: string; dir: string }> {
    const status = await this.getStatus()
    if (status.kind === 'ready') {
      try {
        await this.verifyVersionDir(status.dir)
        return {
          version: status.version,
          dir: status.dir,
        }
      } catch (error) {
        console.warn('[YOLO] Local PGlite runtime verification failed', error)
        await this.clearVersionDir(status.version)
        await removePathIfExists(this.app, this.currentFilePath)
      }
    }

    if (!this.preparePromise) {
      this.preparePromise = this.downloadAndActivateRuntime()
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          this.volatileStatus = {
            kind: 'failed',
            expectedVersion: this.runtimeVersion,
            dir: this.getVersionDir(this.runtimeVersion),
            checkedAt: Date.now(),
            reason,
          }
          throw error
        })
        .finally(() => {
          this.preparePromise = null
        })
    }

    return this.preparePromise
  }

  async redownload(): Promise<{ version: string; dir: string }> {
    await this.clearVersionDir(this.runtimeVersion)
    await removePathIfExists(this.app, this.currentFilePath)
    return this.ensureReady()
  }

  async clearLocalRuntime(): Promise<void> {
    await removePathIfExists(this.app, this.currentFilePath)
    await removePathIfExists(this.app, this.runtimeRootDir)
    this.volatileStatus = {
      kind: 'missing',
      expectedVersion: this.runtimeVersion,
      dir: this.getVersionDir(this.runtimeVersion),
      checkedAt: Date.now(),
    }
  }

  async clearObsoleteVersions(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.runtimeRootDir))) {
      return
    }

    const listing = await this.app.vault.adapter.list(this.runtimeRootDir)
    const keepDirs = new Set([
      this.getVersionDir(this.runtimeVersion),
      this.getTempDir(this.runtimeVersion),
    ])

    await Promise.all(
      listing.folders
        .filter((dir) => !keepDirs.has(normalizePath(dir)))
        .map((dir) => removePathIfExists(this.app, dir)),
    )
  }

  private getVersionDir(version: string): string {
    return normalizePath(`${this.runtimeRootDir}/${version}`)
  }

  private getTempDir(version: string): string {
    return normalizePath(`${this.runtimeRootDir}/.tmp-${version}`)
  }

  private async readCurrentFile(): Promise<RuntimeCurrentFile | null> {
    if (!(await this.app.vault.adapter.exists(this.currentFilePath))) {
      return null
    }

    try {
      const raw = await this.app.vault.adapter.read(this.currentFilePath)
      return JSON.parse(raw) as RuntimeCurrentFile
    } catch (error) {
      console.warn('[YOLO] Failed to read PGlite runtime current file', error)
      return null
    }
  }

  private async hasAllRuntimeFiles(versionDir: string): Promise<boolean> {
    for (const file of this.manifest.files) {
      const filePath = normalizePath(`${versionDir}/${file.name}`)
      if (!(await this.app.vault.adapter.exists(filePath))) {
        return false
      }
    }
    return true
  }

  private async verifyVersionDir(versionDir: string): Promise<void> {
    for (const file of this.manifest.files) {
      const filePath = normalizePath(`${versionDir}/${file.name}`)
      const content = await this.app.vault.adapter.readBinary(filePath)
      if (content.byteLength !== file.size) {
        throw new Error(`Runtime file size mismatch: ${file.name}`)
      }
      const hash = await computeSha256(content)
      if (hash !== file.sha256) {
        throw new Error(`Runtime file hash mismatch: ${file.name}`)
      }
    }
  }

  private async clearVersionDir(version: string): Promise<void> {
    await removePathIfExists(this.app, this.getVersionDir(version))
    await removePathIfExists(this.app, this.getTempDir(version))
  }

  private async downloadAndActivateRuntime(): Promise<{
    version: string
    dir: string
  }> {
    const tempDir = this.getTempDir(this.runtimeVersion)
    const versionDir = this.getVersionDir(this.runtimeVersion)

    this.volatileStatus = {
      kind: 'downloading',
      expectedVersion: this.runtimeVersion,
      dir: versionDir,
      checkedAt: Date.now(),
    }

    await ensureDir(this.app, this.runtimeRootDir)
    await this.clearVersionDir(this.runtimeVersion)
    await ensureDir(this.app, tempDir)

    try {
      for (const file of this.manifest.files) {
        this.volatileStatus = {
          kind: 'downloading',
          expectedVersion: this.runtimeVersion,
          dir: versionDir,
          checkedAt: Date.now(),
          currentFile: file.name,
        }

        const response = await requestUrl({
          url: file.url,
          method: 'GET',
          throw: false,
        })

        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            `Failed to download ${file.name}: HTTP ${response.status}`,
          )
        }

        const buffer = response.arrayBuffer.slice(0)
        if (buffer.byteLength !== file.size) {
          throw new Error(`Runtime file size mismatch: ${file.name}`)
        }

        const hash = await computeSha256(buffer)
        if (hash !== file.sha256) {
          throw new Error(`Runtime file hash mismatch: ${file.name}`)
        }

        const targetPath = normalizePath(`${tempDir}/${file.name}`)
        await ensureParentDir(this.app, targetPath)
        await this.app.vault.adapter.writeBinary(targetPath, buffer)
      }

      const manifestPath = normalizePath(
        `${tempDir}/${LOCAL_MANIFEST_FILE_NAME}`,
      )
      await this.app.vault.adapter.write(
        manifestPath,
        JSON.stringify(this.manifest, null, 2),
      )

      await removePathIfExists(this.app, versionDir)
      await ensureDir(this.app, versionDir)

      const tempListing = await this.app.vault.adapter.list(tempDir)
      for (const filePath of tempListing.files) {
        const relativePath = filePath.slice(tempDir.length + 1)
        const targetPath = normalizePath(`${versionDir}/${relativePath}`)
        const content = await this.app.vault.adapter.readBinary(filePath)
        await ensureParentDir(this.app, targetPath)
        await this.app.vault.adapter.writeBinary(targetPath, content)
      }

      const readyAt = Date.now()
      await this.app.vault.adapter.write(
        this.currentFilePath,
        JSON.stringify(
          {
            version: this.runtimeVersion,
            readyAt,
          },
          null,
          2,
        ),
      )

      await removePathIfExists(this.app, tempDir)
      await this.clearObsoleteVersions()

      const readyStatus: PGliteRuntimeStatus = {
        kind: 'ready',
        version: this.runtimeVersion,
        dir: versionDir,
        checkedAt: Date.now(),
        readyAt,
      }
      this.volatileStatus = readyStatus

      return {
        version: this.runtimeVersion,
        dir: versionDir,
      }
    } catch (error) {
      await removePathIfExists(this.app, tempDir)
      throw error
    }
  }
}
