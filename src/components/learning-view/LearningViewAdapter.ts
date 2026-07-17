import { getLanguage } from 'obsidian'

import type { LearningGenerationCapability } from '../../core/learning/generation/host'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import { getYoloLearningDir } from '../../core/paths/yoloPaths'
import type YoloPlugin from '../../main'

import type {
  LearningLocale,
  LearningSettings,
  LearningUiHost,
} from './LearningUiHost'

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

const mapSettings = (plugin: YoloPlugin): LearningSettings => ({
  learningBaseDir: getYoloLearningDir(plugin.settings),
  generationModelId: plugin.settings.learningOptions.modelId,
  fallbackModelId: plugin.settings.chatModelId,
})

const resolveLocale = (): LearningLocale => {
  const language = String(getLanguage() ?? '')
    .trim()
    .toLowerCase()
  if (language.startsWith('zh')) return 'zh'
  if (language.startsWith('it')) return 'it'
  return 'en'
}

export function createLearningUiHost(plugin: YoloPlugin): LearningUiHost {
  return {
    app: plugin.app,
    get settings() {
      return mapSettings(plugin)
    },
    locale: resolveLocale(),
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
    subscribeSettings: (listener) =>
      plugin.addSettingsChangeListener(() => listener(mapSettings(plugin))),
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
