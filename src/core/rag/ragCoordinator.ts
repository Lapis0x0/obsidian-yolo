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
        this.ragEngines.set(kbId, ragEngine)
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
