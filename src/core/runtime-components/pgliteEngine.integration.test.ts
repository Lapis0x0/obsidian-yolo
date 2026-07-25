import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { type PgliteDatabase, drizzle } from 'drizzle-orm/pglite'

import * as migrationModule from '../../../runtime-components/pglite-engine/migrations.json'
import { createVectorStore } from '../../../runtime-components/pglite-engine/src/vectorStore'

const migrations = Array.isArray(migrationModule)
  ? migrationModule
  : (migrationModule as unknown as { default: typeof migrationModule }).default

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

async function open(snapshot?: Blob): Promise<{
  client: PGlite
  store: ReturnType<typeof createVectorStore>
}> {
  const client = await PGlite.create({
    ...(snapshot ? { loadDataDir: snapshot } : {}),
    extensions: { vector },
  })
  const database = drizzle(client) as unknown as MigratableDatabase
  await database.dialect.migrate(migrations, database.session, {
    migrationsTable: 'drizzle_migrations',
  })
  return { client, store: createVectorStore(database) }
}

const describePgliteIntegration = process.execArgv.includes(
  '--experimental-vm-modules',
)
  ? describe
  : describe.skip

describePgliteIntegration('PGlite runtime component contract', () => {
  jest.setTimeout(30_000)

  it('preserves migrations, vector search, dump, close, and snapshot reopen', async () => {
    const embedding = Array.from({ length: 128 }, (_, index) =>
      index === 0 ? 1 : 0,
    )
    const first = await open()
    await first.store.insertVectors([
      {
        path: 'notes/runtime-component.md',
        mtime: 123,
        content: 'runtime component integration fixture',
        content_hash: 'fixture',
        model: 'fixture-model',
        dimension: 128,
        embedding,
        metadata: { startLine: 1, endLine: 1 },
      },
    ])
    expect(
      await first.store.performSimilaritySearch(
        embedding,
        { id: 'fixture-model', dimension: 128 },
        { minSimilarity: 0.9, limit: 5 },
      ),
    ).toHaveLength(1)

    const snapshot = await first.client.dumpDataDir('gzip')
    await first.client.close()

    const reopened = await open(snapshot)
    try {
      const results = await reopened.store.performSimilaritySearch(
        embedding,
        { id: 'fixture-model', dimension: 128 },
        { minSimilarity: 0.9, limit: 5 },
      )
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        path: 'notes/runtime-component.md',
        content_hash: 'fixture',
        model: 'fixture-model',
        dimension: 128,
      })
    } finally {
      await reopened.client.close()
    }
  })
})
