jest.mock('../core/paths/yoloManagedData', () => ({
  ensureVectorDbPath: jest.fn(async () => 'YOLO/json_db/vector-db.gz'),
}))

jest.mock('./runtime/loadPgliteRuntimeFromDisk', () => ({
  loadPgliteRuntimeFromDisk: jest.fn(async () => ({
    fsBundle: new Blob(),
    pgliteWasmModule: {} as WebAssembly.Module,
    initdbWasmModule: {} as WebAssembly.Module,
    vectorExtensionBlob: new Blob(),
    vectorExtensionBundlePath: new URL('blob:test'),
  })),
}))

import {
  type PgliteEngineSession,
  type RuntimeComponentId,
  type RuntimeComponentLease,
  type VectorStore,
} from '../core/runtime-components/contracts'
import { setRuntimeComponentAcquirerForTests } from '../core/runtime-components/runtimeComponentAccess'

import { DatabaseManager } from './DatabaseManager'

describe('DatabaseManager runtime component ownership', () => {
  it('waits for vector work, saves, closes, then releases its long lease', async () => {
    let finishSearch!: () => void
    const searchPending = new Promise<void>((resolve) => {
      finishSearch = resolve
    })
    const vectorStore = {
      performSimilaritySearch: jest.fn(async () => {
        await searchPending
        return []
      }),
    } as unknown as VectorStore
    const dump = jest.fn(async () => new Blob([new Uint8Array([1, 2, 3])]))
    const close = jest.fn(async () => undefined)
    const session: PgliteEngineSession = {
      vectorStore,
      migrationChanged: false,
      cleanupLegacyStaging: async () => 0,
      vacuum: async () => undefined,
      dump,
      close,
    }
    const release = jest.fn()
    const createSession = jest.fn(async () => session)
    setRuntimeComponentAcquirerForTests(
      async <I extends RuntimeComponentId>(
        id: I,
      ): Promise<RuntimeComponentLease<I>> => {
        if (id !== 'pglite-engine') throw new Error('Unexpected component')
        return {
          api: { createSession, dispose: async () => undefined },
          release,
        } as unknown as RuntimeComponentLease<I>
      },
    )
    const writeBinary = jest.fn(async () => undefined)
    const app = {
      vault: {
        configDir: 'config',
        adapter: {
          exists: jest.fn(async () => false),
          writeBinary,
        },
      },
    }
    const manager = await DatabaseManager.create(
      app as never,
      'runtime/pglite/current',
    )
    const search = manager
      .getVectorManager()
      .performSimilaritySearch(
        [1, 0, 0],
        { id: 'test', dimension: 3, getEmbedding: async () => [] },
        { minSimilarity: 0, limit: 1 },
      )
    const cleanup = manager.quiesceAndCleanup()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()

    finishSearch()
    await search
    await cleanup
    expect(dump).toHaveBeenCalledTimes(2)
    expect(writeBinary).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
