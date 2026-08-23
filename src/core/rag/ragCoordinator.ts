import { App } from 'obsidian'

import { DatabaseManager } from '../../database/DatabaseManager'
import {
  KnowledgeBase,
  YoloSettings,
} from '../../settings/schema/setting.types'

import { RAGEngine } from './ragEngine'

type RagCoordinatorDeps = {
  app: App
  getSettings: () => YoloSettings
  getDbManager: () => Promise<DatabaseManager>
}

/** Caches one `RAGEngine` per knowledge base id, lazily creating each engine
 * (and its underlying `VectorManager`/IndexedDB database, via
 * `DatabaseManager`) on first use. */
export class RagCoordinator {
  private readonly app: App
  private readonly getSettings: () => YoloSettings
  private readonly getDbManager: () => Promise<DatabaseManager>

  private readonly ragEngines = new Map<string, RAGEngine>()
  private readonly ragEngineInitPromises = new Map<string, Promise<RAGEngine>>()
  /** Bumped by `closeRagEngine`. An init that started before a close must not
   * populate the cache after that close resolves — otherwise a `getRagEngine`
   * caller racing a `closeRagEngine`/delete would revive an engine on a
   * database that's being (or has been) closed or deleted out from under it. */
  private readonly closeGenerations = new Map<string, number>()

  constructor(deps: RagCoordinatorDeps) {
    this.app = deps.app
    this.getSettings = deps.getSettings
    this.getDbManager = deps.getDbManager
  }

  /** Every knowledge base currently in settings, in settings order. */
  listKnowledgeBases(): KnowledgeBase[] {
    return this.getSettings().knowledgeBases
  }

  async getRagEngine(kbId: string): Promise<RAGEngine> {
    const cached = this.ragEngines.get(kbId)
    if (cached) {
      return cached
    }

    const inFlight = this.ragEngineInitPromises.get(kbId)
    if (inFlight) {
      return inFlight
    }

    const generationAtStart = this.closeGenerations.get(kbId) ?? 0
    const initPromise = (async () => {
      try {
        const dbManager = await this.getDbManager()
        const vectorManager = await dbManager.getVectorManager(kbId)
        const ragEngine = new RAGEngine(
          this.app,
          this.getSettings(),
          vectorManager,
          kbId,
        )
        // A close (or delete) that started after this init began must win:
        // don't resurrect the cache with an engine built on a connection
        // that's being (or has been) torn down.
        if ((this.closeGenerations.get(kbId) ?? 0) === generationAtStart) {
          this.ragEngines.set(kbId, ragEngine)
        } else {
          ragEngine.cleanup()
        }
        return ragEngine
      } finally {
        this.ragEngineInitPromises.delete(kbId)
      }
    })()
    this.ragEngineInitPromises.set(kbId, initPromise)

    return initPromise
  }

  /** Closes and drops the cached engine for one knowledge base, without
   * touching its stored vectors. Used when a base is deleted (after the
   * caller has already deleted its database) or its config changes enough
   * that a fresh engine should be created next time it's needed. */
  async closeRagEngine(kbId: string): Promise<void> {
    this.closeGenerations.set(kbId, (this.closeGenerations.get(kbId) ?? 0) + 1)
    this.ragEngines.delete(kbId)
    this.ragEngineInitPromises.delete(kbId)
    const dbManager = await this.getDbManager()
    await dbManager.closeKnowledgeBase(kbId)
  }

  updateSettings(settings: YoloSettings) {
    for (const ragEngine of this.ragEngines.values()) {
      ragEngine.setSettings(settings)
    }
  }

  cleanup() {
    for (const ragEngine of this.ragEngines.values()) {
      ragEngine.cleanup()
    }
    this.ragEngines.clear()
    this.ragEngineInitPromises.clear()
  }
}
