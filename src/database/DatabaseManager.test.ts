// Installs IDBKeyRange (used by the store's compound-key ranges) as a global.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import { DatabaseManager } from './DatabaseManager'

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

describe('DatabaseManager', () => {
  it('waits for in-flight vector work, then closes the database, on cleanup', async () => {
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

    const store = (manager as unknown as { store: { close: () => void } }).store
    const closeSpy = jest.spyOn(store, 'close')

    const vectorManager = manager.getVectorManager()
    const searchPromise = vectorManager.performSimilaritySearch(
      [1, 0, 0],
      { id: 'test-model', dimension: 3, getEmbedding: async () => [] },
      { minSimilarity: 0, limit: 1 },
    )
    // performSimilaritySearch runs synchronously up to its first await, which
    // is enough to increment VectorManager's active-operation count. cleanup()
    // must therefore wait for it — close() must not have fired yet.
    const cleanupPromise = manager.cleanup()
    expect(closeSpy).not.toHaveBeenCalled()

    await searchPromise
    await cleanupPromise

    expect(closeSpy).toHaveBeenCalledTimes(1)
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
    const store = (manager as unknown as { store: { close: () => void } }).store
    const closeSpy = jest.spyOn(store, 'close')

    await Promise.all([manager.cleanup(), manager.quiesceAndCleanup()])
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('sweeps legacy PGlite artifacts (vault snapshot files + plugin runtime dir) on init', async () => {
    const { app, exists, remove, rmdir } = createFakeApp([
      'YOLO/.yolo_vector_db.tar.gz',
      '.smtcmp_vector_db.tar.gz',
      'plugins/yolo/runtime/pglite',
    ])
    const pluginDir = 'plugins/yolo'

    const manager = await DatabaseManager.create(
      app as never,
      { yolo: { baseDir: 'YOLO' } },
      pluginDir,
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => NAMESPACE_B,
      },
    )

    expect(exists).toHaveBeenCalledWith('YOLO/.yolo_vector_db.tar.gz')
    expect(exists).toHaveBeenCalledWith('.smtcmp_vector_db.tar.gz')
    expect(remove).toHaveBeenCalledWith('YOLO/.yolo_vector_db.tar.gz')
    expect(remove).toHaveBeenCalledWith('.smtcmp_vector_db.tar.gz')
    expect(exists).toHaveBeenCalledWith('plugins/yolo/runtime/pglite')
    expect(rmdir).toHaveBeenCalledWith('plugins/yolo/runtime/pglite', true)

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
    expect(manager.getVectorManager()).toBeTruthy()

    warnSpy.mockRestore()
    await manager.cleanup()
  })
})
