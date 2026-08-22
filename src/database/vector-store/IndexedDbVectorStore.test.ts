// Installs IDBKeyRange (used by the store's compound-key ranges) as a global.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import type { VectorInsert } from '../../core/runtime-components/contracts'

import { IndexedDbVectorStore } from './IndexedDbVectorStore'
import { openVectorDatabase, vectorDatabaseName } from './vectorDatabase'

const MODEL_A = 'model-a'
const MODEL_B = 'model-b'

async function openStore(
  indexedDB: IDBFactory,
  namespaceId = 'test-namespace',
): Promise<IndexedDbVectorStore> {
  const db = await openVectorDatabase(
    indexedDB,
    vectorDatabaseName(namespaceId),
  )
  return new IndexedDbVectorStore(db)
}

function insert(
  overrides: Partial<VectorInsert> & { path: string },
): VectorInsert {
  return {
    path: overrides.path,
    mtime: overrides.mtime ?? 100,
    content: overrides.content ?? `content of ${overrides.path}`,
    content_hash: overrides.content_hash ?? null,
    model: overrides.model ?? MODEL_A,
    dimension: overrides.dimension ?? 3,
    embedding: 'embedding' in overrides ? overrides.embedding : [1, 0, 0],
    metadata: overrides.metadata ?? { startLine: 1, endLine: 1 },
  }
}

