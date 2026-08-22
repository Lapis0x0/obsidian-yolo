import { type App, normalizePath } from 'obsidian'

import {
  getLegacyVectorDbPath,
  getYoloVectorDbPath,
} from '../core/paths/yoloPaths'
import { resolveVaultDatabaseNamespaceId } from '../core/storage/vaultDatabaseNamespace'

import { VectorManager } from './modules/vector/VectorManager'
import { IndexedDbVectorStore } from './vector-store/IndexedDbVectorStore'
import {
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

/**
 * Owns the RAG vector store's lifecycle: resolves this vault's IndexedDB
 * namespace, opens the database, and wraps it in a `VectorManager`. Every
 * chunk write (`insertVectors`, `deleteVectorsBy*`, ...) persists to
 * IndexedDB immediately — there is no snapshot/save step to run, unlike the
 * PGlite-backed predecessor this replaces.
 */
export class DatabaseManager {
  private vectorManager: VectorManager | null = null
  private store: IndexedDbVectorStore | null = null
  private cleanupPromise: Promise<void> | null = null

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
    const db = await openVectorDatabase(
      indexedDB,
      vectorDatabaseName(namespaceId),
    )
    this.store = new IndexedDbVectorStore(db, { isMobile: options.isMobile })
    this.vectorManager = new VectorManager(app, this.store)

    // Neither of these gates readiness: persistence is a best-effort browser
    // storage hint, and the legacy-file sweep only tidies up artifacts from
    // the retired PGlite backend. Both swallow their own failures; they are
    // awaited only so `create()` resolving means the sweep has happened.
    await tryPersistStorage()
    await cleanupLegacyVectorDbArtifacts(app, settings, pluginDir)
  }

  getVectorManager(): VectorManager {
    if (!this.vectorManager) {
      throw new Error('Database is not initialized')
    }
    return this.vectorManager
  }

  /** Waits for in-flight vector work, then closes the database. Idempotent. */
  cleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.cleanupUnlocked()
    }
    return this.cleanupPromise
  }

  private async cleanupUnlocked(): Promise<void> {
    await this.vectorManager?.quiesce()
    this.vectorManager = null
    this.store?.close()
    this.store = null
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
 * One-time, idempotent sweep of artifacts left behind by the retired
 * PGlite-backed vector store: the vault-stored snapshot file (current and
 * legacy locations) and the WASM runtime it downloaded into the plugin
 * directory. Failures are non-fatal — this is tidying up, not part of
 * bringing the new store online.
 */
async function cleanupLegacyVectorDbArtifacts(
  app: App,
  settings: YoloSettingsLike | null,
  pluginDir: string | undefined,
): Promise<void> {
  const legacyFiles = [getYoloVectorDbPath(settings), getLegacyVectorDbPath()]
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
