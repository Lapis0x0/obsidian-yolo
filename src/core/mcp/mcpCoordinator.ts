import { App } from 'obsidian'

import { SmartComposerSettings } from '../../settings/schema/setting.types'

import { McpManager } from './mcpManager'

type McpCoordinatorDeps = {
  app: App
  getSettings: () => SmartComposerSettings
  registerSettingsListener: (
    listener: (settings: SmartComposerSettings) => void,
  ) => () => void
}

export class McpCoordinator {
  private readonly app: App
  private readonly getSettings: () => SmartComposerSettings
  private readonly registerSettingsListener: (
    listener: (settings: SmartComposerSettings) => void,
  ) => () => void

  private mcpManager: McpManager | null = null
  private mcpManagerInitPromise: Promise<McpManager> | null = null

  constructor(deps: McpCoordinatorDeps) {
    this.app = deps.app
    this.getSettings = deps.getSettings
    this.registerSettingsListener = deps.registerSettingsListener
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
            registerSettingsListener: this.registerSettingsListener,
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
