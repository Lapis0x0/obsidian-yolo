import { type App, normalizePath } from 'obsidian'

import { ensureVectorDbPath } from '../core/paths/yoloManagedData'
import {
  type PgliteEngineSession,
  type RuntimeComponentLease,
} from '../core/runtime-components/contracts'
import { acquireRuntimeComponent } from '../core/runtime-components/runtimeComponentAccess'
import { yieldToMain } from '../utils/common/yield-to-main'

import { DatabaseSaveFailedError, PGLiteAbortedException } from './exception'
import { VectorManager } from './modules/vector/VectorManager'
import { loadPgliteRuntimeFromDisk } from './runtime/loadPgliteRuntimeFromDisk'

export class DatabaseManager {
  private session: PgliteEngineSession | null = null
  private lease: RuntimeComponentLease<'pglite-engine'> | null = null
  private vectorManager: VectorManager | null = null
  private cleanupPromise: Promise<void> | null = null

  private constructor(
    private readonly app: App,
    private readonly dbPath: string,
    private readonly runtimeDir: string,
  ) {}

  static async create(
    app: App,
    runtimeDir: string,
    settings?: { yolo?: { baseDir?: string } } | null,
    pluginDir?: string,
  ): Promise<DatabaseManager> {
    void pluginDir
    const dbPath = await ensureVectorDbPath(app, settings ?? null)
    const manager = new DatabaseManager(app, dbPath, normalizePath(runtimeDir))
    await manager.initialize()
    return manager
  }

  private async initialize(): Promise<void> {
    const resources = await this.loadPGliteResources()
    const lease = await acquireRuntimeComponent('pglite-engine')
    this.lease = lease
    let createdNewDatabase = false
    try {
      const snapshot = await this.readSnapshot()
      if (snapshot) {
        try {
          this.session = await lease.api.createSession({ resources, snapshot })
        } catch (error) {
          if (isPgliteAbort(error)) throw new PGLiteAbortedException()
          console.error(
            '[YOLO] Existing vector snapshot could not be opened; creating a new database.',
            error,
          )
        }
      }
      if (!this.session) {
        createdNewDatabase = true
        try {
          this.session = await lease.api.createSession({ resources })
        } catch (error) {
          if (isPgliteAbort(error)) throw new PGLiteAbortedException()
          throw error
        }
      }
      this.vectorManager = new VectorManager(this.app, this.session.vectorStore)
      this.vectorManager.setSaveCallback(() => this.save())
      this.vectorManager.setVacuumCallback(() => this.vacuum())

      if (createdNewDatabase || this.session.migrationChanged) {
        try {
          await this.save()
        } catch (error) {
          console.warn(
            '[YOLO] Initial database save failed; continuing without snapshot.',
            error,
          )
        }
      }

      try {
        const deleted = await this.session.cleanupLegacyStaging()
        if (deleted > 0) {
          console.debug(
            `[YOLO] Dropped ${deleted} legacy staging row(s) from embeddings.`,
          )
          await this.vacuum()
          try {
            await this.save()
          } catch (error) {
            console.warn(
              '[YOLO] Save after legacy staging cleanup failed; snapshot is stale.',
              error,
            )
          }
        }
      } catch (error) {
        console.warn('[YOLO] Failed to clean up legacy staging rows', error)
      }
      console.debug('YOLO database initialized.')
    } catch (error) {
      await this.session?.close().catch(() => undefined)
      this.session = null
      this.lease?.release()
      this.lease = null
      throw error
    }
  }

  getVectorManager(): VectorManager {
    if (!this.vectorManager) throw new Error('Database is not initialized')
    return this.vectorManager
  }

  async vacuum(): Promise<void> {
    await this.session?.vacuum()
  }

  async save(): Promise<void> {
    if (!this.session) return
    try {
      await yieldToMain()
      const snapshot = await this.session.dump()
      await yieldToMain()
      const bytes = await snapshot.arrayBuffer()
      await yieldToMain()
      await this.app.vault.adapter.writeBinary(this.dbPath, bytes)
    } catch (error) {
      console.error('Error saving database:', error)
      throw new DatabaseSaveFailedError(error)
    }
  }

  cleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.cleanupUnlocked(false)
    }
    return this.cleanupPromise
  }

  quiesceAndCleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.cleanupUnlocked(true)
    }
    return this.cleanupPromise
  }

  private async cleanupUnlocked(requireSave: boolean): Promise<void> {
    // DatabaseManager is the long-session owner. It stops new VectorManager
    // work and waits for in-flight RAG/index operations before checkpointing,
    // closing the session, and finally releasing the runtime lease.
    await this.vectorManager?.quiesce()
    let saveError: unknown
    try {
      await this.save()
    } catch (error) {
      saveError = error
      console.warn(
        '[YOLO] Save during cleanup failed; closing without persisting.',
        error,
      )
    }
    this.vectorManager = null
    try {
      await this.session?.close()
    } finally {
      this.session = null
      this.lease?.release()
      this.lease = null
    }
    if (requireSave && saveError) {
      throw saveError instanceof Error
        ? saveError
        : new Error('Unknown database save failure')
    }
  }

  private async readSnapshot(): Promise<Blob | undefined> {
    try {
      if (!(await this.app.vault.adapter.exists(this.dbPath))) return undefined
      const bytes = await this.app.vault.adapter.readBinary(this.dbPath)
      return new Blob([bytes], { type: 'application/x-gzip' })
    } catch (error) {
      console.error('loadExistingDatabase error', error)
      return undefined
    }
  }

  private async loadPGliteResources(): Promise<
    Awaited<ReturnType<typeof loadPgliteRuntimeFromDisk>>
  > {
    try {
      return await loadPgliteRuntimeFromDisk(this.app, this.runtimeDir)
    } catch (error) {
      console.error('Error loading PGlite resources:', error)
      console.error('Runtime dir:', this.runtimeDir)
      console.error('Vault config dir:', this.app.vault.configDir)
      throw error
    }
  }
}

function isPgliteAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('Aborted(). Build with -sASSERTIONS for more info.')
  )
}
