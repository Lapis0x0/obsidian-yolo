import {
  type DataAdapter,
  FileSystemAdapter,
  Platform,
  normalizePath,
} from 'obsidian'

import { resolveModulePluginDir } from '../../modules/moduleStore'

import { LOCAL_EMBEDDING_CATALOG, LocalEmbeddingCatalogEntry } from './catalog'
import { DownloadVerificationError, downloadFileResumable } from './download'

export type LocalEmbeddingModelState =
  | Readonly<{ status: 'not-installed' }>
  | Readonly<{
      status: 'downloading'
      receivedBytes: number
      totalBytes: number
      currentFile: string
    }>
  | Readonly<{ status: 'verifying' }>
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'failed'; error: string }>

type ManifestFile = Readonly<{
  catalogId: string
  hfRepo: string
  revision: string
  endpoint: string
  installedAt: number
}>

const NOT_INSTALLED: LocalEmbeddingModelState = { status: 'not-installed' }

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Owns local embedding model weights on disk: download (resumable,
 * SHA-256-verified), removal, and an in-memory installed/downloading/failed
 * state machine — see docs/plans/08-22-local-embedding/00-plan.md §3.4.
 * Knows nothing about inference; `LocalEmbeddingClient` (`client.ts`) is the
 * only consumer of `readModelFile`.
 *
 * Desktop-only. Every disk/network method throws immediately on mobile;
 * `main.ts` should still construct one instance for the getter contract
 * (`access.ts`) to have something to return, since P3's UI needs to display
 * "unavailable on this platform" rather than treat the feature as absent.
 */
export class LocalEmbeddingModelManager {
  private readonly adapter: DataAdapter
  private readonly pluginDir: string
  private readonly getEndpoint: () => string
  private readonly catalog: readonly LocalEmbeddingCatalogEntry[]
  private readonly states = new Map<string, LocalEmbeddingModelState>()
  private readonly listeners = new Set<() => void>()
  private readonly downloadControllers = new Map<string, AbortController>()
  private downloadQueue: Promise<void> = Promise.resolve()
  private scanPromise: Promise<void> | null = null

  constructor(options: {
    adapter: DataAdapter
    manifest: Readonly<{ id: string; dir?: string }>
    configDir: string
    getEndpoint: () => string
    catalog?: readonly LocalEmbeddingCatalogEntry[]
  }) {
    this.adapter = options.adapter
    this.pluginDir = resolveModulePluginDir(options.manifest, options.configDir)
    this.getEndpoint = options.getEndpoint
    this.catalog = options.catalog ?? LOCAL_EMBEDDING_CATALOG
    for (const entry of this.catalog) {
      this.states.set(entry.id, NOT_INSTALLED)
    }
  }

  // ---- state store (useSyncExternalStore-compatible) ----------------------

  getState(catalogId: string): LocalEmbeddingModelState {
    return this.states.get(catalogId) ?? NOT_INSTALLED
  }

