import { type App, normalizePath } from 'obsidian'

import {
  getLegacyVectorDbPath,
  getLegacyYoloVectorDbArchivePath,
} from '../core/paths/yoloPaths'
import { resolveVaultDatabaseNamespaceId } from '../core/storage/vaultDatabaseNamespace'

import { VectorManager } from './modules/vector/VectorManager'
import { IndexedDbVectorStore } from './vector-store/IndexedDbVectorStore'
import {
  deleteVectorDatabase,
  legacySingleVectorDatabaseName,
  openVectorDatabase,
  vectorDatabaseName,
} from './vector-store/vectorDatabase'

type YoloSettingsLike = Readonly<{ yolo?: { baseDir?: string } }>

export type DatabaseManagerCreateOptions = Readonly<{
  /** Test-only overrides. */
  indexedDB?: IDBFactory
  createNamespaceId?: () => string
  isMobile?: boolean
}>

type OpenKnowledgeBase = {
  store: IndexedDbVectorStore
  vectorManager: VectorManager
}

/**
 * Owns the RAG vector stores' lifecycle: resolves this vault's IndexedDB
 * namespace, and lazily opens one IndexedDB database per knowledge base
 * (`vectorDatabaseName(namespaceId, kbId)`), each wrapped in its own
 * `VectorManager`. Every chunk write (`insertVectors`, `deleteVectorsBy*`,
 * ...) persists to IndexedDB immediately — there is no snapshot/save step to
 * run.
 *
 * No knowledge base is opened eagerly at startup: `getVectorManager(kbId)`
 * opens and caches on first use, `closeKnowledgeBase` releases one without
 * deleting its data, and `deleteKnowledgeBase` closes and permanently drops
 * it (used when a knowledge base is removed from settings).
 */
export class DatabaseManager {
  private app: App | null = null
  private namespaceId = ''
  private indexedDB: IDBFactory | null = null
  private isMobile: boolean | undefined
  private readonly knowledgeBases = new Map<string, OpenKnowledgeBase>()
  private readonly openPromises = new Map<string, Promise<VectorManager>>()
  private closed = false
  private cleanupPromise: Promise<void> | null = null
  /** Ids permanently removed via `deleteKnowledgeBase`. A knowledge base id
   * is never reused, so once here it stays here — this blocks a `getVectorManager`
   * call that races the delete (settings-driven deletion vs. an in-flight
   * tool call or queued index run against the same id) from reopening a
   * database that's being (or has been) permanently dropped. */
  private readonly deletedKbIds = new Set<string>()

  private constructor() {}

  static async create(
    app: App,
    settings?: YoloSettingsLike | null,
    pluginDir?: string,
    options: DatabaseManagerCreateOptions = {},
  ): Promise<DatabaseManager> {
    const manager = new DatabaseManager()
    await manager.initialize(app, settings ?? null, pluginDir, options)
    return manager
  }

  private async initialize(
    app: App,
    settings: YoloSettingsLike | null,
    pluginDir: string | undefined,
    options: DatabaseManagerCreateOptions,
  ): Promise<void> {
    const namespaceId = resolveVaultDatabaseNamespaceId(app, {
      createNamespaceId: options.createNamespaceId,
    })
    const indexedDB = options.indexedDB ?? globalThis.indexedDB
    if (!indexedDB) {
      throw new Error(
        'YOLO vector store is unavailable: IndexedDB is unavailable',
      )
    }
    this.app = app
    this.namespaceId = namespaceId
    this.indexedDB = indexedDB
    this.isMobile = options.isMobile

    // Neither of these gates readiness: persistence is a best-effort browser
    // storage hint, and the legacy-artifact sweep only tidies up remnants
    // from the retired PGlite backend and this backend's pre-multi-base
    // single-store shape. Both swallow their own failures; they are awaited
    // only so `create()` resolving means the sweep has happened.
    await tryPersistStorage()
    await cleanupLegacyVectorDbArtifacts(
      app,
      settings,
      pluginDir,
      indexedDB,
      namespaceId,
    )
  }

  /** Lazily opens (and caches) the vector store for one knowledge base. */
  async getVectorManager(kbId: string): Promise<VectorManager> {
    if (this.closed) {
      throw new Error('Database is not initialized')
    }
    if (this.deletedKbIds.has(kbId)) {
      throw new Error(`Knowledge base "${kbId}" has been deleted`)
    }
    const existing = this.knowledgeBases.get(kbId)
    if (existing) {
      return existing.vectorManager
    }
    const inFlight = this.openPromises.get(kbId)
    if (inFlight) {
      return inFlight
    }

    const openPromise = (async () => {
      if (!this.indexedDB || !this.app) {
        throw new Error('Database is not initialized')
      }
      const db = await openVectorDatabase(
        this.indexedDB,
        vectorDatabaseName(this.namespaceId, kbId),
      )
      const store = new IndexedDbVectorStore(db, { isMobile: this.isMobile })
      const vectorManager = new VectorManager(this.app, store)
      this.knowledgeBases.set(kbId, { store, vectorManager })
      return vectorManager
    })()
    this.openPromises.set(kbId, openPromise)
    try {
      return await openPromise
    } finally {
      this.openPromises.delete(kbId)
    }
  }

