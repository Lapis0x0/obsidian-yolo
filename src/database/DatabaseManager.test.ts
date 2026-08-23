// Installs IDBKeyRange (used by the store's compound-key ranges) as a global.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import { DatabaseManager } from './DatabaseManager'
import type { IndexedDbVectorStore } from './vector-store/IndexedDbVectorStore'
import { vectorDatabaseName } from './vector-store/vectorDatabase'

const NAMESPACE_A = '11111111-1111-4111-8111-111111111111'
const NAMESPACE_B = '22222222-2222-4222-8222-222222222222'

class FakeAppLocalStorage {
  private readonly values = new Map<string, unknown>()

  loadLocalStorage(key: string): unknown {
    return this.values.get(key) ?? null
  }

  saveLocalStorage(key: string, value: unknown): void {
    this.values.set(key, value)
  }
}

function createFakeApp(existingPaths: Iterable<string> = []) {
  const app = new FakeAppLocalStorage() as FakeAppLocalStorage & {
    vault: { adapter: Record<string, jest.Mock> }
  }
  const paths = new Set(existingPaths)
  const exists = jest.fn(async (path: string) => paths.has(path))
  const remove = jest.fn(async (path: string) => {
    paths.delete(path)
  })
  const rmdir = jest.fn(async () => undefined)
  app.vault = { adapter: { exists, remove, rmdir } }
  return { app, exists, remove, rmdir, paths }
}

async function storeOf(manager: DatabaseManager, kbId: string) {
  const opened = (
    manager as unknown as {
      knowledgeBases: Map<string, { store: IndexedDbVectorStore }>
    }
  ).knowledgeBases.get(kbId)
  if (!opened) throw new Error(`knowledge base "${kbId}" is not open`)
  return opened.store
}

