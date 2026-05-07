import { Notice } from 'obsidian'
import type SmartComposerPlugin from '../../main'
import type { YoloRuntime } from '../yoloRuntime.types'
import { createObsidianRuntimeAgent } from './obsidianRuntimeAgent'
import { createObsidianRuntimeChat } from './obsidianRuntimeChat'
import { createObsidianRuntimeVault } from './obsidianRuntimeVault'
import { createObsidianCompatibilityBridge } from './createObsidianCompatibilityBridge'

export function createObsidianYoloRuntime(
  plugin: SmartComposerPlugin,
): YoloRuntime {
  const compatibility = createObsidianCompatibilityBridge(plugin)

  return {
    mode: 'obsidian',
    ...compatibility,
    pluginInfo: {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      dir: plugin.manifest.dir,
    },
    settings: {
      get: () => plugin.settings,
      update: (next) => plugin.setSettings(next),
      subscribe: (listener) => plugin.addSettingsChangeListener(listener),
    },
    chat: createObsidianRuntimeChat(plugin),
    agent: createObsidianRuntimeAgent(plugin),
    vault: createObsidianRuntimeVault(plugin.app),
    ui: {
      notice: (message, timeoutMs) => {
        new Notice(message, timeoutMs)
      },
      openSettings: (tabId) => {
        // @ts-expect-error - app.setting exists at runtime but is not in Obsidian's public types
        plugin.app.setting.open()
        // @ts-expect-error - app.setting.openTabById exists at runtime but is not in Obsidian's public types
        plugin.app.setting.openTabById(tabId ?? plugin.manifest.id)
      },
      openApplyReview: (state) => plugin.openApplyReview(state as any),
    },
  }
}