  /** Waits for in-flight vector work, then closes this knowledge base's
   * database connection without deleting its data. Idempotent; a no-op if
   * the base was never opened. */
  async closeKnowledgeBase(kbId: string): Promise<void> {
    // A concurrent getVectorManager(kbId) may be mid-open — its connection
    // hasn't landed in `knowledgeBases` yet, so without this we'd see
    // nothing to close and return immediately, leaving that connection
    // dangling (or, worse, racing a caller that deletes the database right
    // after this resolves). Let it finish (or fail) first.
    const inFlight = this.openPromises.get(kbId)
    if (inFlight) {
      await inFlight.catch(() => undefined)
    }
    const opened = this.knowledgeBases.get(kbId)
    if (!opened) return
    this.knowledgeBases.delete(kbId)
    await opened.vectorManager.quiesce()
    opened.store.close()
  }

  /** Closes (if open) and permanently deletes one knowledge base's IndexedDB
   * database. Used when a knowledge base is removed from settings. Marks
   * `kbId` as deleted *before* closing/deleting so a `getVectorManager` call
   * racing this (a queued index run, an in-flight search tool call) can't
   * reopen the database while — or after — it's being dropped. */
  async deleteKnowledgeBase(kbId: string): Promise<void> {
    this.deletedKbIds.add(kbId)
    await this.closeKnowledgeBase(kbId)
    if (!this.indexedDB) return
    await deleteVectorDatabase(
      this.indexedDB,
      vectorDatabaseName(this.namespaceId, kbId),
    )
  }

  /** Waits for in-flight vector work, then closes every open database.
   * Idempotent. */
  cleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.cleanupUnlocked()
    }
    return this.cleanupPromise
  }

  private async cleanupUnlocked(): Promise<void> {
    this.closed = true
    const kbIds = [...this.knowledgeBases.keys()]
    await Promise.all(kbIds.map((kbId) => this.closeKnowledgeBase(kbId)))
  }
}

async function tryPersistStorage(): Promise<void> {
  try {
    const persisted = await globalThis.navigator?.storage?.persist?.()
    console.debug(`[YOLO] navigator.storage.persist(): ${String(persisted)}`)
  } catch (error) {
    console.debug('[YOLO] navigator.storage.persist() failed', error)
  }
}

/**
 * One-time, idempotent sweep of artifacts left behind by two retired
 * shapes: the PGlite-backed vector store (vault-stored snapshot file,
 * current and legacy locations, plus the WASM runtime it downloaded into
 * the plugin directory), and this IndexedDB backend's own pre-multi-base
 * single-store database (`yolo-vector:<ns>`, never shipped in a release —
 * see `legacySingleVectorDatabaseName`'s doc comment). Failures are
 * non-fatal — this is tidying up, not part of bringing the store online.
 */
async function cleanupLegacyVectorDbArtifacts(
  app: App,
  settings: YoloSettingsLike | null,
  pluginDir: string | undefined,
  indexedDB: IDBFactory,
  namespaceId: string,
): Promise<void> {
  const legacyFiles = [
    getLegacyYoloVectorDbArchivePath(settings),
    getLegacyVectorDbPath(),
  ]
  for (const path of legacyFiles) {
    try {
      if (await app.vault.adapter.exists(path)) {
        await app.vault.adapter.remove(path)
      }
    } catch (error) {
      console.warn(
        `[YOLO] Failed to remove legacy vector database file "${path}"`,
        error,
      )
    }
  }

  try {
    await deleteVectorDatabase(
      indexedDB,
      legacySingleVectorDatabaseName(namespaceId),
    )
  } catch (error) {
    console.warn(
      '[YOLO] Failed to remove legacy single-store vector database',
      error,
    )
  }

  if (!pluginDir) return
  const legacyRuntimeDirs = [
    normalizePath(`${pluginDir}/runtime/pglite`),
    // Orphaned runtime-component cache: the generic installer only manages
    // components it is asked about, it never prunes ids that are no longer
    // in the registry, so this has to be swept here.
    normalizePath(`${pluginDir}/runtime/components/pglite-engine`),
  ]
  for (const dir of legacyRuntimeDirs) {
    try {
      if (await app.vault.adapter.exists(dir)) {
        await app.vault.adapter.rmdir(dir, true)
      }
    } catch (error) {
      console.warn(
        `[YOLO] Failed to remove legacy PGlite runtime directory "${dir}"`,
        error,
      )
    }
  }
}
