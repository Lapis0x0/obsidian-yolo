import { type App, normalizePath, requestUrl } from 'obsidian'

import {
  ANKI_SQLITE_RUNTIME_VERSION,
  type AnkiRuntimeManifest,
  createAnkiRuntimeManifest,
} from './metadata'

type Download = (url: string) => Promise<ArrayBuffer>
export type AnkiRuntimeStatus =
  | { kind: 'missing'; expectedVersion: string; dir: string }
  | { kind: 'downloading'; expectedVersion: string; dir: string }
  | { kind: 'ready'; version: string; dir: string; readyAt: number }
  | { kind: 'failed'; expectedVersion: string; dir: string; reason: string }

type Options = {
  app: App
  pluginId: string
  pluginDir?: string
  manifest?: AnkiRuntimeManifest
  download?: Download
}

const hash = async (bytes: ArrayBuffer): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')

export class AnkiSqliteRuntimeManager {
  private readonly app: App
  private readonly manifest: AnkiRuntimeManifest
  private readonly root: string
  private readonly download: Download
  private preparing: Promise<{ version: string; dir: string }> | null = null
  private volatile: AnkiRuntimeStatus | null = null

  constructor(options: Options) {
    this.app = options.app
    this.manifest =
      options.manifest ?? createAnkiRuntimeManifest(ANKI_SQLITE_RUNTIME_VERSION)
    const base = options.pluginDir
      ? normalizePath(options.pluginDir)
      : normalizePath(
          `${options.app.vault.configDir}/plugins/${options.pluginId}`,
        )
    this.root = normalizePath(`${base}/runtime/anki-sqlite`)
    this.download =
      options.download ??
      (async (url) => {
        const response = await requestUrl({ url, method: 'GET', throw: false })
        if (response.status < 200 || response.status >= 300)
          throw new Error(`Runtime download failed: HTTP ${response.status}`)
        return response.arrayBuffer.slice(0)
      })
  }

  private versionDir(): string {
    return normalizePath(`${this.root}/${this.manifest.runtimeVersion}`)
  }
  private tempDir(): string {
    return normalizePath(`${this.root}/.tmp-${this.manifest.runtimeVersion}`)
  }
  private currentPath(): string {
    return normalizePath(`${this.root}/current.json`)
  }

  private async mkdir(path: string): Promise<void> {
    try {
      await this.app.vault.adapter.mkdir(path)
    } catch (error) {
      if (!(await this.app.vault.adapter.exists(path))) throw error
    }
  }

  private async remove(path: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(path))) return
    const stat = await this.app.vault.adapter.stat(path)
    if (stat?.type === 'folder') await this.app.vault.adapter.rmdir(path, true)
    else await this.app.vault.adapter.remove(path)
  }

  async getStatus(): Promise<AnkiRuntimeStatus> {
    if (
      this.volatile?.kind === 'downloading' ||
      this.volatile?.kind === 'failed'
    )
      return this.volatile
    try {
      if (!(await this.app.vault.adapter.exists(this.currentPath())))
        throw new Error('missing')
      const current = JSON.parse(
        await this.app.vault.adapter.read(this.currentPath()),
      ) as { version?: string; readyAt?: number }
      if (current.version !== this.manifest.runtimeVersion)
        throw new Error('version')
      for (const file of this.manifest.files) {
        const stat = await this.app.vault.adapter.stat(
          normalizePath(`${this.versionDir()}/${file.name}`),
        )
        if (!stat || stat.size !== file.size) throw new Error('incomplete')
      }
      return {
        kind: 'ready',
        version: current.version,
        dir: this.versionDir(),
        readyAt: current.readyAt ?? 0,
      }
    } catch {
      return {
        kind: 'missing',
        expectedVersion: this.manifest.runtimeVersion,
        dir: this.versionDir(),
      }
    }
  }

  async ensureReady(): Promise<{ version: string; dir: string }> {
    const status = await this.getStatus()
    if (status.kind === 'ready')
      return { version: status.version, dir: status.dir }
    if (!this.preparing)
      this.preparing = this.install().finally(() => {
        this.preparing = null
      })
    return this.preparing
  }

  async loadWasm(): Promise<Uint8Array> {
    const ready = await this.ensureReady()
    return new Uint8Array(
      await this.app.vault.adapter.readBinary(
        normalizePath(`${ready.dir}/sql-wasm.wasm`),
      ),
    )
  }

  async clearLocalRuntime(): Promise<void> {
    await this.remove(this.root)
    this.volatile = {
      kind: 'missing',
      expectedVersion: this.manifest.runtimeVersion,
      dir: this.versionDir(),
    }
  }

  async redownload(): Promise<{ version: string; dir: string }> {
    await this.remove(this.versionDir())
    await this.remove(this.tempDir())
    await this.remove(this.currentPath())
    return this.ensureReady()
  }

  async clearObsoleteVersions(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.root))) return
    const listing = await this.app.vault.adapter.list(this.root)
    const keep = new Set([this.versionDir(), this.tempDir()])
    await Promise.all(
      listing.folders
        .filter((path) => !keep.has(normalizePath(path)))
        .map((path) => this.remove(path)),
    )
  }

  private async install(): Promise<{ version: string; dir: string }> {
    this.volatile = {
      kind: 'downloading',
      expectedVersion: this.manifest.runtimeVersion,
      dir: this.versionDir(),
    }
    await this.mkdir(this.root)
    await this.remove(this.tempDir())
    await this.mkdir(this.tempDir())
    try {
      for (const file of this.manifest.files) {
        const bytes = await this.download(file.url)
        if (
          bytes.byteLength !== file.size ||
          (await hash(bytes)) !== file.sha256
        )
          throw new Error(`Runtime integrity check failed: ${file.name}`)
        await this.app.vault.adapter.writeBinary(
          normalizePath(`${this.tempDir()}/${file.name}`),
          bytes,
        )
      }
      await this.app.vault.adapter.write(
        normalizePath(`${this.tempDir()}/manifest.json`),
        JSON.stringify(this.manifest, null, 2),
      )
      await this.remove(this.versionDir())
      await this.mkdir(this.versionDir())
      for (const file of this.manifest.files) {
        const bytes = await this.app.vault.adapter.readBinary(
          normalizePath(`${this.tempDir()}/${file.name}`),
        )
        await this.app.vault.adapter.writeBinary(
          normalizePath(`${this.versionDir()}/${file.name}`),
          bytes,
        )
      }
      const readyAt = Date.now()
      await this.app.vault.adapter.write(
        this.currentPath(),
        JSON.stringify({ version: this.manifest.runtimeVersion, readyAt }),
      )
      await this.remove(this.tempDir())
      await this.clearObsoleteVersions()
      this.volatile = {
        kind: 'ready',
        version: this.manifest.runtimeVersion,
        dir: this.versionDir(),
        readyAt,
      }
      return { version: this.manifest.runtimeVersion, dir: this.versionDir() }
    } catch (error) {
      await this.remove(this.tempDir())
      const reason = error instanceof Error ? error.message : String(error)
      this.volatile = {
        kind: 'failed',
        expectedVersion: this.manifest.runtimeVersion,
        dir: this.versionDir(),
        reason,
      }
      throw error
    }
  }
}
