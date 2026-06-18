jest.mock('exponential-backoff', () => ({
  backOff: (fn: () => Promise<unknown>) => fn(),
}))

jest.mock('../../../utils/pdf/extractPdfText', () => ({
  PDF_INDEX_MAX_BYTES: 50_000_000,
  PDF_INDEX_MAX_PAGES: 1000,
  extractPdfText: jest.fn(),
}))

import { VectorManager } from './VectorManager'
import { ShardedVectorBackend } from './backend/sharded/ShardedVectorBackend'

const createInMemoryAdapter = () => {
  const writtenText = new Map<string, string>()
  const writtenBinary = new Map<string, ArrayBuffer>()
  const directories = new Set<string>()

  return {
    writtenText,
    writtenBinary,
    directories,
    adapter: {
      exists: jest.fn(async (path: string) => {
        return (
          writtenText.has(path) ||
          writtenBinary.has(path) ||
          directories.has(path)
        )
      }),
      list: jest.fn(),
      mkdir: jest.fn(async (path: string) => {
        directories.add(path)
      }),
      remove: jest.fn(async (path: string) => {
        writtenText.delete(path)
        writtenBinary.delete(path)
        directories.delete(path)
      }),
      rmdir: jest.fn(async (path: string) => {
        for (const key of [...writtenText.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) {
            writtenText.delete(key)
          }
        }
        for (const key of [...writtenBinary.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) {
            writtenBinary.delete(key)
          }
        }
        for (const key of [...directories]) {
          if (key === path || key.startsWith(`${path}/`)) {
            directories.delete(key)
          }
        }
      }),
      read: jest.fn(async (path: string) => {
        const value = writtenText.get(path)
        if (value === undefined) {
          throw new Error(`missing file: ${path}`)
        }
        return value
      }),
      readBinary: jest.fn(async (path: string) => {
        const value = writtenBinary.get(path)
        if (value === undefined) {
          throw new Error(`missing binary file: ${path}`)
        }
        return value
      }),
      write: jest.fn(async (path: string, value: string) => {
        writtenText.set(path, value)
      }),
      writeBinary: jest.fn(async (path: string, value: ArrayBuffer) => {
        writtenBinary.set(path, value)
      }),
    },
  }
}

const createEmbeddingModel = () => {
  const vectors = new Map<string, number[]>([
    ['alpha original', [1, 0, 0]],
    ['alpha updated', [0.8, 0.2, 0]],
    ['beta', [0, 1, 0]],
  ])

  return {
    id: 'test-model',
    dimension: 3,
    getEmbedding: jest.fn(async (text: string) => {
      const vector = vectors.get(text)
      if (!vector) {
        throw new Error(`missing embedding fixture for: ${text}`)
      }
      return vector
    }),
  }
}

describe('ShardedVectorBackend incremental integration', () => {
  it('updates and deletes rows through VectorManager reconcile without full rebuild', async () => {
    const storage = createInMemoryAdapter()
    let files = [
      {
        path: 'a.md',
        extension: 'md',
        stat: { mtime: 100, size: 'alpha original'.length },
      },
      {
        path: 'b.md',
        extension: 'md',
        stat: { mtime: 200, size: 'beta'.length },
      },
    ]
    const fileContents = new Map<string, string>([
      ['a.md', 'alpha original'],
      ['b.md', 'beta'],
    ])

    const app = {
      vault: {
        adapter: storage.adapter,
        getFiles: jest.fn(() => files),
        cachedRead: jest.fn(async (file: { path: string }) => {
          const value = fileContents.get(file.path)
          if (value === undefined) {
            throw new Error(`missing vault file: ${file.path}`)
          }
          return value
        }),
      },
    }

    const backend = new ShardedVectorBackend({
      app: app as never,
      baseDir: 'YOLO',
      maxVectorsPerShard: 2,
    })
    const manager = new VectorManager(app as never, {} as never, { backend })
    manager.setSaveCallback(async () => undefined)
    manager.setVacuumCallback(async () => undefined)
    const embeddingModel = createEmbeddingModel()

    await manager.reconcile(
      embeddingModel as never,
      {
        chunkSize: 1000,
        includePatterns: [],
        excludePatterns: [],
        indexPdf: false,
      },
      { scope: { kind: 'all' } },
    )

    let rows = await backend.listChunksForPaths('test-model', ['a.md', 'b.md'])
    expect(
      rows.map((row) => ({ path: row.path, mtime: row.mtime })).sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    ).toEqual([
      { path: 'a.md', mtime: 100 },
      { path: 'b.md', mtime: 200 },
    ])

    files = [
      {
        path: 'a.md',
        extension: 'md',
        stat: { mtime: 101, size: 'alpha updated'.length },
      },
    ]
    fileContents.set('a.md', 'alpha updated')
    fileContents.delete('b.md')

    await manager.reconcile(
      embeddingModel as never,
      {
        chunkSize: 1000,
        includePatterns: [],
        excludePatterns: [],
        indexPdf: false,
      },
      { scope: { kind: 'all' } },
    )

    rows = await backend.listChunksForPaths('test-model', ['a.md', 'b.md'])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      path: 'a.md',
      mtime: 101,
    })

    const search = await backend.performSimilaritySearch(
      [0.8, 0.2, 0],
      embeddingModel as never,
      {
        minSimilarity: -1,
        limit: 5,
      },
    )
    expect(search.map((row) => row.path)).toEqual(['a.md'])
  })
})