describe('DatabaseManager', () => {
  it('opens independent databases per knowledge base', async () => {
    const { app } = createFakeApp()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => NAMESPACE_A,
      },
    )

    const kbA = await manager.getVectorManager('kb-a')
    const kbB = await manager.getVectorManager('kb-b')
    expect(kbA).not.toBe(kbB)
    // Same kbId resolves to the same cached VectorManager.
    expect(await manager.getVectorManager('kb-a')).toBe(kbA)

    await manager.cleanup()
  })

  it('de-dupes concurrent opens of the same knowledge base', async () => {
    const { app } = createFakeApp()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => NAMESPACE_A,
      },
    )

    const [a, b] = await Promise.all([
      manager.getVectorManager('kb-a'),
      manager.getVectorManager('kb-a'),
    ])
    expect(a).toBe(b)

    await manager.cleanup()
  })

  it('waits for in-flight vector work, then closes the database, on closeKnowledgeBase', async () => {
    const { app } = createFakeApp()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => NAMESPACE_A,
      },
    )

    const vectorManager = await manager.getVectorManager('kb-a')
    const store = await storeOf(manager, 'kb-a')
    const closeSpy = jest.spyOn(store, 'close')

    const searchPromise = vectorManager.performSimilaritySearch(
      [1, 0, 0],
      { id: 'test-model', dimension: 3, getEmbedding: async () => [] },
      { minSimilarity: 0, limit: 1 },
    )
    // performSimilaritySearch runs synchronously up to its first await, which
    // is enough to increment VectorManager's active-operation count. close
    // must therefore wait for it — close() must not have fired yet.
    const closePromise = manager.closeKnowledgeBase('kb-a')
    expect(closeSpy).not.toHaveBeenCalled()

    await searchPromise
    await closePromise

    expect(closeSpy).toHaveBeenCalledTimes(1)

    await manager.cleanup()
  })

  it('closeKnowledgeBase is a no-op for a knowledge base that was never opened', async () => {
    const { app } = createFakeApp()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => NAMESPACE_A,
      },
    )

    await expect(
      manager.closeKnowledgeBase('never-opened'),
    ).resolves.toBeUndefined()

    await manager.cleanup()
  })

  it('deleteKnowledgeBase closes the connection and drops the database', async () => {
    const { app } = createFakeApp()
    const indexedDB = new IDBFactory()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB,
        createNamespaceId: () => NAMESPACE_A,
      },
    )

    await manager.getVectorManager('kb-a')
    const store = await storeOf(manager, 'kb-a')
    await store.insertVectors([
      {
        path: 'a.md',
        mtime: 1,
        content: 'hello',
        content_hash: null,
        model: 'test-model',
        dimension: 3,
        embedding: [1, 0, 0],
        metadata: { startLine: 1, endLine: 1 },
      },
    ])

    await manager.deleteKnowledgeBase('kb-a')

    const remainingDbNames = (await indexedDB.databases()).map((d) => d.name)
    expect(remainingDbNames).not.toContain(
      vectorDatabaseName(NAMESPACE_A, 'kb-a'),
    )

    await manager.cleanup()
  })

  it('permanently blocks a deleted knowledge base id from reopening — ids are never reused, so a stale caller racing the delete must not revive it', async () => {
    const { app } = createFakeApp()
    const indexedDB = new IDBFactory()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB,
        createNamespaceId: () => NAMESPACE_A,
      },
    )

    await manager.getVectorManager('kb-a')
    await manager.deleteKnowledgeBase('kb-a')

    // A caller that still holds "kb-a" (a queued index run, an in-flight
    // search) must not silently reopen a fresh empty database for it.
    await expect(manager.getVectorManager('kb-a')).rejects.toThrow(/deleted/i)

    await manager.cleanup()
  })

  it('deleteKnowledgeBase waits for a concurrent in-flight open before closing and deleting', async () => {
    const { app } = createFakeApp()
    const indexedDB = new IDBFactory()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB,
        createNamespaceId: () => NAMESPACE_A,
      },
    )

    // Kick off an open but don't await it yet — deleteKnowledgeBase races it.
    const openPromise = manager.getVectorManager('kb-a')
    await manager.deleteKnowledgeBase('kb-a')

    // The racing open still resolves (it started before the delete), but the
    // connection it produced must not be left dangling in the cache — a
    // second call for the same id must see it as deleted, not cached-open.
    await openPromise
    await expect(manager.getVectorManager('kb-a')).rejects.toThrow(/deleted/i)

    await manager.cleanup()
  })

  it('is idempotent: repeat cleanup() calls reuse the same in-flight/completed promise', async () => {
    const { app } = createFakeApp()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => NAMESPACE_A,
      },
    )
    await manager.getVectorManager('kb-a')
    const store = await storeOf(manager, 'kb-a')
    const closeSpy = jest.spyOn(store, 'close')

    await Promise.all([manager.cleanup(), manager.cleanup()])
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects getVectorManager after cleanup', async () => {
    const { app } = createFakeApp()
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => NAMESPACE_A,
      },
    )
    await manager.cleanup()
    await expect(manager.getVectorManager('kb-a')).rejects.toThrow()
  })

  it('sweeps legacy PGlite artifacts and the legacy single-store database on init', async () => {
    const { app, exists, remove, rmdir } = createFakeApp([
      'YOLO/.yolo_vector_db.tar.gz',
      '.smtcmp_vector_db.tar.gz',
      'plugins/yolo/runtime/pglite',
      'plugins/yolo/runtime/components/pglite-engine',
    ])
    const pluginDir = 'plugins/yolo'
    const indexedDB = new IDBFactory()
    // Simulate a pre-multi-kb single-store database left over in IndexedDB.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`yolo-vector:${NAMESPACE_B}`, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('chunks', {
          keyPath: 'id',
          autoIncrement: true,
        })
      }
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB open failed'))
    })

    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      pluginDir,
      {
        indexedDB,
        createNamespaceId: () => NAMESPACE_B,
      },
    )

    expect(exists).toHaveBeenCalledWith('YOLO/.yolo_vector_db.tar.gz')
    expect(exists).toHaveBeenCalledWith('.smtcmp_vector_db.tar.gz')
    expect(remove).toHaveBeenCalledWith('YOLO/.yolo_vector_db.tar.gz')
    expect(remove).toHaveBeenCalledWith('.smtcmp_vector_db.tar.gz')
    expect(exists).toHaveBeenCalledWith('plugins/yolo/runtime/pglite')
    expect(rmdir).toHaveBeenCalledWith('plugins/yolo/runtime/pglite', true)
    expect(exists).toHaveBeenCalledWith(
      'plugins/yolo/runtime/components/pglite-engine',
    )
    expect(rmdir).toHaveBeenCalledWith(
      'plugins/yolo/runtime/components/pglite-engine',
      true,
    )
    const remainingDbNames = (await indexedDB.databases()).map((d) => d.name)
    expect(remainingDbNames).not.toContain(`yolo-vector:${NAMESPACE_B}`)

    await manager.cleanup()
  })

  it('is idempotent: a second init with nothing left over touches remove/rmdir zero times', async () => {
    const { app, remove, rmdir } = createFakeApp() // nothing exists
    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      'plugins/yolo',
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => NAMESPACE_A,
      },
    )

    expect(remove).not.toHaveBeenCalled()
    expect(rmdir).not.toHaveBeenCalled()

    await manager.cleanup()
  })

  it('does not fail init when legacy artifact cleanup errors (logs and continues)', async () => {
    const { app, exists } = createFakeApp(['YOLO/.yolo_vector_db.tar.gz'])
    app.vault.adapter.remove = jest.fn(async () => {
      throw new Error('disk error')
    })
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      undefined,
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => NAMESPACE_B,
      },
    )

    expect(exists).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    await expect(manager.getVectorManager('kb-a')).resolves.toBeTruthy()

    warnSpy.mockRestore()
    await manager.cleanup()
  })
})
