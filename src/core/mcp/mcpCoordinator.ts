import { App } from 'obsidian'

import { YoloSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'
import type { RAGEngine } from '../rag/ragEngine'

import { McpManager } from './mcpManager'

type McpCoordinatorDeps = {
  app: App
  getSettings: () => YoloSettings
  openApplyReview: (state: ApplyViewState) => Promise<boolean>
  registerSettingsListener: (
    listener: (settings: YoloSettings) => void,
  ) => () => void
  getRagEngine?: () => Promise<RAGEngine>
  promptSourceWatcher?: PromptSourceWatcher
}

export class McpCoordinator {
  private readonly app: App
  private readonly getSettings: () => YoloSettings
  private readonly openApplyReview: McpCoordinatorDeps['openApplyReview']
  private readonly registerSettingsListener: (
    listener: (settings: YoloSettings) => void,
  ) => () => void
  private readonly getRagEngine?: () => Promise<RAGEngine>
  private readonly promptSourceWatcher?: PromptSourceWatcher

  private mcpManager: McpManager | null = null
  private mcpManagerInitPromise: Promise<McpManager> | null = null

  constructor(deps: McpCoordinatorDeps) {
    this.app = deps.app
    this.getSettings = deps.getSettings
    this.openApplyReview = deps.openApplyReview
    this.registerSettingsListener = deps.registerSettingsListener
    this.getRagEngine = deps.getRagEngine
    this.promptSourceWatcher = deps.promptSourceWatcher
  }

  async getMcpManager(): Promise<McpManager> {
    if (this.mcpManager) {
      return this.mcpManager
    }

    if (!this.mcpManagerInitPromise) {
      this.mcpManagerInitPromise = (async () => {
        try {
          this.mcpManager = new McpManager({
            app: this.app,
            settings: this.getSettings(),
            openApplyReview: this.openApplyReview,
            registerSettingsListener: this.registerSettingsListener,
            getRagEngine: this.getRagEngine,
            promptSourceWatcher: this.promptSourceWatcher,
          })
          await this.mcpManager.initialize()
          return this.mcpManager
        } catch (error) {
          this.mcpManager = null
          this.mcpManagerInitPromise = null
          throw error
        }
      })()
    }

    return this.mcpManagerInitPromise
  }

  cleanup() {
    if (this.mcpManager) {
      this.mcpManager.cleanup()
    }
    this.mcpManager = null
    this.mcpManagerInitPromise = null
  }
}