describe('IndexedDbVectorStore', () => {
  it('inserts, lists by path, and reports file mtimes (max per path)', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([
        insert({
          path: 'a.md',
          mtime: 100,
          metadata: { startLine: 1, endLine: 1 },
        }),
        insert({
          path: 'a.md',
          mtime: 200,
          metadata: { startLine: 2, endLine: 2 },
        }),
        insert({ path: 'b.md', mtime: 50 }),
      ])

      const mtimes = await store.getFileMtimes(MODEL_A)
      expect(mtimes).toEqual({ 'a.md': 200, 'b.md': 50 })

      const chunks = await store.listChunksForPaths(MODEL_A, ['a.md'])
      expect(chunks).toHaveLength(2)
      expect(chunks.map((c) => c.mtime).sort()).toEqual([100, 200])
    } finally {
      store.close()
    }
  })

  it('deletes vectors by id', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([
        insert({ path: 'a.md' }),
        insert({ path: 'b.md' }),
      ])
      const rows = await store.listChunksForPaths(MODEL_A, ['a.md', 'b.md'])
      const idToDelete = rows.find((r) => r.path === 'a.md')!.id

      await store.deleteVectorsByIds([idToDelete])

      const remaining = await store.listChunksForPaths(MODEL_A, [
        'a.md',
        'b.md',
      ])
      expect(remaining.map((r) => r.path)).toEqual(['b.md'])
    } finally {
      store.close()
    }
  })

  it('deletes vectors by path, scoped to a model', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([
        insert({ path: 'a.md', model: MODEL_A }),
        insert({ path: 'a.md', model: MODEL_B }),
      ])

      await store.deleteVectorsByPaths(MODEL_A, ['a.md'])

      expect(await store.listChunksForPaths(MODEL_A, ['a.md'])).toEqual([])
      expect(await store.listChunksForPaths(MODEL_B, ['a.md'])).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('bumps mtime by id', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([insert({ path: 'a.md', mtime: 100 })])
      const [row] = await store.listChunksForPaths(MODEL_A, ['a.md'])

      await store.bumpMtimeByIds([{ id: row.id, mtime: 999 }])

      const mtimes = await store.getFileMtimes(MODEL_A)
      expect(mtimes['a.md']).toBe(999)
    } finally {
      store.close()
    }
  })

  it('truncates one model without touching another', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([
        insert({ path: 'a.md', model: MODEL_A }),
        insert({ path: 'a.md', model: MODEL_B }),
      ])

      await store.truncateModel(MODEL_A)

      expect(await store.listChunksForPaths(MODEL_A, ['a.md'])).toEqual([])
      expect(await store.listChunksForPaths(MODEL_B, ['a.md'])).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('clears vectors for a set of model ids', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([
        insert({ path: 'a.md', model: MODEL_A }),
        insert({ path: 'a.md', model: MODEL_B }),
      ])

      await store.clearVectorsByModelIds([MODEL_A, MODEL_B])

      expect(await store.listChunksForPaths(MODEL_A, ['a.md'])).toEqual([])
      expect(await store.listChunksForPaths(MODEL_B, ['a.md'])).toEqual([])
    } finally {
      store.close()
    }
  })

  it('reports per-model row counts and approximate byte sizes', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([
        insert({
          path: 'a.md',
          model: MODEL_A,
          dimension: 3,
          content: 'hello',
        }),
        insert({
          path: 'b.md',
          model: MODEL_A,
          dimension: 3,
          content: 'world!',
        }),
        insert({ path: 'a.md', model: MODEL_B, dimension: 4, content: 'x' }),
      ])

      const stats = await store.getEmbeddingStats()
      expect(stats).toEqual([
        {
          model: MODEL_A,
          rowCount: 2,
          totalDataBytes: 3 * 4 + 5 * 2 + (3 * 4 + 6 * 2),
        },
        {
          model: MODEL_B,
          rowCount: 1,
          totalDataBytes: 4 * 4 + 1 * 2,
        },
      ])
    } finally {
      store.close()
    }
  })

  describe('performSimilaritySearch', () => {
    it('ranks by cosine similarity and respects limit', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'same.md', embedding: [1, 0, 0] }),
          insert({ path: 'orthogonal.md', embedding: [0, 1, 0] }),
          insert({ path: 'opposite.md', embedding: [-1, 0, 0] }),
        ])

        const results = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: -1, limit: 2 },
        )

        expect(results.map((r) => r.path)).toEqual(['same.md', 'orthogonal.md'])
        expect(results[0].similarity).toBeCloseTo(1)
        expect(results[0].content).toBe('content of same.md')
      } finally {
        store.close()
      }
    })

    it('excludes rows at or below minSimilarity', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'same.md', embedding: [1, 0, 0] }),
          insert({ path: 'orthogonal.md', embedding: [0, 1, 0] }),
        ])

        const results = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: 0, limit: 10 },
        )

        expect(results.map((r) => r.path)).toEqual(['same.md'])
      } finally {
        store.close()
      }
    })

    it('filters by scope.files', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'a.md', embedding: [1, 0, 0] }),
          insert({ path: 'b.md', embedding: [1, 0, 0] }),
        ])

        const results = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          {
            minSimilarity: -1,
            limit: 10,
            scope: { files: ['a.md'], folders: [] },
          },
        )

        expect(results.map((r) => r.path)).toEqual(['a.md'])
      } finally {
        store.close()
      }
    })

    it('filters by scope.folders using a path-prefix match', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'docs/a.md', embedding: [1, 0, 0] }),
          insert({ path: 'docs/sub/b.md', embedding: [1, 0, 0] }),
          insert({ path: 'other/c.md', embedding: [1, 0, 0] }),
          // A path that merely starts with the folder name (no separator) must not match.
          insert({ path: 'docsx/d.md', embedding: [1, 0, 0] }),
        ])

        const results = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          {
            minSimilarity: -1,
            limit: 10,
            scope: { files: [], folders: ['docs'] },
          },
        )

        expect(results.map((r) => r.path).sort()).toEqual([
          'docs/a.md',
          'docs/sub/b.md',
        ])
      } finally {
        store.close()
      }
    })

    it('treats an empty scope (no files, no folders) as unscoped', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'a.md', embedding: [1, 0, 0] }),
          insert({ path: 'b.md', embedding: [1, 0, 0] }),
        ])

        const results = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: -1, limit: 10, scope: { files: [], folders: [] } },
        )

        expect(results.map((r) => r.path).sort()).toEqual(['a.md', 'b.md'])
      } finally {
        store.close()
      }
    })

    it('lazily loads the in-memory index, then keeps it in sync with later writes', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'a.md', embedding: [1, 0, 0] }),
        ])

        const first = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: -1, limit: 10 },
        )
        expect(first.map((r) => r.path)).toEqual(['a.md'])

        // Written after the index was already loaded — must be reflected
        // without needing to close/reopen the store.
        await store.insertVectors([
          insert({ path: 'b.md', embedding: [1, 0, 0] }),
        ])

        const second = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: -1, limit: 10 },
        )
        expect(second.map((r) => r.path).sort()).toEqual(['a.md', 'b.md'])

        // Deleting a row after load must also disappear from search results.
        const rows = await store.listChunksForPaths(MODEL_A, ['a.md'])
        await store.deleteVectorsByIds([rows[0].id])

        const third = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: -1, limit: 10 },
        )
        expect(third.map((r) => r.path)).toEqual(['b.md'])
      } finally {
        store.close()
      }
    })
  })

  it('persists data across store instances backed by the same underlying database', async () => {
    const indexedDB = new IDBFactory()
    const namespaceId = 'persisted-namespace'
    const first = await openStore(indexedDB, namespaceId)
    await first.insertVectors([insert({ path: 'a.md' })])
    first.close()

    const second = await openStore(indexedDB, namespaceId)
    try {
      const mtimes = await second.getFileMtimes(MODEL_A)
      expect(mtimes).toEqual({ 'a.md': 100 })
    } finally {
      second.close()
    }
  })

  it('requires an embedding on every inserted row', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await expect(
        store.insertVectors([insert({ path: 'a.md', embedding: undefined })]),
      ).rejects.toThrow(/requires an embedding/)
    } finally {
      store.close()
    }
  })
})
