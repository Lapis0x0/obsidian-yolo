import { App } from 'obsidian'

import { DatabaseManager } from '../../database/DatabaseManager'
import { SmartComposerSettings } from '../../settings/schema/setting.types'

import { RAGEngine } from './ragEngine'

type RagCoordinatorDeps = {
  app: App
  getSettings: () => SmartComposerSettings
  getDbManager: () => Promise<DatabaseManager>
}

export class RagCoordinator {
  private readonly app: App
  private readonly getSettings: () => SmartComposerSettings
  private readonly getDbManager: () => Promise<DatabaseManager>

  private ragEngine: RAGEngine | null = null
  private ragEngineInitPromise: Promise<RAGEngine> | null = null

  constructor(deps: RagCoordinatorDeps) {
    this.app = deps.app
    this.getSettings = deps.getSettings
    this.getDbManager = deps.getDbManager
  }

  async getRagEngine(): Promise<RAGEngine> {
    if (this.ragEngine) {
      return this.ragEngine
    }

    if (!this.ragEngineInitPromise) {
      this.ragEngineInitPromise = (async () => {
        try {
          const dbManager = await this.getDbManager()
          this.ragEngine = new RAGEngine(
            this.app,
            this.getSettings(),
            dbManager.getVectorManager(),
          )
          return this.ragEngine
        } catch (error) {
          this.ragEngineInitPromise = null
          throw error
        }
      })()
    }

    return this.ragEngineInitPromise
  }

  updateSettings(settings: SmartComposerSettings) {
    this.ragEngine?.setSettings(settings)
  }

  cleanup() {
    this.ragEngine?.cleanup()
    this.ragEngine = null
    this.ragEngineInitPromise = null
  }
}
