jest.mock('./embedding', () => ({
  getEmbeddingModelClient: jest.fn(() => ({
    id: 'test-embedding-model',
    dimension: 3,
    getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  })),
}))

import type { App } from 'obsidian'

import type { DatabaseManager } from '../../database/DatabaseManager'
import type { VectorManager } from '../../database/modules/vector/VectorManager'
import type { YoloSettings } from '../../settings/schema/setting.types'

import { RagCoordinator } from './ragCoordinator'

const baseSettings = {
  embeddingModelId: 'test-embedding-model',
  ragOptions: { chunkSize: 500, minSimilarity: 0.3, limit: 20 },
  knowledgeBases: [
    { id: 'kb-a', name: 'kb-a', description: '', include: [], exclude: [] },
  ],
} as unknown as YoloSettings

describe('RagCoordinator', () => {
  it('does not cache an engine whose init was racing a closeRagEngine that fired first', async () => {
    // getVectorManager stays pending until we release it, so we control
    // exactly when the in-flight getRagEngine() init resolves relative to
    // closeRagEngine().
    let releaseOpen: (vm: VectorManager) => void = () => undefined
    const openGate = new Promise<VectorManager>((resolve) => {
      releaseOpen = resolve
    })
    const closeKnowledgeBase = jest.fn().mockResolvedValue(undefined)
    const dbManager = {
      getVectorManager: jest.fn().mockReturnValue(openGate),
      closeKnowledgeBase,
    } as unknown as DatabaseManager

    const coordinator = new RagCoordinator({
      app: {} as App,
      getSettings: () => baseSettings,
      getDbManager: async () => dbManager,
    })

    const enginePromise = coordinator.getRagEngine('kb-a')

    // The close/delete wins the race: it fires while the init above is still
    // waiting on getVectorManager.
    await coordinator.closeRagEngine('kb-a')
    expect(closeKnowledgeBase).toHaveBeenCalledWith('kb-a')

    // Now let the stale init finish.
    const fakeVectorManager = {} as VectorManager
    releaseOpen(fakeVectorManager)
    const engine = await enginePromise

    // The engine that lost the race must be cleaned up immediately, not left
    // dangling in the cache — a subsequent getRagEngine() must build a fresh
    // one rather than resurrecting the torn-down connection.
    expect(engine.getKnowledgeBaseId()).toBe('kb-a')
    // cleanup() clears vectorManager to null (private); we can't read it
    // directly, but we can prove the coordinator's own cache doesn't hold
    // this instance:
    const nextGetVectorManager = jest
      .fn()
      .mockResolvedValue({} as VectorManager)
    ;(dbManager.getVectorManager as jest.Mock) = nextGetVectorManager
    const secondEngine = await coordinator.getRagEngine('kb-a')
    expect(secondEngine).not.toBe(engine)
    expect(nextGetVectorManager).toHaveBeenCalledWith('kb-a')
  })

  it('de-dupes concurrent getRagEngine calls for the same kb into one init', async () => {
    const getVectorManager = jest.fn().mockResolvedValue({} as VectorManager)
    const dbManager = {
      getVectorManager,
      closeKnowledgeBase: jest.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseManager

    const coordinator = new RagCoordinator({
      app: {} as App,
      getSettings: () => baseSettings,
      getDbManager: async () => dbManager,
    })

    const [a, b] = await Promise.all([
      coordinator.getRagEngine('kb-a'),
      coordinator.getRagEngine('kb-a'),
    ])
    expect(a).toBe(b)
    expect(getVectorManager).toHaveBeenCalledTimes(1)
  })
})
