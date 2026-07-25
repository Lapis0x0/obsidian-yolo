import { PGlite } from '@electric-sql/pglite'
import { PGliteWorker } from '@electric-sql/pglite/worker'
import { type PgliteDatabase, drizzle } from 'drizzle-orm/pglite'
import migrations from 'virtual:pglite-migrations'
import workerSource from 'virtual:pglite-worker-script'

import { createVectorStore } from './vectorStore'

type PgliteClient = PGlite | PGliteWorker
type MigratableDatabase = PgliteDatabase & {
  dialect: {
    migrate(
      migrations: unknown,
      session: unknown,
      options: { migrationsTable: string },
    ): Promise<void>
  }
  session: unknown
}

type RuntimeResources = Readonly<{
  fsBundle: Blob
  pgliteWasmModule: WebAssembly.Module
  initdbWasmModule: WebAssembly.Module
  vectorExtensionBlob: Blob
  vectorExtensionBundlePath: URL
}>

async function createWorkerClient(
  options: Record<string, unknown>,
): Promise<PgliteClient | null> {
  if (
    typeof Worker === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined'
  ) {
    return null
  }
  const url = URL.createObjectURL(
    new Blob([workerSource], { type: 'application/javascript' }),
  )
  let worker: Worker | null = null
  try {
    worker = new Worker(url)
    const client = await PGliteWorker.create(worker, options)
    const smoke = await Promise.race([
      client.exec('SELECT 1 as ok;').then(() => 'ok' as const),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 30_000),
      ),
    ])
    if (smoke === 'timeout') {
      worker.terminate()
      throw new Error('PGlite worker smoke test timed out')
    }
    return client
  } catch (error) {
    worker?.terminate()
    console.warn(
      '[YOLO] PGlite Worker unavailable, falling back to main thread',
      error,
    )
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function migrationState(client: PgliteClient): Promise<string> {
  try {
    const table = await client.query(
      `SELECT to_regclass('public.drizzle_migrations') AS table_name`,
    )
    if (!(table.rows?.[0] as { table_name?: string } | undefined)?.table_name) {
      return 'missing'
    }
    const result = await client.query(
      `SELECT count(*)::text AS count, COALESCE(MAX(created_at)::text, '') AS latest_created_at FROM drizzle_migrations`,
    )
    const row = (result.rows?.[0] ?? {}) as {
      count?: string
      latest_created_at?: string
    }
    return `${row.count ?? '0'}:${row.latest_created_at ?? ''}`
  } catch {
    return 'unknown'
  }
}

globalThis.__yolo_register_runtime_component__({
  id: 'pglite-engine',
  create() {
    let disposed = false
    const sessions = new Set<{ close(): Promise<void> }>()
    return Object.freeze({
      async createSession(options: {
        resources: RuntimeResources
        snapshot?: Blob
      }) {
        if (disposed) throw new Error('PGlite engine is disposed')
        const { resources } = options
        const baseOptions: Record<string, unknown> = {
          ...(options.snapshot ? { loadDataDir: options.snapshot } : {}),
          fsBundle: resources.fsBundle,
          pgliteWasmModule: resources.pgliteWasmModule,
          initdbWasmModule: resources.initdbWasmModule,
          _vectorExtensionBlob: resources.vectorExtensionBlob,
        }
        const workerClient = await createWorkerClient(baseOptions)
        const client =
          workerClient ??
          (await PGlite.create({
            ...baseOptions,
            extensions: { vector: resources.vectorExtensionBundlePath },
          }))
        const database = drizzle(client as PGlite)
        const migratable = database as Partial<MigratableDatabase>
        if (
          typeof migratable.dialect?.migrate !== 'function' ||
          migratable.session === undefined
        ) {
          await client.close()
          throw new Error('Drizzle migration API is unavailable')
        }
        const before = await migrationState(client)
        await migratable.dialect.migrate(migrations, migratable.session, {
          migrationsTable: 'drizzle_migrations',
        })
        const after = await migrationState(client)
        let closed = false
        const session = Object.freeze({
          vectorStore: createVectorStore(database),
          migrationChanged: before !== after,
          async cleanupLegacyStaging(): Promise<number> {
            const result = await database.execute(
              `DELETE FROM embeddings WHERE model LIKE '%::staging:%'`,
            )
            return Number(
              (result as unknown as { affectedRows?: number }).affectedRows ??
                0,
            )
          },
          async vacuum(): Promise<void> {
            await client.exec('VACUUM FULL;')
          },
          async dump(): Promise<Blob> {
            if (closed) throw new Error('PGlite session is closed')
            return client.dumpDataDir('gzip')
          },
          async close(): Promise<void> {
            if (closed) return
            closed = true
            sessions.delete(session)
            await client.close()
          },
        })
        sessions.add(session)
        return session
      },
      async dispose(): Promise<void> {
        if (disposed) return
        disposed = true
        await Promise.all([...sessions].map((session) => session.close()))
      },
    })
  },
})
