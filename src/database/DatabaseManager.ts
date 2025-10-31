import { PGlite } from '@electric-sql/pglite'
import { PgliteDatabase, drizzle } from 'drizzle-orm/pglite'
import { App, normalizePath } from 'obsidian'

import { PGLITE_DB_PATH, PLUGIN_ID } from '../constants'

import { PGLiteAbortedException } from './exception'
import migrations from './migrations.json'
import { VectorManager } from './modules/vector/VectorManager'

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

    console.log('Smart composer database initialized.', dbManager)

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
      console.log('createNewDatabase error', error)
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
      console.log('loadExistingDatabase error', error)
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
      // Workaround for running Drizzle migrations in a browser environment
      // This method uses an undocumented API to perform migrations
      // See: https://github.com/drizzle-team/drizzle-orm/discussions/2532#discussioncomment-10780523
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
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
      const blob: Blob = await this.pgClient.dumpDataDir('gzip')
      await this.app.vault.adapter.writeBinary(
        this.dbPath,
        Buffer.from(await blob.arrayBuffer()),
      )
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

  // TODO: This function is a temporary workaround chosen due to the difficulty of bundling postgres.wasm and postgres.data from node_modules into a single JS file. The ultimate goal is to bundle everything into one JS file in the future.
  private async loadPGliteResources(): Promise<{
    fsBundle: Blob
    wasmModule: WebAssembly.Module
    vectorExtensionBundlePath: URL
  }> {
    try {
      const candidateBaseUrls: URL[] = []
      const seen = new Set<string>()

      const addCandidateUrl = (candidate: string | URL | null | undefined) => {
        if (!candidate) {
          return
        }
        try {
          const rawUrl =
            candidate instanceof URL
              ? new URL(candidate.href)
              : new URL(candidate)
          // Obsidian 会追加缓存参数 (?123)，需要移除查询与哈希，避免相对路径被错误解析
          rawUrl.search = ''
          rawUrl.hash = ''

          const href = rawUrl.href.endsWith('/')
            ? rawUrl.href
            : `${rawUrl.href}/`
          const key = href
          if (!seen.has(key)) {
            seen.add(key)
            candidateBaseUrls.push(new URL(key))
          }
        } catch {
          // ignore invalid candidate
        }
      }

      const addFromResourcePath = (path: string | undefined) => {
        if (!path) {
          return
        }
        try {
          const resourcePath = this.app.vault.adapter.getResourcePath(path)
          console.log(
            `[PGlite] Resolving resource path:`,
            path,
            '→',
            resourcePath,
          )
          addCandidateUrl(resourcePath)
        } catch (error) {
          console.warn(`[PGlite] Failed to resolve resource path:`, path, error)
        }
      }

      // 优先使用传入的 pgliteResourcePath（基于 manifest.id）
      addFromResourcePath(this.pgliteResourcePath)

      // 作为备选，尝试使用固定的插件 ID（向后兼容旧版本）
      if (
        this.pgliteResourcePath &&
        !this.pgliteResourcePath.includes(PLUGIN_ID)
      ) {
        addFromResourcePath(
          normalizePath(
            `${this.app.vault.configDir}/plugins/${PLUGIN_ID}/vendor/pglite`,
          ),
        )
      }

      // 最后尝试使用相对路径（开发模式）
      addCandidateUrl(new URL('./vendor/pglite/', import.meta.url))

      let lastError: unknown = null

      for (const baseUrl of candidateBaseUrls) {
        try {
          const fsUrl = new URL('postgres.data', baseUrl)
          const wasmUrl = new URL('postgres.wasm', baseUrl)

          const [fsResponse, wasmResponse] = await Promise.all([
            fetch(fsUrl.href),
            fetch(wasmUrl.href),
          ])

          if (!fsResponse.ok || !wasmResponse.ok) {
            lastError = new Error(
              'Failed to load PGlite assets from local bundle',
            )
            continue
          }

          const fsBundle = new Blob([await fsResponse.arrayBuffer()], {
            type: 'application/octet-stream',
          })
          const wasmModule = await WebAssembly.compile(
            await wasmResponse.arrayBuffer(),
          )
          const vectorExtensionBundlePath = new URL('vector.tar.gz', baseUrl)

          return { fsBundle, wasmModule, vectorExtensionBundlePath }
        } catch (error) {
          lastError = error
        }
      }

      if (lastError) {
        console.error(
          'All PGlite resource paths failed. Attempted URLs:',
          candidateBaseUrls.map((u) => u.href),
        )
        throw lastError instanceof Error
          ? lastError
          : new Error(String(lastError))
      }
      throw new Error(
        'Failed to resolve PGlite bundle path - no candidate URLs generated',
      )
    } catch (error) {
      console.error('Error loading PGlite resources:', error)
      console.error('Plugin resource path:', this.pgliteResourcePath)
      console.error('Vault config dir:', this.app.vault.configDir)
      throw error
    }
  }
}
