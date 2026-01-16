import { PGlite } from '@electric-sql/pglite'
import { PgliteDatabase, drizzle } from 'drizzle-orm/pglite'
import { App, normalizePath } from 'obsidian'

import { PGLITE_DB_PATH } from '../constants'
import { yieldToMain } from '../utils/common/yield-to-main'

import { PGLiteAbortedException } from './exception'
import migrations from './migrations.json'
import { VectorManager } from './modules/vector/VectorManager'
import { loadEmbeddedPgliteResources } from './pgliteAssets'

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
  private pgliteResourcePath: string
  private pgClient: PGlite | null = null
  private db: PgliteDatabase | null = null
  // WeakMap to prevent circular references
  private static managers = new WeakMap<
    DatabaseManager,
    { vectorManager?: VectorManager }
  >()

  constructor(app: App, dbPath: string, pgliteResourcePath: string) {
    this.app = app
    this.dbPath = dbPath
    this.pgliteResourcePath = normalizePath(pgliteResourcePath)
  }

  static async create(
    app: App,
    pgliteResourcePath: string,
  ): Promise<DatabaseManager> {
    const dbManager = new DatabaseManager(
      app,
      normalizePath(PGLITE_DB_PATH),
      pgliteResourcePath,
    )
    dbManager.db = await dbManager.loadExistingDatabase()
    if (!dbManager.db) {
      dbManager.db = await dbManager.createNewDatabase()
    }
    await dbManager.migrateDatabase()
    await dbManager.save()

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
    await this.pgClient.query('VACUUM FULL;')
  }

  private async createNewDatabase() {
    try {
      const { fsBundle, wasmModule, vectorExtensionBundlePath } =
        await this.loadPGliteResources()
      this.pgClient = await PGlite.create({
        fsBundle: fsBundle,
        wasmModule: wasmModule,
        extensions: {
          vector: vectorExtensionBundlePath,
        },
      })
      const db = drizzle(this.pgClient)
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
      const { fsBundle, wasmModule, vectorExtensionBundlePath } =
        await this.loadPGliteResources()
      this.pgClient = await PGlite.create({
        loadDataDir: fileBlob,
        fsBundle: fsBundle,
        wasmModule: wasmModule,
        extensions: {
          vector: vectorExtensionBundlePath,
        },
      })
      return drizzle(this.pgClient)
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

  /**
   * 检查 PGlite 资源是否可用（不依赖 CDN）
   * @returns { available: boolean, needsDownload: boolean, fromCDN: boolean }
   */
  checkPGliteResources(): {
    available: boolean
    needsDownload: boolean
    fromCDN: boolean
  } {
    try {
      // 资源已经内联到 main.js，不依赖运行时下载
      return { available: true, needsDownload: false, fromCDN: false }
    } catch (error) {
      console.error('Error checking PGlite resources:', error)
      return { available: false, needsDownload: false, fromCDN: false }
    }
  }

  // TODO: This function is a temporary workaround chosen due to the difficulty of bundling postgres.wasm and postgres.data from node_modules into a single JS file. The ultimate goal is to bundle everything into one JS file in the future.
  private async loadPGliteResources(): Promise<{
    fsBundle: Blob
    wasmModule: WebAssembly.Module
    vectorExtensionBundlePath: URL
  }> {
    try {
      return await loadEmbeddedPgliteResources()
    } catch (error) {
      console.error('Error loading PGlite resources:', error)
      console.error('Plugin resource path:', this.pgliteResourcePath)
      console.error('Vault config dir:', this.app.vault.configDir)
      throw error
    }
  }
}
