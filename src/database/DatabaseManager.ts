import { PGlite } from '@electric-sql/pglite'
import { PGliteWorker } from '@electric-sql/pglite/worker'
import { PgliteDatabase, drizzle } from 'drizzle-orm/pglite'
import { App, normalizePath } from 'obsidian'
import pgliteWorkerScript from 'virtual:pglite-worker-script'

import { ensureVectorDbPath } from '../core/paths/yoloManagedData'
import { yieldToMain } from '../utils/common/yield-to-main'

import { PGLiteAbortedException } from './exception'
import migrations from './migrations.json'
import { VectorManager } from './modules/vector/VectorManager'
import { loadPgliteRuntimeFromDisk } from './runtime/loadPgliteRuntimeFromDisk'

type DrizzleMigratableDatabase = PgliteDatabase & {
  dialect: {
    migrate: (
      migrationData: unknown,
      session: unknown,
      options: { migrationsTable: string },
    ) => Promise<void>
  }
  session: unknown
}

/** PGlite 0.4+ main thread or worker client */
type PgliteClientInstance = PGlite | Awaited<ReturnType<typeof PGliteWorker.create>>

const hasDrizzleMigrationSupport = (
  database: PgliteDatabase,
): database is DrizzleMigratableDatabase => {
  const candidate = database as Partial<DrizzleMigratableDatabase>
  return (
    typeof candidate.dialect?.migrate === 'function' &&
    candidate.session !== undefined
  )
}

export class DatabaseManager {
  private app: App
  private dbPath: string
  private runtimeDir: string
  private pgClient: PgliteClientInstance | null = null
  private db: PgliteDatabase | null = null
  // WeakMap to prevent circular references
  private static managers = new WeakMap<
    DatabaseManager,
    { vectorManager?: VectorManager }
  >()

  constructor(app: App, dbPath: string, runtimeDir: string) {
    this.app = app
    this.dbPath = dbPath
    this.runtimeDir = normalizePath(runtimeDir)
  }

  static async create(
    app: App,
    runtimeDir: string,
    settings?: {
      yolo?: {
        baseDir?: string
      }
    } | null,
    pluginDir?: string,
  ): Promise<DatabaseManager> {
    const dbPath = await ensureVectorDbPath(app, settings)
    const dbManager = new DatabaseManager(app, dbPath, runtimeDir)
    let createdNewDatabase = false
    void pluginDir
    try {
      dbManager.db = await dbManager.loadExistingDatabase()
    } catch (loadErr) {
      throw loadErr
    }
    const migrationStateBefore =
      dbManager.db && !createdNewDatabase
        ? await dbManager.getMigrationState()
        : null
    if (!dbManager.db) {
      try {
        dbManager.db = await dbManager.createNewDatabase()
        createdNewDatabase = true
      } catch (createErr) {
        throw createErr;
      }
    }
    try {
      await dbManager.migrateDatabase()
    } catch (migrateErr) {
      throw migrateErr;
    }
    const migrationStateAfter =
      dbManager.db && !createdNewDatabase
        ? await dbManager.getMigrationState()
        : null
    const shouldSaveAfterInit =
      createdNewDatabase || migrationStateBefore !== migrationStateAfter

    if (shouldSaveAfterInit) {
      await dbManager.save()
    }

    // WeakMap setup
    const managers = { vectorManager: new VectorManager(app, dbManager.db) }

    // save, vacuum callback setup
    const saveCallback = dbManager.save.bind(dbManager) as () => Promise<void>
    const vacuumCallback = dbManager.vacuum.bind(
      dbManager,
    ) as () => Promise<void>

    managers.vectorManager.setSaveCallback(saveCallback)
    managers.vectorManager.setVacuumCallback(vacuumCallback)

    DatabaseManager.managers.set(dbManager, managers)

    console.debug('Smart composer database initialized.', dbManager)

    return dbManager
  }

  getDb() {
    return this.db
  }

  getVectorManager(): VectorManager {
    const managers = DatabaseManager.managers.get(this) ?? {}
    if (!managers.vectorManager) {
      if (this.db) {
        managers.vectorManager = new VectorManager(this.app, this.db)
        DatabaseManager.managers.set(this, managers)
      } else {
        throw new Error('Database is not initialized')
      }
    }
    return managers.vectorManager
  }

  // removed template manager

  // vacuum the database to release unused space
  async vacuum() {
    if (!this.pgClient) {
      return
    }
    await this.pgClient.exec('VACUUM FULL;')
  }

