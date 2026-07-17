import type { AnkiRuntimeHost } from './AnkiRuntimeHost'
import {
  ANKI_SQLITE_RUNTIME_VERSION,
  type AnkiRuntimeManifest,
  createAnkiRuntimeManifest,
} from './metadata'

export type AnkiRuntimeStatus =
  | { kind: 'missing'; expectedVersion: string; dir: string }
  | { kind: 'downloading'; expectedVersion: string; dir: string }
  | { kind: 'ready'; version: string; dir: string; readyAt: number }
  | { kind: 'failed'; expectedVersion: string; dir: string; reason: string }

type Options = {
  host: AnkiRuntimeHost
  manifest?: AnkiRuntimeManifest
}

const assertPathSegment = (value: string, label: string): string => {
  if (!value || value === '.' || value === '..' || /[\\/]/.test(value)) {
    throw new Error(`${label} must be a non-empty path segment`)
  }
  return value
}

const joinRelative = (...segments: string[]): string => {
  segments.forEach((segment) => assertPathSegment(segment, 'Runtime path'))
  return segments.join('/')
}

const hash = async (bytes: ArrayBuffer): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export class AnkiSqliteRuntimeManager {
  private readonly host: AnkiRuntimeHost
  private readonly manifest: AnkiRuntimeManifest
  private readonly version: string
  private preparing: Promise<{ version: string; dir: string }> | null = null
  private volatile: AnkiRuntimeStatus | null = null

  constructor(options: Options) {
    this.host = options.host
    this.manifest =
      options.manifest ?? createAnkiRuntimeManifest(ANKI_SQLITE_RUNTIME_VERSION)
    this.version = assertPathSegment(
      this.manifest.runtimeVersion,
      'Runtime version',
    )
    this.manifest.files.forEach((file) =>
      assertPathSegment(file.name, 'Runtime file name'),
    )
  }

  private versionDir(): string {
    return this.version
  }

  private tempDir(): string {
    return `.tmp-${this.version}`
  }

  async getStatus(): Promise<AnkiRuntimeStatus> {
    if (
      this.volatile?.kind === 'downloading' ||
      this.volatile?.kind === 'failed'
    ) {
      return this.volatile
    }
    return this.readDiskStatus()
  }

  async ensureReady(): Promise<{ version: string; dir: string }> {
    const status = await this.getStatus()
    if (status.kind === 'ready') return this.toReadyResult(status)
    if (!this.preparing) {
      this.preparing = this.host
        .runExclusive(async () => {
          const lockedStatus = await this.readDiskStatus()
          if (lockedStatus.kind === 'ready') {
            this.volatile = lockedStatus
            return this.toReadyResult(lockedStatus)
          }
          return this.installUnlocked()
        })
        .finally(() => {
          this.preparing = null
        })
    }
    return this.preparing
  }

  async loadWasm(): Promise<Uint8Array> {
    const ready = await this.ensureReady()
    return new Uint8Array(
      await this.host.storage.readBinary(
        joinRelative(ready.dir, 'sql-wasm.wasm'),
      ),
    )
  }

  async clearLocalRuntime(): Promise<void> {
    await this.host.runExclusive(async () => this.host.storage.remove(''))
    this.volatile = this.missingStatus()
  }

  async redownload(): Promise<{ version: string; dir: string }> {
    return this.host.runExclusive(async () => {
      await this.host.storage.remove('current.json')
      await this.host.storage.remove(this.versionDir())
      await this.host.storage.remove(this.tempDir())
      return this.installUnlocked()
    })
  }

  async clearObsoleteVersions(): Promise<void> {
    await this.host.runExclusive(async () => this.clearObsoleteVersionsUnlocked())
  }

  private async readDiskStatus(): Promise<AnkiRuntimeStatus> {
    try {
      if (!(await this.host.storage.exists('current.json'))) {
        return this.missingStatus()
      }
      const current = JSON.parse(
        await this.host.storage.readText('current.json'),
      ) as { version?: string; readyAt?: number }
      if (current.version !== this.version) return this.missingStatus()
      await this.verifyRuntimeFiles(this.versionDir())
      return {
        kind: 'ready',
        version: this.version,
        dir: this.versionDir(),
        readyAt: current.readyAt ?? 0,
      }
    } catch {
      return this.missingStatus()
    }
  }

  private async verifyRuntimeFiles(dir: string): Promise<void> {
    for (const file of this.manifest.files) {
      const path = joinRelative(dir, file.name)
      const stat = await this.host.storage.stat(path)
      if (!stat || stat.type !== 'file' || stat.size !== file.size) {
        throw new Error(`Runtime integrity check failed: ${file.name}`)
      }
      const bytes = await this.host.storage.readBinary(path)
      if (
        bytes.byteLength !== file.size ||
        (await hash(bytes)) !== file.sha256.toLowerCase()
      ) {
        throw new Error(`Runtime integrity check failed: ${file.name}`)
      }
    }
  }

  private async clearObsoleteVersionsUnlocked(): Promise<void> {
    const listing = await this.listRoot()
    const keep = new Set([this.versionDir(), this.tempDir()])
    await Promise.all(
      listing.folders
        .filter((path) => !keep.has(path))
        .map((path) => this.host.storage.remove(path)),
    )
  }

  private async listRoot() {
    if (!(await this.host.storage.exists(''))) {
      return { files: [], folders: [] }
    }
    return this.host.storage.list('')
  }

  private async installUnlocked(): Promise<{ version: string; dir: string }> {
    this.volatile = {
      kind: 'downloading',
      expectedVersion: this.version,
      dir: this.versionDir(),
    }
    try {
      await this.host.storage.mkdir('')
      await this.host.storage.remove(this.tempDir())
      await this.host.storage.mkdir(this.tempDir())
      for (const file of this.manifest.files) {
        const bytes = await this.host.downloadArrayBuffer(file.url)
        if (
          bytes.byteLength !== file.size ||
          (await hash(bytes)) !== file.sha256.toLowerCase()
        ) {
          throw new Error(`Runtime integrity check failed: ${file.name}`)
        }
        await this.host.storage.writeBinary(
          joinRelative(this.tempDir(), file.name),
          bytes,
        )
      }
      await this.verifyRuntimeFiles(this.tempDir())
      await this.host.storage.writeText(
        joinRelative(this.tempDir(), 'manifest.json'),
        JSON.stringify(this.manifest, null, 2),
      )

      await this.host.storage.remove('current.json')
      await this.host.storage.remove(this.versionDir())
      await this.host.storage.rename(this.tempDir(), this.versionDir())
      const readyAt = Date.now()
      await this.host.storage.writeText(
        'current.json',
        JSON.stringify({ version: this.version, readyAt }),
      )
      try {
        await this.clearObsoleteVersionsUnlocked()
      } catch (error) {
        console.warn('[YOLO] Failed to clean obsolete Anki runtimes:', error)
      }
      this.volatile = {
        kind: 'ready',
        version: this.version,
        dir: this.versionDir(),
        readyAt,
      }
      return { version: this.version, dir: this.versionDir() }
    } catch (error) {
      let reason = describeError(error)
      try {
        await this.host.storage.remove(this.tempDir())
      } catch (cleanupError) {
        reason += `; staging cleanup failed: ${describeError(cleanupError)}`
      }
      this.volatile = {
        kind: 'failed',
        expectedVersion: this.version,
        dir: this.versionDir(),
        reason,
      }
      throw error
    }
  }

  private missingStatus(): AnkiRuntimeStatus {
    return {
      kind: 'missing',
      expectedVersion: this.version,
      dir: this.versionDir(),
    }
  }

  private toReadyResult(status: Extract<AnkiRuntimeStatus, { kind: 'ready' }>) {
    return { version: status.version, dir: status.dir }
  }
}
