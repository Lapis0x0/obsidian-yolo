import { getLanguage } from 'obsidian'

import type {
  YoloAgentEvent,
  YoloAgentRunRequest,
} from '../../core/agent/agent-api'
import type {
  LearningGenerationAgentEvent,
  LearningGenerationAgentRequest,
  LearningGenerationCapability,
  LearningGenerationMessage,
} from '../../core/learning/generation/host'
import { isLLMDebugCaptureEnabled } from '../../core/llm/debugCapture'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import { getYoloLearningDir } from '../../core/paths/yoloPaths'
import type YoloPlugin from '../../main'
import type { ChatAssistantMessage, ChatUserMessage } from '../../types/chat'

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

const mapGenerationMessage = (
  message: LearningGenerationMessage,
): ChatUserMessage | ChatAssistantMessage => {
  if (message.role === 'user') {
    return {
      role: 'user',
      id: message.id,
      content: null,
      promptContent: message.promptContent,
      mentionables: [],
    }
  }
  return {
    role: 'assistant',
    id: message.id,
    content: message.content,
  }
}

const mapGenerationRequest = (
  request: LearningGenerationAgentRequest,
): YoloAgentRunRequest => ({
  ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
  ...(request.messages
    ? { messages: request.messages.map(mapGenerationMessage) }
    : {}),
  ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
  mode: 'agent',
  yolo: true,
  systemPromptOverride: request.systemPromptOverride,
  tools: {
    allowedToolNames: TOOL_NAMES_BY_CAPABILITY[request.capability],
  },
  ...(request.workspaceScope
    ? {
        workspaceScope: {
          enabled: request.workspaceScope.enabled,
          include: [...request.workspaceScope.include],
          exclude: [...request.workspaceScope.exclude],
        },
      }
    : {}),
  ...(request.activity
    ? {
        activity: {
          kind: request.activity.kind,
          title: request.activity.title,
          ...(request.activity.detail !== undefined
            ? { detail: request.activity.detail }
            : {}),
          ...(request.activity.action !== undefined
            ? { action: request.activity.action }
            : {}),
        },
      }
    : {}),
  ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
})

const mapGenerationEvent = (
  event: YoloAgentEvent,
): LearningGenerationAgentEvent | null => {
  switch (event.type) {
    case 'text':
      return { type: 'text', text: event.text, delta: event.delta }
    case 'tool':
      return {
        type: 'tool',
        name: event.name,
        status: event.status,
        ...(event.arguments ? { arguments: event.arguments } : {}),
      }
    case 'completed':
      return { type: 'completed', text: event.text }
    case 'error':
      return { type: 'error', message: event.message }
    case 'state':
      return null
  }
}

async function* streamGenerationAgent(
  plugin: YoloPlugin,
  request: LearningGenerationAgentRequest,
): AsyncIterable<LearningGenerationAgentEvent> {
  for await (const event of plugin.agent.stream(
    mapGenerationRequest(request),
  )) {
    const mapped = mapGenerationEvent(event)
    if (mapped) yield mapped
  }
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
      stream: (request) => streamGenerationAgent(plugin, request),
    },
    isGenerationDebugEnabled: isLLMDebugCaptureEnabled,
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