  private async tryCreateWithWorker(
    options: Record<string, unknown>,
  ): Promise<PgliteClientInstance | null> {
    if (
      typeof Worker === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined'
    ) {
      return null
    }
    const workerBlob = new Blob([pgliteWorkerScript], {
      type: 'application/javascript',
    })
    const workerUrl = URL.createObjectURL(workerBlob)
    let worker: Worker | null = null
    try {
      worker = new Worker(workerUrl)
      const result = await PGliteWorker.create(worker, options)
      const SMOKE_TIMEOUT_MS = 30000
      const smokeResult = await Promise.race([
        result.exec('SELECT 1 as ok;').then(() => 'ok' as const),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), SMOKE_TIMEOUT_MS),
        ),
      ])
      if (smokeResult === 'timeout') {
        worker?.terminate()
        throw new Error('PGlite worker smoke test timed out')
      }
      return result
    } catch (error) {
      worker?.terminate()
      console.warn(
        '[YOLO] PGlite Worker unavailable, falling back to main thread',
        error,
      )
      return null
    } finally {
      URL.revokeObjectURL(workerUrl)
    }
  }

  private async createNewDatabase() {
    try {
      const resources = await this.loadPGliteResources()
      const baseOpts = {
        fsBundle: resources.fsBundle,
        pgliteWasmModule: resources.pgliteWasmModule,
        initdbWasmModule: resources.initdbWasmModule,
        _vectorExtensionBlob: resources.vectorExtensionBlob,
      }
      const workerClient = await this.tryCreateWithWorker(baseOpts)
      if (workerClient) {
        this.pgClient = workerClient
      } else {
        this.pgClient = await PGlite.create({
          fsBundle: resources.fsBundle,
          pgliteWasmModule: resources.pgliteWasmModule,
          initdbWasmModule: resources.initdbWasmModule,
          extensions: {
            vector: resources.vectorExtensionBundlePath,
          },
        })
      }
      const db = drizzle(this.pgClient as PGlite)
      return db
    } catch (error) {
      console.error('createNewDatabase error', error)
      if (
        error instanceof Error &&
        error.message.includes(
          'Aborted(). Build with -sASSERTIONS for more info.',
        )
      ) {
        // This error occurs when using an outdated Obsidian installer version
        throw new PGLiteAbortedException()
      }
      throw error
    }
  }

  private async loadExistingDatabase(): Promise<PgliteDatabase | null> {
    try {
      const databaseFileExists = await this.app.vault.adapter.exists(
        this.dbPath,
      )
      if (!databaseFileExists) {
        return null
      }
      const fileBuffer = await this.app.vault.adapter.readBinary(this.dbPath)
      const fileBlob = new Blob([fileBuffer], { type: 'application/x-gzip' })
      const resources = await this.loadPGliteResources()
      const baseOpts = {
        loadDataDir: fileBlob,
        fsBundle: resources.fsBundle,
        pgliteWasmModule: resources.pgliteWasmModule,
        initdbWasmModule: resources.initdbWasmModule,
        _vectorExtensionBlob: resources.vectorExtensionBlob,
      }
      const workerClient = await this.tryCreateWithWorker(baseOpts)
      if (workerClient) {
        this.pgClient = workerClient
      } else {
        this.pgClient = await PGlite.create({
          loadDataDir: fileBlob,
          fsBundle: resources.fsBundle,
          pgliteWasmModule: resources.pgliteWasmModule,
          initdbWasmModule: resources.initdbWasmModule,
          extensions: {
            vector: resources.vectorExtensionBundlePath,
          },
        })
      }
      return drizzle(this.pgClient as PGlite)
    } catch (error) {
      console.error('loadExistingDatabase error', error)
      if (
        error instanceof Error &&
        error.message.includes(
          'Aborted(). Build with -sASSERTIONS for more info.',
        )
      ) {
        // This error occurs when using an outdated Obsidian installer version
        throw new PGLiteAbortedException()
      }
      return null
    }
  }

  private async migrateDatabase(): Promise<void> {
    try {
      if (!this.db) {
        throw new Error('Database is not initialized')
      }
      if (!hasDrizzleMigrationSupport(this.db)) {
        throw new Error('Drizzle migration API is unavailable')
      }
      // Workaround for running Drizzle migrations in a browser environment
      // This method uses an undocumented API to perform migrations
      // See: https://github.com/drizzle-team/drizzle-orm/discussions/2532#discussioncomment-10780523
      await this.db.dialect.migrate(migrations, this.db.session, {
        migrationsTable: 'drizzle_migrations',
      })
    } catch (error) {
      console.error('Error migrating database:', error)
      throw error
    }
  }

  private async getMigrationState(): Promise<string> {
    if (!this.pgClient) {
      return 'pgClient-unavailable'
    }

    try {
      const migrationTableExists = await this.pgClient.query(
        `SELECT to_regclass('public.drizzle_migrations') AS table_name`,
      )
      const tableName = (migrationTableExists.rows?.[0] as {
        table_name?: string | null
      } | undefined)?.table_name
      if (!tableName) {
        return 'missing'
      }
      const result = await this.pgClient.query(
        `SELECT count(*)::text AS count, COALESCE(MAX(created_at)::text, '') AS latest_created_at FROM drizzle_migrations`,
      )
      const row = (result.rows?.[0] ?? {}) as {
        count?: string
        latest_created_at?: string
      }
      return `${row.count ?? '0'}:${row.latest_created_at ?? ''}`
    } catch (error) {
      console.warn('[YOLO] Failed to inspect drizzle_migrations', error)
      return 'unknown'
    }
  }

  async save(): Promise<void> {
    if (!this.pgClient) {
      return
    }
    try {
      // 让步给主线程，避免在繁忙时刻开始保存
      await yieldToMain()

      const blob: Blob = await this.pgClient.dumpDataDir('gzip')

      // 让步给主线程，大型数据库的 dump 可能很耗时
      await yieldToMain()

      const arrayBuffer = await blob.arrayBuffer()

      // 让步给主线程，准备写入文件
      await yieldToMain()

      await this.app.vault.adapter.writeBinary(this.dbPath, arrayBuffer)
    } catch (error) {
      console.error('Error saving database:', error)
    }
  }

  async cleanup() {
    // save before cleanup
    await this.save()
    // WeakMap cleanup
    DatabaseManager.managers.delete(this)
    await this.pgClient?.close()
    this.pgClient = null
    this.db = null
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
