import type { LearningGenerationCapability } from '../../core/learning/generation/host'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import type YoloPlugin from '../../main'

import type { LearningUiHost } from './LearningUiHost'

const localFileToolName = (name: string) =>
  getToolName(getLocalFileToolServerName(), name)

const TOOL_NAMES_BY_CAPABILITY: Record<LearningGenerationCapability, string[]> =
  {
    none: [],
    'readonly-vault': [
      localFileToolName('fs_read'),
      localFileToolName('fs_list'),
    ],
    'edit-vault': [
      localFileToolName('fs_read'),
      localFileToolName('fs_list'),
      localFileToolName('fs_edit'),
    ],
  }

export type LearningViewPluginAdapter = YoloPlugin

export function createLearningUiHost(plugin: YoloPlugin): LearningUiHost {
  return {
    app: plugin.app,
    get settings() {
      return plugin.settings
    },
    t: (keyPath, fallback) => plugin.t(keyPath, fallback),
    get srsStore() {
      return plugin.getLearningSrsStore()
    },
    get statsService() {
      return plugin.getLearningStatsService()
    },
    generationAgent: {
      stream: ({ capability, ...request }) =>
        plugin.agent.stream({
          ...request,
          tools: { allowedToolNames: TOOL_NAMES_BY_CAPABILITY[capability] },
        }),
    },
    runtimeIdentity: {
      pluginId: plugin.manifest.id,
      pluginDir: plugin.manifest.dir,
    },
    setSettings: (settings) => plugin.setSettings(settings),
    subscribeSettings: (listener) => plugin.addSettingsChangeListener(listener),
    setEventBus: (bus) => plugin.setLearningEventBus(bus),
    setNavigationHandler: (handler) =>
      plugin.setLearningNavigationHandler(handler),
    openLearningView: (target) => plugin.openLearningView(target),
    trackGeneration: (controller) => plugin.trackLearningGeneration(controller),
    releaseGeneration: (controller) =>
      plugin.releaseLearningGeneration(controller),
    showActionToast: (toast) => plugin.showActionToast(toast),
  }
}
