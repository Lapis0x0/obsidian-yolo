// Installs IDBKeyRange (used by the store's compound-key ranges) as a global.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import type { VectorInsert } from '../../core/runtime-components/contracts'
import { yieldToMain } from '../../utils/common/yield-to-main'

import { IndexedDbVectorStore } from './IndexedDbVectorStore'
import { openVectorDatabase, vectorDatabaseName } from './vectorDatabase'
import { VectorIndex } from './vectorIndex'

jest.mock('../../utils/common/yield-to-main', () => ({
  yieldToMain: jest.fn(() => Promise.resolve()),
}))
const yieldToMainMock = yieldToMain as jest.MockedFunction<typeof yieldToMain>

const MODEL_A = 'model-a'
const MODEL_B = 'model-b'

async function openStore(
  indexedDB: IDBFactory,
  namespaceId = 'test-namespace',
  options: ConstructorParameters<typeof IndexedDbVectorStore>[1] = {},
  kbId = 'test-kb',
): Promise<IndexedDbVectorStore> {
  const db = await openVectorDatabase(
    indexedDB,
    vectorDatabaseName(namespaceId, kbId),
  )
  return new IndexedDbVectorStore(db, options)
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

  it('reports per-model row counts and vectorBytes (rowCount * dimension * 4) via index-only reads', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([
        insert({
          path: 'a.md',
          model: MODEL_A,
          dimension: 3,
          embedding: [1, 0, 0],
          content: 'hello',
        }),
        insert({
          path: 'b.md',
          model: MODEL_A,
          dimension: 3,
          embedding: [0, 1, 0],
          content: 'world!',
        }),
        insert({
          path: 'a.md',
          model: MODEL_B,
          dimension: 4,
          embedding: [1, 0, 0, 0],
          content: 'x',
        }),
      ])

      const stats = await store.getEmbeddingStats()
      expect(stats).toEqual([
        { model: MODEL_A, rowCount: 2, vectorBytes: 2 * 3 * 4 },
        { model: MODEL_B, rowCount: 1, vectorBytes: 1 * 4 * 4 },
      ])
    } finally {
      store.close()
    }
  })

  it('reports an empty array of stats for an empty store', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      expect(await store.getEmbeddingStats()).toEqual([])
    } finally {
      store.close()
    }
  })

  describe('listVectorsForPath', () => {
    it("returns one file's stored vectors, L2-normalized, scoped to the model", async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'a.md', embedding: [2, 0, 0] }),
          insert({ path: 'a.md', embedding: [0, 3, 0] }),
          insert({ path: 'b.md', embedding: [0, 0, 1] }),
          insert({ path: 'a.md', model: MODEL_B, embedding: [0, 0, 4] }),
        ])

        const vectors = await store.listVectorsForPath(MODEL_A, 'a.md')

        expect(vectors.map((v) => Array.from(v))).toEqual([
          [1, 0, 0],
          [0, 1, 0],
        ])
      } finally {
        store.close()
      }
    })

    it('returns an empty array for a path with no rows', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([insert({ path: 'a.md' })])

        expect(await store.listVectorsForPath(MODEL_A, 'missing.md')).toEqual(
          [],
        )
      } finally {
        store.close()
      }
    })
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

    it('excludes rows matching scope.exclude even with no include restriction', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'Private/secret.md', embedding: [1, 0, 0] }),
          insert({ path: 'Notes/a.md', embedding: [1, 0, 0] }),
        ])

        const results = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          {
            minSimilarity: -1,
            limit: 10,
            scope: { files: [], folders: [], exclude: ['Private'] },
          },
        )

        expect(results.map((r) => r.path)).toEqual(['Notes/a.md'])
      } finally {
        store.close()
      }
    })

    it('lets scope.exclude override a matching scope.folders include', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'Projects/public.md', embedding: [1, 0, 0] }),
          insert({ path: 'Projects/Private/secret.md', embedding: [1, 0, 0] }),
        ])

        const results = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          {
            minSimilarity: -1,
            limit: 10,
            scope: {
              files: [],
              folders: ['Projects'],
              exclude: ['Projects/Private'],
            },
          },
        )

        expect(results.map((r) => r.path)).toEqual(['Projects/public.md'])
      } finally {
        store.close()
      }
    })

    it('lets scope.exclude override an explicit scope.files entry for a single file', async () => {
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
            scope: { files: ['a.md', 'b.md'], folders: [], exclude: ['a.md'] },
          },
        )

        expect(results.map((r) => r.path)).toEqual(['b.md'])
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

    it('returns the exact float32 rescored similarity, not the int8-approximate scan score', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        // A 3-way (non axis-aligned) embedding: quantizing it to int8 loses
        // information in every component, not just a single dominant one,
        // so the int8 scan's approximate score provably differs from the
        // exact float32 dot product below (diff ~5e-4, confirmed offline).
        const rawEmbedding = [0.6, 0.5, 0.4]
        const rawQuery = [0.7, 0.2, 0.1]
        await store.insertVectors([
          insert({ path: 'a.md', embedding: rawEmbedding, dimension: 3 }),
        ])

        const results = await store.performSimilaritySearch(
          rawQuery,
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: -1, limit: 10 },
        )

        const normalize = (v: number[]): number[] => {
          const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
          return v.map((x) => x / norm)
        }
        const nEmbedding = normalize(rawEmbedding)
        const nQuery = normalize(rawQuery)
        const expectedExact = nEmbedding.reduce(
          (s, x, i) => s + x * nQuery[i],
          0,
        )

        expect(results).toHaveLength(1)
        expect(results[0].similarity).toBeCloseTo(expectedExact, 6)
      } finally {
        store.close()
      }
    })

    it('rescues a true top-limit row that the int8 scan under-ranked, via the widened candidate window', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        // Fixed 8-dim query/rows (generated offline) where row36's exact
        // cosine similarity beats row16's, but int8 quantization's rounding
        // error flips that order for their *approximate* scan scores:
        //   exact:  14 > 26 > 8 > 12 > 36 > 16
        //   approx: 14 > 26 > 8 > 12 > 16 > 36
        // A naive top-5 taken directly from the int8 scan (no widened
        // window) would keep row16 and drop row36 — wrong. The widened
        // candidate window (`max(limit*4, 32)`, comfortably >= this
        // dataset's 6 rows) pulls row36 in as a candidate too, and the
        // float32 rescore then restores the correct exact order.
        const query = [
          0.3401840681576168, 0.44217376675867825, -0.5658130768935278,
          0.21741690537008418, -0.5624539149298328, 0.06779534071673557,
          0.006484845538099068, -0.01870676811487791,
        ]
        const rowsById: Record<string, number[]> = {
          'row14.md': [
            0.43635666893858177, 0.24053611108948944, -0.4667686154276863,
            0.02765760619661362, -0.37645881716345236, -0.4600080470180685,
            0.41815088750997437, -0.07013233305046293,
          ],
          'row26.md': [
            -0.0678745711198131, 0.2369251161661632, -0.42130066785899134,
            0.4431149050244007, -0.4004586386484396, 0.02251815623730606,
            0.4876504587947706, -0.40833479099936654,
          ],
          'row8.md': [
            0.08934015886167916, 0.40663777525105965, -0.5019935144517905,
            0.007459602612135602, -0.08724821188974084, 0.04945169208293895,
            0.5299237409944824, -0.532666903358222,
          ],
          'row12.md': [
            0.5024294335631057, 0.0888181825164134, -0.01001101202554831,
            0.38813205687130564, -0.4456959899300151, -0.30180090505572843,
            -0.2631000687043237, 0.47956118788600793,
          ],
          'row36.md': [
            -0.41282700507906067, -0.05542082841598303, -0.3879277102479401,
            0.48451565097630994, -0.35737258136098315, -0.5567818382789729,
            -0.042086121516437036, -0.04203156273220412,
          ],
          'row16.md': [
            0.32180688928483403, 0.38879404906043014, 0.22841130845050622,
            0.6614066071832606, -0.10755836554959254, -0.48621204115490413,
            0.08332139503489583, 0.027123453614743376,
          ],
        }

        await store.insertVectors(
          Object.entries(rowsById).map(([path, embedding]) =>
            insert({ path, embedding, dimension: 8 }),
          ),
        )

        const results = await store.performSimilaritySearch(
          query,
          { id: MODEL_A, dimension: 8 },
          { minSimilarity: -1, limit: 5 },
        )

        expect(results.map((r) => r.path)).toEqual([
          'row14.md',
          'row26.md',
          'row8.md',
          'row12.md',
          'row36.md',
        ])
      } finally {
        store.close()
      }
    })

    it('applies minSimilarity strictly on the exact score, dropping a row whose approx score alone would have passed', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        // Same row36/query pair as above: its exact score (~0.323665) and
        // int8-approximate scan score (~0.323691) straddle this threshold.
        // The scan's own filter (loosened by INT8_SCAN_SLACK) lets it
        // through as a candidate, but the exact rescore must still cut it.
        const query = [
          0.3401840681576168, 0.44217376675867825, -0.5658130768935278,
          0.21741690537008418, -0.5624539149298328, 0.06779534071673557,
          0.006484845538099068, -0.01870676811487791,
        ]
        const embedding = [
          -0.41282700507906067, -0.05542082841598303, -0.3879277102479401,
          0.48451565097630994, -0.35737258136098315, -0.5567818382789729,
          -0.042086121516437036, -0.04203156273220412,
        ]
        await store.insertVectors([
          insert({ path: 'row36.md', embedding, dimension: 8 }),
        ])

        const results = await store.performSimilaritySearch(
          query,
          { id: MODEL_A, dimension: 8 },
          { minSimilarity: 0.32368, limit: 10 },
        )

        expect(results).toEqual([])
      } finally {
        store.close()
      }
    })

    it('applies scope filters on top of the int8-scan + rescore path', async () => {
      const indexedDB = new IDBFactory()
      const store = await openStore(indexedDB)
      try {
        await store.insertVectors([
          insert({ path: 'docs/a.md', embedding: [0.6, 0.5, 0.4] }),
          insert({ path: 'other/b.md', embedding: [0.6, 0.5, 0.4] }),
        ])

        const results = await store.performSimilaritySearch(
          [0.7, 0.2, 0.1],
          { id: MODEL_A, dimension: 3 },
          {
            minSimilarity: -1,
            limit: 10,
            scope: { files: [], folders: ['docs'] },
          },
        )

        expect(results.map((r) => r.path)).toEqual(['docs/a.md'])
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

  it('rejects insertVectors when an embedding length does not match its declared dimension, before writing anything', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await expect(
        store.insertVectors([
          insert({ path: 'good.md' }),
          // insert()'s default embedding is length 3; declaring dimension 4
          // for it is the mismatch under test.
          insert({ path: 'bad.md', dimension: 4 }),
        ]),
      ).rejects.toThrow(/does not match declared dimension/)

      // Nothing committed, not even "good.md" (which would have been valid
      // on its own) — validation runs as a pass over the whole batch before
      // the write transaction opens (Codex finding 1.5).
      expect(
        await store.listChunksForPaths(MODEL_A, ['good.md', 'bad.md']),
      ).toEqual([])
    } finally {
      store.close()
    }
  })

  it('rejects a query vector whose length does not match the model dimension', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await expect(
        store.performSimilaritySearch(
          [1, 0],
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: -1, limit: 10 },
        ),
      ).rejects.toThrow(/does not match model dimension/)
    } finally {
      store.close()
    }
  })

  it('reloads the in-memory index when the requested dimension differs from what is loaded (Codex 1.4)', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([
        insert({ path: 'a.md', dimension: 3, embedding: [1, 0, 0] }),
      ])
      const first = await store.performSimilaritySearch(
        [1, 0, 0],
        { id: MODEL_A, dimension: 3 },
        { minSimilarity: -1, limit: 10 },
      )
      expect(first.map((r) => r.path)).toEqual(['a.md'])

      // The model's configured dimension changes (no truncate/unload in
      // between) and a new row is inserted at the new dimension.
      await store.insertVectors([
        insert({ path: 'b.md', dimension: 4, embedding: [0, 0, 0, 1] }),
      ])

      // A dimension-4 query must see b.md via a freshly loaded dimension-4
      // index — not silently keep serving the stale dimension-3 index
      // cached by the first search.
      const second = await store.performSimilaritySearch(
        [0, 0, 0, 1],
        { id: MODEL_A, dimension: 4 },
        { minSimilarity: -1, limit: 10 },
      )
      expect(second.map((r) => r.path)).toEqual(['b.md'])
    } finally {
      store.close()
    }
  })

  it('reserves exact capacity from the row count before loading, so the load never grows the matrix', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      const rows = Array.from({ length: 50 }, (_, i) =>
        insert({ path: `f${i}.md` }),
      )
      await store.insertVectors(rows)

      const reserveSpy = jest.spyOn(VectorIndex.prototype, 'reserve')
      try {
        const results = await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: -1, limit: 50 },
        )
        expect(results).toHaveLength(50)
        expect(reserveSpy).toHaveBeenCalledWith(50)
      } finally {
        reserveSpy.mockRestore()
      }
    } finally {
      store.close()
    }
  })

  it('returns the right rows when a delete past the compaction threshold lands mid-scan', async () => {
    // Regression for Codex finding 1.1: the scan yields, a concurrent delete
    // tombstones >25% of the rows (all of them *before* the hits, so a
    // compaction would shift the hits' row indices), and the scan resumes.
    // Compaction must be deferred until the scan ends, and the candidate ids
    // must be resolved before that deferred compaction remaps the rows.
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB, 'mid-scan', { scanYieldEvery: 20 })
    try {
      const fillers = Array.from({ length: 30 }, (_, i) =>
        insert({ path: `filler-${i}.md`, embedding: [0, 1, 0] }),
      )
      const hits = Array.from({ length: 10 }, (_, i) =>
        insert({ path: `hit-${i}.md`, embedding: [1, 0, 0] }),
      )
      await store.insertVectors([...fillers, ...hits])

      // Load the index with a plain query first so the racy query below
      // starts scanning immediately.
      await store.performSimilaritySearch(
        [0, 0, 1],
        { id: MODEL_A, dimension: 3 },
        { minSimilarity: -1, limit: 1 },
      )

      yieldToMainMock.mockImplementationOnce(async () => {
        await store.deleteVectorsByPaths(
          MODEL_A,
          fillers.map((row) => row.path),
        )
      })
      const results = await store.performSimilaritySearch(
        [1, 0, 0],
        { id: MODEL_A, dimension: 3 },
        { minSimilarity: 0.5, limit: 10 },
      )
      expect(results.map((r) => r.path).sort()).toEqual(
        hits.map((row) => row.path).sort(),
      )
      // The deferred compaction ran once the scan released the index.
      const stats = await store.getEmbeddingStats()
      expect(stats.find((s) => s.model === MODEL_A)?.rowCount).toBe(10)
    } finally {
      store.close()
    }
  })

  it('brackets each search with beginScan/endScan on the loaded index', async () => {
    const indexedDB = new IDBFactory()
    const store = await openStore(indexedDB)
    try {
      await store.insertVectors([insert({ path: 'a.md' })])
      const beginSpy = jest.spyOn(VectorIndex.prototype, 'beginScan')
      const endSpy = jest.spyOn(VectorIndex.prototype, 'endScan')
      try {
        await store.performSimilaritySearch(
          [1, 0, 0],
          { id: MODEL_A, dimension: 3 },
          { minSimilarity: -1, limit: 10 },
        )
        expect(beginSpy).toHaveBeenCalledTimes(1)
        expect(endSpy).toHaveBeenCalledTimes(1)
      } finally {
        beginSpy.mockRestore()
        endSpy.mockRestore()
      }
    } finally {
      store.close()
    }
  })
})
