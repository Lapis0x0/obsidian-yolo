import { ShardedVectorBackend } from './ShardedVectorBackend'
import initSqlJs from 'sql.js'

describe('ShardedVectorBackend', () => {
  const createApp = () =>
    ({
      vault: {
        adapter: {
          exists: jest.fn(),
          list: jest.fn(),
          mkdir: jest.fn(),
          remove: jest.fn(),
          rmdir: jest.fn(),
          read: jest.fn(),
          readBinary: jest.fn(),
          write: jest.fn(),
          writeBinary: jest.fn(),
        },
      },
    }) as {
      vault: {
        adapter: {
          exists: jest.Mock
          list: jest.Mock
          mkdir: jest.Mock
          remove: jest.Mock
          rmdir: jest.Mock
          read: jest.Mock
          readBinary: jest.Mock
          write: jest.Mock
          writeBinary: jest.Mock
        }
      }
    }

  const asApp = (app: ReturnType<typeof createApp>) => app as never

  const createSearchableShardApp = async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        path === 'YOLO/rag-index/v1/manifest.json'
      )
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await backend.writeTempShardArtifacts({
      modelNamespace: 'openai/text-embedding-3-small@3',
      runId: 'run-123',
      shardId: '000001',
      rows: [
        {
          chunkId: 'c1',
          path: 'a.md',
          mtime: 1,
          contentHash: 'h1',
          startOffset: 0,
          endOffset: 5,
          startLine: 1,
          endLine: 1,
          page: undefined,
          text: 'alpha',
          metadata: { startLine: 1, endLine: 1 },
          embedding: [1, 0, 0],
        },
        {
          chunkId: 'c2',
          path: 'b.md',
          mtime: 2,
          contentHash: 'h2',
          startOffset: 6,
          endOffset: 10,
          startLine: 2,
          endLine: 3,
          page: 4,
          text: 'beta',
          metadata: { startLine: 2, endLine: 3, page: 4 },
          embedding: [0, 1, 0],
        },
      ],
    })

    writtenText.set(
      'YOLO/rag-index/v1/manifest.json',
      JSON.stringify({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: 'openai/text-embedding-3-small@3',
        updatedAt: 1,
        shards: [
          {
            id: '000001',
            relativePath:
              'models/openai/text-embedding-3-small@3/shards/.build-run-123-000001',
            state: 'ready',
            dimension: 3,
            vectorCount: 2,
            checksums: {
              chunksSqlite: 'sha256:x',
              vectorsF32: 'sha256:x',
              indexBin: 'sha256:x',
              tombstonesBin: 'sha256:x',
              shardMeta: 'sha256:x',
            },
          },
        ],
      }),
    )

    return app
  }

  it('reports sharded backend kind', () => {
    const app = createApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: '.yolo',
    })

    expect(backend.kind).toBe('sharded')
  })

  it('creates root layout when missing', async () => {
    const app = createApp()
    app.vault.adapter.exists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await backend.ensureRootLayout()

    expect(app.vault.adapter.mkdir).toHaveBeenNthCalledWith(
      1,
      'YOLO/rag-index/v1',
    )
    expect(app.vault.adapter.mkdir).toHaveBeenNthCalledWith(
      2,
      'YOLO/rag-index/v1/models',
    )
  })

  it('loads null manifest when manifest file is absent', async () => {
    const app = createApp()
    app.vault.adapter.exists.mockResolvedValue(false)
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await expect(backend.loadManifest()).resolves.toBeNull()
  })

  it('loads and parses an existing manifest', async () => {
    const app = createApp()
    app.vault.adapter.exists.mockResolvedValue(true)
    app.vault.adapter.read.mockResolvedValue(
      JSON.stringify({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: 'openai/text-embedding-3-small@1536',
        updatedAt: 1,
        shards: [],
      }),
    )
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await expect(backend.loadManifest()).resolves.toMatchObject({
      schemaVersion: 1,
      shards: [],
    })
  })

  it('writes a staged manifest after ensuring root layout', async () => {
    const app = createApp() as ReturnType<typeof createApp> & {
      vault: {
        adapter: {
          write: jest.Mock
        } & ReturnType<typeof createApp>['vault']['adapter']
      }
    }
    app.vault.adapter.write = jest.fn().mockResolvedValue(undefined)
    app.vault.adapter.exists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await backend.writeStagedManifest({
      schemaVersion: 1,
      formatVersion: 1,
      activeModel: 'openai/text-embedding-3-small@1536',
      updatedAt: 1,
      shards: [],
    })

    expect(app.vault.adapter.write).toHaveBeenCalledWith(
      'YOLO/rag-index/v1/manifest.next.json',
      expect.stringContaining('"schemaVersion": 1'),
    )
  })

  it('builds deterministic temp shard paths', () => {
    const app = createApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    expect(
      backend.getTempShardPath(
        'openai/text-embedding-3-small@1536',
        'run-123',
        '000001',
      ),
    ).toBe(
      'YOLO/rag-index/v1/models/openai/text-embedding-3-small@1536/shards/.build-run-123-000001',
    )
  })

  it('writes shard artifacts with aligned row ids and float32 vectors', async () => {
    const app = createApp()
    app.vault.adapter.exists.mockResolvedValue(true)
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await backend.writeTempShardArtifacts({
      modelNamespace: 'openai/text-embedding-3-small@3',
      runId: 'run-123',
      shardId: '000001',
      rows: [
        {
          chunkId: 'c1',
          path: 'a.md',
          mtime: 1,
          contentHash: 'h1',
          startOffset: 0,
          endOffset: 5,
          startLine: 1,
          endLine: 1,
          page: undefined,
          text: 'hello',
          metadata: { startLine: 1, endLine: 1 },
          embedding: [1, 2, 3],
        },
        {
          chunkId: 'c2',
          path: 'b.md',
          mtime: 2,
          contentHash: 'h2',
          startOffset: 6,
          endOffset: 10,
          startLine: 2,
          endLine: 3,
          page: 4,
          text: 'world',
          metadata: { startLine: 2, endLine: 3, page: 4 },
          embedding: [4, 5, 6],
        },
      ],
    })

    expect(app.vault.adapter.writeBinary).toHaveBeenCalledTimes(4)
    const sqliteCall = app.vault.adapter.writeBinary.mock.calls.find(
      ([path]) =>
        path ===
        'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/.build-run-123-000001/chunks.sqlite',
    )
    expect(sqliteCall).toBeDefined()
    const sqliteBuffer = sqliteCall?.[1] as ArrayBuffer
    const sqliteHeader = new TextDecoder().decode(
      new Uint8Array(sqliteBuffer.slice(0, 16)),
    )
    expect(sqliteHeader).toBe('SQLite format 3\0')

    const SQL = await initSqlJs()
    const db = new SQL.Database(new Uint8Array(sqliteBuffer))
    const result = db.exec(
      'SELECT row_id, chunk_id, file_path, text FROM chunks ORDER BY row_id',
    )
    expect(result[0]?.values).toEqual([
      [0, 'c1', 'a.md', 'hello'],
      [1, 'c2', 'b.md', 'world'],
    ])

    const vectorCall = app.vault.adapter.writeBinary.mock.calls.find(
      ([path]) =>
        path ===
        'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/.build-run-123-000001/vectors/000000.f32',
    )
    expect(vectorCall).toBeDefined()
    const vectorBuffer = vectorCall?.[1] as ArrayBuffer
    const view = new Float32Array(vectorBuffer)
    expect(Array.from(view)).toEqual([1, 2, 3, 4, 5, 6])

    const indexCall = app.vault.adapter.writeBinary.mock.calls.find(
      ([path]) =>
        path ===
        'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/.build-run-123-000001/index.bin',
    )
    expect(indexCall).toBeDefined()
    const indexBytes = new Uint8Array(indexCall?.[1] as ArrayBuffer)
    expect(Array.from(indexBytes.slice(0, 8))).toEqual([
      0x59, 0x4f, 0x4c, 0x4f, 0x49, 0x44, 0x58, 0x01,
    ])
    const indexNorms = new Float32Array(
      (indexCall?.[1] as ArrayBuffer).slice(16),
    )
    expect(indexNorms[0]).toBeCloseTo(Math.sqrt(14), 5)
    expect(indexNorms[1]).toBeCloseTo(Math.sqrt(77), 5)

    const tombstonesCall = app.vault.adapter.writeBinary.mock.calls.find(
      ([path]) =>
        path ===
        'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/.build-run-123-000001/tombstones.bin',
    )
    expect(tombstonesCall).toBeDefined()
    const tombstonesBytes = new Uint8Array(
      tombstonesCall?.[1] as ArrayBuffer,
    )
    expect(Array.from(tombstonesBytes)).toEqual([
      0x59, 0x4f, 0x4c, 0x4f, 0x54, 0x4d, 0x42, 0x01, 0, 0, 0, 0,
    ])

    expect(app.vault.adapter.write).toHaveBeenCalledWith(
      'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/.build-run-123-000001/rows/000000.jsonl',
      expect.stringContaining('"file_path":"a.md"'),
    )
  })

  it('performs exact-scan similarity search over a ready shard artifact', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        path === 'YOLO/rag-index/v1/manifest.json'
      )
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await backend.writeTempShardArtifacts({
      modelNamespace: 'openai/text-embedding-3-small@3',
      runId: 'run-123',
      shardId: '000001',
      rows: [
        {
          chunkId: 'c1',
          path: 'a.md',
          mtime: 1,
          contentHash: 'h1',
          startOffset: 0,
          endOffset: 5,
          startLine: 1,
          endLine: 1,
          page: undefined,
          text: 'alpha',
          metadata: { startLine: 1, endLine: 1 },
          embedding: [1, 0, 0],
        },
        {
          chunkId: 'c2',
          path: 'b.md',
          mtime: 2,
          contentHash: 'h2',
          startOffset: 6,
          endOffset: 10,
          startLine: 2,
          endLine: 3,
          page: 4,
          text: 'beta',
          metadata: { startLine: 2, endLine: 3, page: 4 },
          embedding: [0, 1, 0],
        },
      ],
    })

    writtenText.set(
      'YOLO/rag-index/v1/manifest.json',
      JSON.stringify({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: 'openai/text-embedding-3-small@3',
        updatedAt: 1,
        shards: [
          {
            id: '000001',
            relativePath:
              'models/openai/text-embedding-3-small@3/shards/.build-run-123-000001',
            state: 'ready',
            dimension: 3,
            vectorCount: 2,
            checksums: {
              chunksSqlite: 'sha256:x',
              vectorsF32: 'sha256:x',
              indexBin: 'sha256:x',
              tombstonesBin: 'sha256:x',
              shardMeta: 'sha256:x',
            },
          },
        ],
      }),
    )

    const result = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small@3',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: 0,
        limit: 1,
      },
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('a.md')
    expect(result[0]?.content).toBe('alpha')
  })

  it('returns file mtimes from ready shard rows', async () => {
    const app = await createSearchableShardApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    const mtimes = await backend.getFileMtimes('openai/text-embedding-3-small')

    expect(mtimes.get('a.md')).toBe(1)
    expect(mtimes.get('b.md')).toBe(2)
  })

  it('lists chunk rows for selected paths', async () => {
    const app = await createSearchableShardApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    const rows = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['b.md'],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      path: 'b.md',
      mtime: 2,
      content_hash: 'h2',
    })
  })

  it('reports embedding stats from ready shards', async () => {
    const app = await createSearchableShardApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await expect(backend.getEmbeddingStats()).resolves.toEqual([
      expect.objectContaining({
        model: 'openai/text-embedding-3-small',
        rowCount: 2,
      }),
    ])
  })

  it('persists inserted vectors into ready shard artifacts and serves them via repository methods', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 200,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 2, endLine: 3, page: 4 },
      },
    ])

    const manifestRaw = writtenText.get('YOLO/rag-index/v1/manifest.json')
    expect(manifestRaw).toBeDefined()
    const manifest = JSON.parse(manifestRaw ?? '{}')
    expect(manifest.activeModel).toBe('openai/text-embedding-3-small@3')
    expect(manifest.shards).toHaveLength(1)
    expect(manifest.shards[0]?.state).toBe('ready')

    const searchResult = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: 0,
        limit: 1,
        scope: { files: [], folders: ['docs'] },
      },
    )
    expect(searchResult).toHaveLength(1)
    expect(searchResult[0]?.path).toBe('docs/a.md')

    const mtimes = await backend.getFileMtimes('openai/text-embedding-3-small')
    expect(mtimes.get('docs/a.md')).toBe(100)
    expect(mtimes.get('docs/b.md')).toBe(200)

    const rows = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/b.md'],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      path: 'docs/b.md',
      mtime: 200,
      content_hash: 'h2',
    })

    await expect(backend.getEmbeddingStats()).resolves.toEqual([
      expect.objectContaining({
        model: 'openai/text-embedding-3-small',
        rowCount: 2,
      }),
    ])
  })

  it('removes the active model on truncateModel and clearVectorsByModelIds', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    await backend.truncateModel('openai/text-embedding-3-small')
    await expect(
      backend.performSimilaritySearch(
        [1, 0, 0],
        {
          id: 'openai/text-embedding-3-small',
          dimension: 3,
          getEmbedding: async () => [],
        },
        {
          minSimilarity: 0,
          limit: 1,
        },
      ),
    ).resolves.toEqual([])

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])
    await backend.clearVectorsByModelIds(['openai/text-embedding-3-small'])

    await expect(
      backend.getFileMtimes('openai/text-embedding-3-small'),
    ).resolves.toEqual(new Map())
  })

  it('splits rebuild output into multiple shards and merges search results across them', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 2,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 200,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.8, 0.2, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/c.md',
        mtime: 300,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    const manifest = JSON.parse(
      writtenText.get('YOLO/rag-index/v1/manifest.json') ?? '{}',
    )
    expect(manifest.shards).toHaveLength(2)
    expect(manifest.shards.map((shard: { id: string }) => shard.id)).toEqual([
      '000001',
      '000002',
    ])
    expect(
      manifest.shards.map((shard: { vectorCount: number }) => shard.vectorCount),
    ).toEqual([2, 1])

    const result = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: -1,
        limit: 3,
      },
    )

    expect(result.map((row) => row.path)).toEqual([
      'docs/a.md',
      'docs/b.md',
      'docs/c.md',
    ])

    await expect(backend.getEmbeddingStats()).resolves.toEqual([
      expect.objectContaining({
        model: 'openai/text-embedding-3-small',
        rowCount: 3,
      }),
    ])
  })

  it('queries multiple shards concurrently during similarity search', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      if (path.endsWith('chunks.sqlite') || path.includes('/vectors/')) {
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 1,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 200,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.5, 0.5, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    const startedAt = Date.now()
    const result = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: -1,
        limit: 2,
      },
    )
    const elapsedMs = Date.now() - startedAt

    expect(result).toHaveLength(2)
    expect(elapsedMs).toBeLessThan(140)
  })

  it('writes shard.meta.json for each ready shard during rebuild', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 1,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 200,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    const shardMeta1 = JSON.parse(
      writtenText.get(
        'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000001/shard.meta.json',
      ) ?? '{}',
    )
    const shardMeta2 = JSON.parse(
      writtenText.get(
        'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000002/shard.meta.json',
      ) ?? '{}',
    )

    expect(shardMeta1).toMatchObject({
      shardId: '000001',
      modelNamespace: 'openai/text-embedding-3-small@3',
      vectorCount: 1,
      pathPrefixes: ['docs'],
      filePaths: ['docs/a.md'],
    })
    expect(shardMeta2).toMatchObject({
      shardId: '000002',
      filePaths: ['docs/b.md'],
    })
  })

  it('copies index.bin and tombstones.bin into ready shards during rebuild', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 1,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    expect(
      writtenBinary.has(
        'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000001/index.bin',
      ),
    ).toBe(true)
    expect(
      writtenBinary.has(
        'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000001/tombstones.bin',
      ),
    ).toBe(true)
  })

  it('fails search with a clear error when index.bin header is invalid', async () => {
    const app = await createSearchableShardApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      if (path.endsWith('/index.bin')) {
        return Uint8Array.from([0, 1, 2, 3]).buffer
      }
      throw new Error(`unexpected binary file: ${path}`)
    })

    await expect(
      backend.performSimilaritySearch(
        [1, 0, 0],
        {
          id: 'openai/text-embedding-3-small',
          dimension: 3,
          getEmbedding: async () => [],
        },
        {
          minSimilarity: 0,
          limit: 1,
        },
      ),
    ).rejects.toThrow('Invalid sharded index header')
  })

  it('searches a shard without materializing float32 vectors into nested arrays', async () => {
    const app = await createSearchableShardApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    const originalArrayFrom = Array.from
    const arrayFromSpy = jest.spyOn(Array, 'from').mockImplementation(
      ((
        source: ArrayLike<unknown> | Iterable<unknown>,
        mapFn?: (value: unknown, index: number) => unknown,
        thisArg?: unknown,
      ) => {
        if (source instanceof Float32Array) {
          throw new Error('Float32Array materialization is not allowed in search')
        }
        const arrayFromCompat = originalArrayFrom as (
          source: ArrayLike<unknown> | Iterable<unknown>,
          mapFn?: (value: unknown, index: number) => unknown,
          thisArg?: unknown,
        ) => unknown[]
        return arrayFromCompat(source, mapFn, thisArg)
      }) as typeof Array.from,
    )

    await expect(
      backend.performSimilaritySearch(
        [1, 0, 0],
        {
          id: 'openai/text-embedding-3-small',
          dimension: 3,
          getEmbedding: async () => [],
        },
        {
          minSimilarity: 0,
          limit: 1,
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        path: 'a.md',
        content: 'alpha',
      }),
    ])

    arrayFromSpy.mockRestore()
  })

  it('does not read chunks.sqlite on the similarity-search hot path', async () => {
    const app = await createSearchableShardApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    app.vault.adapter.readBinary.mockClear()

    await expect(
      backend.performSimilaritySearch(
        [1, 0, 0],
        {
          id: 'openai/text-embedding-3-small',
          dimension: 3,
          getEmbedding: async () => [],
        },
        {
          minSimilarity: 0,
          limit: 1,
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        path: 'a.md',
        content: 'alpha',
      }),
    ])

    const readPaths = app.vault.adapter.readBinary.mock.calls.map(
      (call) => call[0] as string,
    )
    expect(readPaths.some((path) => path.endsWith('/chunks.sqlite'))).toBe(false)
  })

  it('does not cache vectors.f32 as a full Float32Array on the similarity-search hot path', async () => {
    const app = await createSearchableShardApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    await expect(
      backend.performSimilaritySearch(
        [1, 0, 0],
        {
          id: 'openai/text-embedding-3-small',
          dimension: 3,
          getEmbedding: async () => [],
        },
        {
          minSimilarity: 0,
          limit: 1,
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        path: 'a.md',
        content: 'alpha',
      }),
    ])

    const backendInternals = backend as unknown as Record<string, unknown>
    expect(backendInternals.vectorsCache).toBeUndefined()
    expect(backendInternals.vectorBytesCache instanceof Map).toBe(true)
  })

  it('uses row norms from index.bin during similarity search', async () => {
    const app = await createSearchableShardApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    const originalSqrt = Math.sqrt
    const sqrtSpy = jest.spyOn(Math, 'sqrt').mockImplementation((value) => {
      if (value === 1) {
        return originalSqrt(value)
      }
      throw new Error(`unexpected sqrt(${value})`)
    })

    await expect(
      backend.performSimilaritySearch(
        [1, 0, 0],
        {
          id: 'openai/text-embedding-3-small',
          dimension: 3,
          getEmbedding: async () => [],
        },
        {
          minSimilarity: 0,
          limit: 1,
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        path: 'a.md',
      }),
    ])

    sqrtSpy.mockRestore()
  })

  it('resolves searchable rows by block-local offset without building a row-id map', () => {
    const app = createApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    type SearchableRowFixture = {
      row_id: number
      file_path: string
      file_mtime: number
      chunk_content_hash: string | null
      text: string
      metadata_json: { startLine: number; endLine: number }
    }

    const rows: SearchableRowFixture[] = [
      {
        row_id: 256,
        file_path: 'docs/a.md',
        file_mtime: 100,
        chunk_content_hash: 'h1',
        text: 'alpha',
        metadata_json: { startLine: 1, endLine: 1 },
      },
      {
        row_id: 257,
        file_path: 'docs/b.md',
        file_mtime: 101,
        chunk_content_hash: 'h2',
        text: 'beta',
        metadata_json: { startLine: 2, endLine: 2 },
      },
    ]

    expect(
      (
        backend as never as {
          getSearchableRowForRowId: (
            rows: SearchableRowFixture[],
            rowId: number,
            blockId: number,
            vectorBlockSize: number,
          ) => SearchableRowFixture | null
        }
      ).getSearchableRowForRowId(rows, 257, 1, 256),
    ).toEqual(rows[1])
    expect(
      (
        backend as never as {
          getSearchableRowForRowId: (
            rows: SearchableRowFixture[],
            rowId: number,
            blockId: number,
            vectorBlockSize: number,
          ) => SearchableRowFixture | null
        }
      ).getSearchableRowForRowId(rows, 512, 1, 256),
    ).toBeNull()
  })

  it('computes row cosine from a reused float32 view', () => {
    const app = createApp()
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
    })

    const flatVectors = new Float32Array([
      1, 0, 0,
      0, 1, 0,
    ])
    const rowNorms = new Float32Array([1, 1])

    const similarity = (
      backend as never as {
        cosineSimilarityToRowView: (
          query: number[],
          flatVectors: Float32Array,
          rowNorms: Float32Array,
          dimension: number,
          rowId: number,
          blockId: number,
          vectorBlockSize: number,
        ) => number
      }
    ).cosineSimilarityToRowView([1, 0, 0], flatVectors, rowNorms, 3, 0, 0, 256)

    expect(similarity).toBeCloseTo(1, 6)
  })

  it('probes only the nearest coarse cluster during ANN search', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      targetCentroidsPerShard: 2,
      maxProbeClusters: 1,
    } as never)

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 110,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.9, 0.1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/c.md',
        mtime: 120,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/d.md',
        mtime: 130,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.1, 0.9, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    const similaritySpy = jest.spyOn(
      backend as never,
      'cosineSimilarityToRowView' as never,
    )

    const result = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: -1,
        limit: 2,
      },
    )

    const probedRowIds = similaritySpy.mock.calls.map(
      (call) => call[4] as number,
    )
    expect(result.map((row) => row.path)).toEqual(['docs/a.md', 'docs/b.md'])
    expect(probedRowIds).toEqual([0, 1])

    similaritySpy.mockRestore()
  })

  it('groups similar vectors into the same coarse cluster even when insertion order is interleaved', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      targetCentroidsPerShard: 2,
      maxProbeClusters: 1,
    } as never)

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/c.md',
        mtime: 120,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 110,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.9, 0.1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/d.md',
        mtime: 130,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.1, 0.9, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    const similaritySpy = jest.spyOn(
      backend as never,
      'cosineSimilarityToRowView' as never,
    )

    const result = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: -1,
        limit: 2,
      },
    )

    const probedRowIds = similaritySpy.mock.calls.map(
      (call) => call[4] as number,
    )
    expect(result.map((row) => row.path)).toEqual(['docs/a.md', 'docs/b.md'])
    expect(probedRowIds).toEqual([0, 2])

    similaritySpy.mockRestore()
  })

  it('clusters same-direction vectors together even when magnitudes differ', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      targetCentroidsPerShard: 2,
      maxProbeClusters: 1,
    } as never)

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/c.md',
        mtime: 120,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 110,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [10, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/d.md',
        mtime: 130,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 10, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    const similaritySpy = jest.spyOn(
      backend as never,
      'cosineSimilarityToRowView' as never,
    )

    const result = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: -1,
        limit: 2,
      },
    )

    const probedRowIds = similaritySpy.mock.calls.map(
      (call) => call[4] as number,
    )
    expect(result.map((row) => row.path)).toEqual(['docs/a.md', 'docs/b.md'])
    expect(probedRowIds).toEqual(expect.arrayContaining([0, 2]))

    similaritySpy.mockRestore()
  })

  it('adapts probe count upward for larger shards to preserve recall', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      targetCentroidsPerShard: 4,
      maxProbeClusters: 1,
      adaptiveProbeScale: 2,
    } as never)

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 110,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.95, 0.05, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/c.md',
        mtime: 120,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.9, 0.1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/d.md',
        mtime: 130,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    const similaritySpy = jest.spyOn(
      backend as never,
      'cosineSimilarityToRowView' as never,
    )

    const result = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: -1,
        limit: 3,
      },
    )

    const probedRowIds = similaritySpy.mock.calls.map(
      (call) => call[4] as number,
    )
    expect(result.map((row) => row.path)).toEqual([
      'docs/a.md',
      'docs/b.md',
      'docs/c.md',
    ])
    expect(probedRowIds).toEqual(expect.arrayContaining([0, 1, 2]))

    similaritySpy.mockRestore()
  })

  it('suppresses duplicate content hashes after merging shard candidates', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 1,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'dup-hash',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'alpha duplicate',
        content_hash: 'dup-hash',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.99, 0.01, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
      {
        path: 'docs/c.md',
        mtime: 102,
        content: 'beta',
        content_hash: 'unique-hash',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.8, 0.2, 0],
        metadata: { startLine: 3, endLine: 3 },
      },
    ])

    const result = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: -1,
        limit: 3,
      },
    )

    expect(result.map((row) => row.path)).toEqual(['docs/a.md', 'docs/c.md'])
  })

  it('skips unrelated shards via shard metadata when scope narrows the search', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 1,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'notes/b.md',
        mtime: 200,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    const readBinarySpy = app.vault.adapter.readBinary
    readBinarySpy.mockClear()

    const result = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: -1,
        limit: 2,
        scope: {
          files: [],
          folders: ['docs'],
        },
      },
    )

    expect(result.map((row) => row.path)).toEqual(['docs/a.md'])
    const readPaths = readBinarySpy.mock.calls.map((call) => call[0] as string)
    expect(
      readPaths.some((path) => path.includes('/shards/000002/chunks.sqlite')),
    ).toBe(false)
    expect(
      readPaths.some((path) => path.includes('/shards/000002/vectors/')),
    ).toBe(false)
  })

  it('deletes vectors by paths by rewriting only affected shards', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 2,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.9, 0.1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
      {
        path: 'notes/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 3, endLine: 3 },
      },
    ])

    const writeBinaryCallsBefore = app.vault.adapter.writeBinary.mock.calls.length
    await backend.deleteVectorsByPaths('openai/text-embedding-3-small', ['docs/b.md'])

    const rows = await backend.listChunksForPaths('openai/text-embedding-3-small', [
      'docs/a.md',
      'docs/b.md',
      'notes/c.md',
    ])
    expect(rows.map((row) => row.path).sort()).toEqual(['docs/a.md', 'notes/c.md'])

    const search = await backend.performSimilaritySearch(
      [1, 0, 0],
      {
        id: 'openai/text-embedding-3-small',
        dimension: 3,
        getEmbedding: async () => [],
      },
      {
        minSimilarity: -1,
        limit: 3,
      },
    )
    expect(search.map((row) => row.path)).toEqual(['docs/a.md', 'notes/c.md'])

    expect(app.vault.adapter.writeBinary.mock.calls.length).toBeGreaterThan(
      writeBinaryCallsBefore,
    )
  })

  it('deletes vectors by paths without rewriting chunk/vector/index artifacts', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 2,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.9, 0.1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
      {
        path: 'notes/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 3, endLine: 3 },
      },
    ])

    app.vault.adapter.write.mockClear()
    app.vault.adapter.writeBinary.mockClear()

    await backend.deleteVectorsByPaths('openai/text-embedding-3-small', ['docs/b.md'])

    const binaryPaths = app.vault.adapter.writeBinary.mock.calls.map(
      ([path]) => path as string,
    )
    expect(binaryPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining('tombstones.bin'),
      ]),
    )
    expect(binaryPaths).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('chunks.sqlite'),
        expect.stringContaining('index.bin'),
        expect.stringContaining('.f32'),
      ]),
    )
  })

  it('deletes vectors by encoded ids across shards', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 2,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.9, 0.1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
      {
        path: 'notes/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 3, endLine: 3 },
      },
      {
        path: 'notes/d.md',
        mtime: 103,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 0.9, 0.1],
        metadata: { startLine: 4, endLine: 4 },
      },
    ])

    const rowsBefore = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'notes/c.md', 'notes/d.md'],
    )
    expect(rowsBefore).toHaveLength(4)

    const idsToDelete = rowsBefore
      .filter((row) => row.path === 'docs/b.md' || row.path === 'notes/c.md')
      .map((row) => row.id)

    await backend.deleteVectorsByIds(idsToDelete)

    const rowsAfter = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'notes/c.md', 'notes/d.md'],
    )

    expect(rowsAfter.map((row) => row.path).sort()).toEqual([
      'docs/a.md',
      'notes/d.md',
    ])
  })

  it('bumps file mtimes by encoded ids across shards', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 2,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.9, 0.1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
      {
        path: 'notes/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 3, endLine: 3 },
      },
    ])

    const rowsBefore = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'notes/c.md'],
    )
    const updates = rowsBefore
      .filter((row) => row.path === 'docs/a.md' || row.path === 'notes/c.md')
      .map((row) => ({
        id: row.id,
        mtime: row.path === 'docs/a.md' ? 999 : 888,
      }))

    await backend.bumpMtimeByIds(updates)

    const rowsAfter = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'notes/c.md'],
    )

    expect(
      rowsAfter.map((row) => ({ path: row.path, mtime: row.mtime })).sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    ).toEqual([
      { path: 'docs/a.md', mtime: 999 },
      { path: 'docs/b.md', mtime: 101 },
      { path: 'notes/c.md', mtime: 888 },
    ])
  })

  it('preserves untouched shards when inserting only incremental rows', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 2,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.9, 0.1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
      {
        path: 'notes/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 3, endLine: 3 },
      },
      {
        path: 'notes/d.md',
        mtime: 103,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 0.9, 0.1],
        metadata: { startLine: 4, endLine: 4 },
      },
    ])

    const rowsBefore = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'notes/c.md', 'notes/d.md'],
    )
    const idsToDelete = rowsBefore
      .filter((row) => row.path === 'docs/a.md')
      .map((row) => row.id)
    await backend.deleteVectorsByIds(idsToDelete)

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 200,
        content: 'alpha updated',
        content_hash: 'h1b',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.8, 0.2, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    const rowsAfter = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'notes/c.md', 'notes/d.md'],
    )
    expect(rowsAfter.map((row) => row.path).sort()).toEqual([
      'docs/a.md',
      'docs/b.md',
      'notes/c.md',
      'notes/d.md',
    ])
    expect(rowsAfter.find((row) => row.path === 'docs/a.md')?.mtime).toBe(200)
  })

  it('appends incremental rows into a new shard instead of rewriting partially filled ready shards', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 3,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
    ])

    app.vault.adapter.write.mockClear()
    app.vault.adapter.writeBinary.mockClear()

    await backend.insertVectors([
      {
        path: 'docs/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 0, 1],
        metadata: { startLine: 3, endLine: 3 },
      },
    ])

    const binaryWrites = app.vault.adapter.writeBinary.mock.calls.map(
      (call) => call[0] as string,
    )
    expect(binaryWrites).not.toContain(
      'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000001/chunks.sqlite',
    )
    expect(binaryWrites).not.toContain(
      'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000001/index.bin',
    )
    expect(
      binaryWrites.some((path) =>
        path.startsWith(
          'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000001/vectors/',
        ),
      ),
    ).toBe(false)
    expect(binaryWrites).toContain(
      'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000002/chunks.sqlite',
    )

    const rows = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'docs/c.md'],
    )
    expect(rows.map((row) => row.path).sort()).toEqual([
      'docs/a.md',
      'docs/b.md',
      'docs/c.md',
    ])
  })

  it('removes fully tombstoned shards from manifest and storage during delete compaction', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    app.vault.adapter.rmdir.mockImplementation(async (path: string) => {
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
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 2,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
      {
        path: 'docs/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 0, 1],
        metadata: { startLine: 3, endLine: 3 },
      },
    ])

    const rowsBefore = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'docs/c.md'],
    )
    const firstShardIds = rowsBefore
      .filter((row) => row.path === 'docs/a.md' || row.path === 'docs/b.md')
      .map((row) => row.id)

    await backend.deleteVectorsByIds(firstShardIds)

    const manifest = await backend.loadManifest()
    expect(manifest?.shards.map((shard) => shard.id)).toEqual(['000002'])
    expect(
      app.vault.adapter.exists(
        'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000001',
      ),
    ).resolves.toBe(false)

    const rowsAfter = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'docs/c.md'],
    )
    expect(rowsAfter.map((row) => row.path)).toEqual(['docs/c.md'])
  })

  it('compacts heavily tombstoned shards by rewriting only surviving rows', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    app.vault.adapter.rmdir.mockImplementation(async (path: string) => {
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
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 5,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
      {
        path: 'docs/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 0, 1],
        metadata: { startLine: 3, endLine: 3 },
      },
      {
        path: 'docs/d.md',
        mtime: 103,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.7, 0.3, 0],
        metadata: { startLine: 4, endLine: 4 },
      },
      {
        path: 'docs/e.md',
        mtime: 104,
        content: 'epsilon',
        content_hash: 'h5',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.6, 0.4, 0],
        metadata: { startLine: 5, endLine: 5 },
      },
    ])

    const rowsBefore = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md'],
    )
    const idsToDelete = rowsBefore
      .filter(
        (row) =>
          row.path === 'docs/a.md' ||
          row.path === 'docs/b.md' ||
          row.path === 'docs/c.md' ||
          row.path === 'docs/d.md',
      )
      .map((row) => row.id)

    app.vault.adapter.write.mockClear()
    app.vault.adapter.writeBinary.mockClear()

    await backend.deleteVectorsByIds(idsToDelete)

    const manifest = await backend.loadManifest()
    expect(manifest?.shards.map((shard) => ({ id: shard.id, vectorCount: shard.vectorCount }))).toEqual([
      { id: '000001', vectorCount: 1 },
    ])

    const binaryWrites = app.vault.adapter.writeBinary.mock.calls.map(
      (call) => call[0] as string,
    )
    expect(binaryWrites).toContain(
      'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000001/chunks.sqlite',
    )
    expect(binaryWrites).toContain(
      'YOLO/rag-index/v1/models/openai/text-embedding-3-small@3/shards/000001/index.bin',
    )

    const rowsAfter = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md'],
    )
    expect(rowsAfter.map((row) => row.path)).toEqual(['docs/e.md'])
  })

  it('keeps append-only shards separate during foreground inserts even after shard fan-out grows', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    app.vault.adapter.rmdir.mockImplementation(async (path: string) => {
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
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 4,
      compactDeadRatio: 0.7,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
    ])

    await backend.insertVectors([
      {
        path: 'docs/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 0, 1],
        metadata: { startLine: 3, endLine: 3 },
      },
    ])

    await backend.insertVectors([
      {
        path: 'docs/d.md',
        mtime: 103,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.7, 0.3, 0],
        metadata: { startLine: 4, endLine: 4 },
      },
    ])

    const manifest = await backend.loadManifest()
    expect(manifest?.shards.map((shard) => ({ id: shard.id, vectorCount: shard.vectorCount }))).toEqual([
      { id: '000001', vectorCount: 2 },
      { id: '000002', vectorCount: 1 },
      { id: '000003', vectorCount: 1 },
    ])

    const rows = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md'],
    )
    expect(rows.map((row) => row.path).sort()).toEqual([
      'docs/a.md',
      'docs/b.md',
      'docs/c.md',
      'docs/d.md',
    ])
  })

  it('vacuum light compacts high-tombstone shards without merging separate append shards', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    app.vault.adapter.rmdir.mockImplementation(async (path: string) => {
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
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 4,
      compactDeadRatio: 0.7,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
      {
        path: 'docs/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 0, 1],
        metadata: { startLine: 3, endLine: 3 },
      },
      {
        path: 'docs/d.md',
        mtime: 103,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.7, 0.3, 0],
        metadata: { startLine: 4, endLine: 4 },
      },
    ])

    const rowsBefore = await backend.listChunksForPaths(
      'openai/text-embedding-3-small',
      ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md'],
    )
    const idsToDelete = rowsBefore
      .filter(
        (row) =>
          row.path === 'docs/a.md' ||
          row.path === 'docs/b.md' ||
          row.path === 'docs/c.md',
      )
      .map((row) => row.id)

    await backend.deleteVectorsByIds(idsToDelete)
    await backend.vacuum('light')

    const manifest = await backend.loadManifest()
    expect(manifest?.shards.map((shard) => ({ id: shard.id, vectorCount: shard.vectorCount }))).toEqual([
      { id: '000001', vectorCount: 1 },
    ])
  })

  it('vacuum full merges adjacent small ready shards', async () => {
    const app = createApp()
    const writtenText = new Map<string, string>()
    const writtenBinary = new Map<string, ArrayBuffer>()
    const directories = new Set<string>()
    app.vault.adapter.exists.mockImplementation(async (path: string) => {
      return (
        writtenText.has(path) ||
        writtenBinary.has(path) ||
        directories.has(path)
      )
    })
    app.vault.adapter.mkdir.mockImplementation(async (path: string) => {
      directories.add(path)
    })
    app.vault.adapter.write.mockImplementation(
      async (path: string, content: string) => {
        writtenText.set(path, content)
      },
    )
    app.vault.adapter.writeBinary.mockImplementation(
      async (path: string, content: ArrayBuffer) => {
        writtenBinary.set(path, content)
      },
    )
    app.vault.adapter.read.mockImplementation(async (path: string) => {
      const content = writtenText.get(path)
      if (content === undefined) {
        throw new Error(`missing file: ${path}`)
      }
      return content
    })
    app.vault.adapter.readBinary.mockImplementation(async (path: string) => {
      const content = writtenBinary.get(path)
      if (content === undefined) {
        throw new Error(`missing binary file: ${path}`)
      }
      return content
    })
    app.vault.adapter.rmdir.mockImplementation(async (path: string) => {
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
    })

    const backend = new ShardedVectorBackend({
      app: asApp(app),
      baseDir: 'YOLO',
      maxVectorsPerShard: 4,
    })

    await backend.insertVectors([
      {
        path: 'docs/a.md',
        mtime: 100,
        content: 'alpha',
        content_hash: 'h1',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
      {
        path: 'docs/b.md',
        mtime: 101,
        content: 'beta',
        content_hash: 'h2',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 1, 0],
        metadata: { startLine: 2, endLine: 2 },
      },
    ])
    await backend.insertVectors([
      {
        path: 'docs/c.md',
        mtime: 102,
        content: 'gamma',
        content_hash: 'h3',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0, 0, 1],
        metadata: { startLine: 3, endLine: 3 },
      },
    ])
    await backend.insertVectors([
      {
        path: 'docs/d.md',
        mtime: 103,
        content: 'delta',
        content_hash: 'h4',
        model: 'openai/text-embedding-3-small',
        dimension: 3,
        embedding: [0.7, 0.3, 0],
        metadata: { startLine: 4, endLine: 4 },
      },
    ])

    await backend.vacuum('full')

    const manifest = await backend.loadManifest()
    expect(manifest?.shards.map((shard) => ({ id: shard.id, vectorCount: shard.vectorCount }))).toEqual([
      { id: '000001', vectorCount: 4 },
    ])
  })
})