  getSnapshot(): ReadonlyMap<string, LocalEmbeddingModelState> {
    return this.states
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setState(catalogId: string, state: LocalEmbeddingModelState): void {
    this.states.set(catalogId, state)
    for (const listener of this.listeners) listener()
  }

  // ---- paths ----------------------------------------------------------

  private rootPath(): string {
    return normalizePath(`${this.pluginDir}/runtime/embedding-models`)
  }

  private revisionDirVaultPath(entry: LocalEmbeddingCatalogEntry): string {
    return normalizePath(`${this.rootPath()}/${entry.id}/${entry.revision}`)
  }

  private manifestVaultPath(entry: LocalEmbeddingCatalogEntry): string {
    return normalizePath(`${this.revisionDirVaultPath(entry)}/manifest.json`)
  }

  /** Converts a vault-relative path to an OS-absolute path for `node:fs`. */
  private fullPath(vaultRelativePath: string): string {
    if (!(this.adapter instanceof FileSystemAdapter)) {
      throw new Error(
        'Local embedding models require the desktop file system adapter',
      )
    }
    return this.adapter.getFullPath(vaultRelativePath)
  }

  // ---- startup scan (no network) ---------------------------------------

  /**
   * Populates initial state from disk only — never touches the network.
   * Safe to call multiple times; concurrent calls share one scan. Call once
   * at startup (`main.ts`); UI subscribers don't need to await it, they'll
   * just see `not-installed` flip to `ready` when it resolves.
   */
  scanInstalled(): Promise<void> {
    if (!Platform.isDesktop) return Promise.resolve()
    if (!this.scanPromise) {
      this.scanPromise = this.runScan().finally(() => {
        this.scanPromise = null
      })
    }
    return this.scanPromise
  }

  private async runScan(): Promise<void> {
    // eslint-disable-next-line import/no-nodejs-modules -- every caller of this method gates on Platform.isDesktop
    const fs = await import('node:fs')
    for (const entry of this.catalog) {
      try {
        const manifestPath = this.fullPath(this.manifestVaultPath(entry))
        const raw = await fs.promises.readFile(manifestPath, 'utf8')
        const manifest = JSON.parse(raw) as Partial<ManifestFile>
        if (
          manifest.catalogId !== entry.id ||
          manifest.revision !== entry.revision
        ) {
          continue
        }
        const filesOk = await this.verifyFilesPresent(entry)
        if (filesOk) this.setState(entry.id, { status: 'ready' })
      } catch {
        // No manifest / unreadable / stat mismatch → stays not-installed.
      }
    }
  }

  private async verifyFilesPresent(
    entry: LocalEmbeddingCatalogEntry,
  ): Promise<boolean> {
    // eslint-disable-next-line import/no-nodejs-modules -- every caller of this method gates on Platform.isDesktop
    const fs = await import('node:fs')
    for (const file of entry.files) {
      try {
        const stat = await fs.promises.stat(
          this.fullPath(
            normalizePath(`${this.revisionDirVaultPath(entry)}/${file.path}`),
          ),
        )
        if (!stat.isFile() || stat.size !== file.byteSize) return false
      } catch {
        return false
      }
    }
    return true
  }

  // ---- reading model files (for LocalEmbeddingClient) --------------------

  async readModelFile(
    entry: LocalEmbeddingCatalogEntry,
    file: string,
    _signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!Platform.isDesktop) {
      throw new Error('Local embedding models are only available on desktop')
    }
    if (this.getState(entry.id).status !== 'ready') {
      throw new Error(
        `Local embedding model "${entry.displayName}" is not installed`,
      )
    }
    // eslint-disable-next-line import/no-nodejs-modules -- every caller of this method gates on Platform.isDesktop
    const fs = await import('node:fs')
    const bytes = await fs.promises.readFile(
      this.fullPath(
        normalizePath(`${this.revisionDirVaultPath(entry)}/${file}`),
      ),
    )
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  // ---- download ----------------------------------------------------------

  /**
   * Downloads every declared file for `entry`, verifying size+SHA-256 as
   * each lands, then writes `manifest.json` to mark the install complete.
   * Concurrency is capped at 1 across all catalog entries — a second
   * `download()` call (for the same or a different entry) queues behind
   * whichever is already running. Calling `download()` again for an entry
   * that's already `downloading` is a no-op (observe via `subscribe`).
   */
  async download(entry: LocalEmbeddingCatalogEntry): Promise<void> {
    if (!Platform.isDesktop) {
      throw new Error('Local embedding models are only available on desktop')
    }
    if (this.getState(entry.id).status === 'downloading') return

    const controller = new AbortController()
    this.downloadControllers.set(entry.id, controller)
    const run = async (): Promise<void> => {
      if (controller.signal.aborted) return
      await this.runDownload(entry, controller.signal)
    }
    const task = this.downloadQueue.then(run, run)
    this.downloadQueue = task.then(
      () => undefined,
      () => undefined,
    )
    try {
      await task
    } finally {
      if (this.downloadControllers.get(entry.id) === controller) {
        this.downloadControllers.delete(entry.id)
      }
    }
  }

  /** Aborts an in-progress or queued-but-not-yet-started download. No-op if none is active. */
  cancelDownload(catalogId: string): void {
    this.downloadControllers.get(catalogId)?.abort()
  }

  private async runDownload(
    entry: LocalEmbeddingCatalogEntry,
    signal: AbortSignal,
  ): Promise<void> {
    // eslint-disable-next-line import/no-nodejs-modules -- every caller of this method gates on Platform.isDesktop
    const fs = await import('node:fs')
    const revisionDir = this.fullPath(this.revisionDirVaultPath(entry))
    await fs.promises.mkdir(revisionDir, { recursive: true })

    const endpoint = this.getEndpoint().trim().replace(/\/+$/, '')
    let receivedBeforeCurrentFile = 0
    this.setState(entry.id, {
      status: 'downloading',
      receivedBytes: 0,
      totalBytes: entry.totalBytes,
      currentFile: entry.files[0]?.path ?? '',
    })

    try {
      for (const file of entry.files) {
        if (signal.aborted) {
          throw new DOMException('Download aborted', 'AbortError')
        }
        const destPath = this.fullPath(
          normalizePath(`${this.revisionDirVaultPath(entry)}/${file.path}`),
        )
        const partialPath = `${destPath}.partial`
        const url = `${endpoint}/${entry.hfRepo}/resolve/${entry.revision}/${file.path}`
        await downloadFileResumable({
          url,
          destPath,
          partialPath,
          expectedByteSize: file.byteSize,
          expectedSha256: file.sha256,
          signal,
          onProgress: (receivedForFile) => {
            this.setState(entry.id, {
              status: 'downloading',
              receivedBytes: receivedBeforeCurrentFile + receivedForFile,
              totalBytes: entry.totalBytes,
              currentFile: file.path,
            })
          },
        })
        receivedBeforeCurrentFile += file.byteSize
      }

      this.setState(entry.id, { status: 'verifying' })
      const complete = await this.verifyFilesPresent(entry)
      if (!complete) {
        throw new DownloadVerificationError(
          `Local embedding model "${entry.displayName}" files failed post-download verification`,
        )
      }

      const manifest: ManifestFile = {
        catalogId: entry.id,
        hfRepo: entry.hfRepo,
        revision: entry.revision,
        endpoint,
        installedAt: Date.now(),
      }
      await fs.promises.writeFile(
        this.fullPath(this.manifestVaultPath(entry)),
        JSON.stringify(manifest, null, 2),
        'utf8',
      )
      this.setState(entry.id, { status: 'ready' })
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        // Cancelled by the user — leave any `.partial` files on disk for a
        // future resume and drop back to not-installed rather than
        // surfacing a spurious failure.
        this.setState(entry.id, NOT_INSTALLED)
        return
      }
      this.setState(entry.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  // ---- removal -------------------------------------------------------

  async remove(catalogId: string): Promise<void> {
    if (!Platform.isDesktop) return
    const entry = this.catalog.find((candidate) => candidate.id === catalogId)
    if (!entry) return
    this.cancelDownload(catalogId)
    // eslint-disable-next-line import/no-nodejs-modules -- every caller of this method gates on Platform.isDesktop
    const fs = await import('node:fs')
    const dir = this.fullPath(normalizePath(`${this.rootPath()}/${entry.id}`))
    await fs.promises.rm(dir, { recursive: true, force: true })
    this.setState(catalogId, NOT_INSTALLED)
  }

  /** Removes every installed local embedding model's on-disk weights. */
  async removeAll(): Promise<void> {
    if (!Platform.isDesktop) return
    // eslint-disable-next-line import/no-nodejs-modules -- every caller of this method gates on Platform.isDesktop
    const fs = await import('node:fs')
    for (const controller of this.downloadControllers.values())
      controller.abort()
    await fs.promises.rm(this.fullPath(this.rootPath()), {
      recursive: true,
      force: true,
    })
    for (const entry of this.catalog) this.setState(entry.id, NOT_INSTALLED)
  }
}
