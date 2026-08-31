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

type DownloadJob = Readonly<{
  /** Resolves/rejects once `runDownload` has fully settled for this job. */
  promise: Promise<void>
  controller: AbortController
}>

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
  private states: ReadonlyMap<string, LocalEmbeddingModelState>
  private readonly listeners = new Set<() => void>()
  private readonly downloadJobs = new Map<string, DownloadJob>()
  /**
   * One in-flight `rm()` per catalog id (or the same shared promise for
   * every id during `removeAll()`) — `download()`'s `run()` awaits its
   * entry's removal before touching disk, and `runScan()` skips any entry
   * with one pending, so a delete/download race (or a stale on-disk
   * manifest read mid-delete) can never write into a directory `rm()` is
   * still clearing, or resurrect a model `remove()` just deleted.
   */
  private readonly removals = new Map<string, Promise<void>>()
  private downloadChain: Promise<void> = Promise.resolve()
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
    const initial = new Map<string, LocalEmbeddingModelState>()
    for (const entry of this.catalog) {
      initial.set(entry.id, NOT_INSTALLED)
    }
    this.states = initial
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

  /**
   * Replaces `states` with a new `Map` on every change (never mutates the
   * previous one in place) — `getSnapshot()`'s return value must change
   * identity whenever content changes, since `useSyncExternalStore` decides
   * whether to re-render by reference equality alone.
   */
  private setState(catalogId: string, state: LocalEmbeddingModelState): void {
    const next = new Map(this.states)
    next.set(catalogId, state)
    this.states = next
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
      // A download/removal already owns this entry's on-disk state — let it
      // finish rather than reading a manifest mid-write/mid-delete and
      // clobbering an in-progress `downloading`/being-removed state with a
      // stale `ready`.
      if (this.downloadJobs.has(entry.id) || this.removals.has(entry.id)) {
        continue
      }
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
    if (!entry.files.some((declared) => declared.path === file)) {
      throw new Error(
        `"${file}" is not a declared file of local embedding model "${entry.displayName}"`,
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
   * `download()` call for a *different* entry queues behind whichever is
   * already running.
   *
   * A job is tracked per catalog id from the moment it's queued (not just
   * once it starts running): calling `download()` again for an entry that
   * already has a queued-or-running job returns that same job's promise
   * instead of enqueueing a second one (which would leak the first job's
   * `AbortController` and let two `runDownload` calls race the same files).
   *
   * State flips to `downloading` immediately, before the job's turn in the
   * global (concurrency-1) chain actually comes up — otherwise a model
   * queued behind another still reads as `not-installed` in the UI, which
   * offers a misleading "download" button and no way to cancel until it
   * starts running.
   */
  download(entry: LocalEmbeddingCatalogEntry): Promise<void> {
    if (!Platform.isDesktop) {
      return Promise.reject(
        new Error('Local embedding models are only available on desktop'),
      )
    }
    const existing = this.downloadJobs.get(entry.id)
    if (existing) return existing.promise

    const controller = new AbortController()
    this.setState(entry.id, {
      status: 'downloading',
      receivedBytes: 0,
      totalBytes: entry.totalBytes,
      currentFile: '',
    })
    const run = async (): Promise<void> => {
      // A `remove()`/`removeAll()` for this entry may still be clearing its
      // directory (e.g. the user deleted it, then immediately re-downloaded
      // it) — wait for that to finish before `runDownload` starts writing
      // into the same directory.
      const pendingRemoval = this.removals.get(entry.id)
      if (pendingRemoval) await pendingRemoval.catch(() => undefined)
      if (controller.signal.aborted) {
        // Cancelled while still queued, before it ever got to run —
        // `runDownload` never ran to reset this itself.
        this.setState(entry.id, NOT_INSTALLED)
        return
      }
      await this.runDownload(entry, controller.signal)
    }
    const jobPromise = this.downloadChain.then(run, run)
    this.downloadChain = jobPromise.then(
      () => undefined,
      () => undefined,
    )
    const job: DownloadJob = { promise: jobPromise, controller }
    this.downloadJobs.set(entry.id, job)
    // `.finally()`'s own returned promise re-rejects when `jobPromise`
    // does; without the `.catch()` here that becomes a second, unhandled
    // rejection for every caller who already handles the one on
    // `jobPromise` itself (returned below).
    void jobPromise
      .finally(() => {
        if (this.downloadJobs.get(entry.id) === job) {
          this.downloadJobs.delete(entry.id)
        }
      })
      .catch(() => undefined)
    return jobPromise
  }

  /** Aborts an in-progress or queued-but-not-yet-started download. No-op if none is active. */
  cancelDownload(catalogId: string): void {
    this.downloadJobs.get(catalogId)?.controller.abort()
  }

  /**
   * Aborts every in-flight/queued download job and waits for each to
   * settle. Call once, from `main.ts`'s `onunload`, before the manager
   * instance is discarded — otherwise an in-flight `runDownload` keeps
   * writing to disk after nothing references the manager anymore.
   */
  async dispose(): Promise<void> {
    const jobs = [...this.downloadJobs.values()]
    for (const job of jobs) job.controller.abort()
    await Promise.all(jobs.map((job) => job.promise.catch(() => undefined)))
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
        // `destPath` only exists once `downloadFileResumable` has verified
        // its size+SHA-256 and renamed the `.partial` file onto it, so a
        // matching size here means this file already completed on a
        // previous attempt — skip re-downloading it so a model-level retry
        // (e.g. after a later file's transient failure) doesn't re-fetch
        // everything from byte 0.
        const alreadyComplete = await fs.promises
          .stat(destPath)
          .then((stat) => stat.isFile() && stat.size === file.byteSize)
          .catch(() => false)
        if (alreadyComplete) {
          receivedBeforeCurrentFile += file.byteSize
          this.setState(entry.id, {
            status: 'downloading',
            receivedBytes: receivedBeforeCurrentFile,
            totalBytes: entry.totalBytes,
            currentFile: file.path,
          })
          continue
        }
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
    // Abort and wait for the job to fully settle (including `runDownload`'s
    // own cleanup) before touching disk — otherwise an in-flight download
    // can still be mid-write when `rm` runs, then recreate the directory
    // and re-mark the model `ready` right after removal.
    const job = this.downloadJobs.get(catalogId)
    if (job) {
      job.controller.abort()
      await job.promise.catch(() => undefined)
    }
    // Registered before the `rm()` itself starts (not just awaited after)
    // so a `download()` call that lands while this is running — including
    // one for the very entry being removed — sees it via `this.removals`
    // and waits its turn instead of racing the delete.
    const removal = this.performRemoval(catalogId, entry)
    this.removals.set(catalogId, removal)
    try {
      await removal
    } finally {
      if (this.removals.get(catalogId) === removal) {
        this.removals.delete(catalogId)
      }
    }
  }

  private async performRemoval(
    catalogId: string,
    entry: LocalEmbeddingCatalogEntry,
  ): Promise<void> {
    // eslint-disable-next-line import/no-nodejs-modules -- every caller of this method gates on Platform.isDesktop
    const fs = await import('node:fs')
    const dir = this.fullPath(normalizePath(`${this.rootPath()}/${entry.id}`))
    await fs.promises.rm(dir, { recursive: true, force: true })
    this.setState(catalogId, NOT_INSTALLED)
  }

  /** Removes every installed local embedding model's on-disk weights. */
  async removeAll(): Promise<void> {
    if (!Platform.isDesktop) return
    const jobs = [...this.downloadJobs.values()]
    for (const job of jobs) job.controller.abort()
    await Promise.all(jobs.map((job) => job.promise.catch(() => undefined)))
    const removal = this.performRemovalAll()
    for (const entry of this.catalog) this.removals.set(entry.id, removal)
    try {
      await removal
    } finally {
      for (const entry of this.catalog) {
        if (this.removals.get(entry.id) === removal) {
          this.removals.delete(entry.id)
        }
      }
    }
  }

  private async performRemovalAll(): Promise<void> {
    // eslint-disable-next-line import/no-nodejs-modules -- every caller of this method gates on Platform.isDesktop
    const fs = await import('node:fs')
    await fs.promises.rm(this.fullPath(this.rootPath()), {
      recursive: true,
      force: true,
    })
    for (const entry of this.catalog) this.setState(entry.id, NOT_INSTALLED)
  }
}
