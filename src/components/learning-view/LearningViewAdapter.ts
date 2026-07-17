import {
  Component,
  Keymap,
  MarkdownRenderer,
  Notice,
  getLanguage,
  htmlToMarkdown,
  normalizePath,
} from 'obsidian'

import type {
  YoloAgentEvent,
  YoloAgentRunRequest,
} from '../../core/agent/agent-api'
import { createBrowserAnkiWorkerHost } from '../../core/learning/anki/browserAnkiWorkerHost'
import { ObsidianAnkiImportJournalStorage } from '../../core/learning/anki/obsidianAnkiImportJournalStorage'
import { createObsidianAnkiRuntimeHost } from '../../core/learning/anki/runtime/obsidianAnkiRuntimeHost'
import { LearningCardFileStore } from '../../core/learning/cardFile'
import type {
  LearningGenerationAgentEvent,
  LearningGenerationAgentRequest,
  LearningGenerationCapability,
  LearningGenerationMessage,
} from '../../core/learning/generation/host'
import { createObsidianLearningVaultReadApi } from '../../core/learning/obsidianLearningVaultReadApi'
import { createObsidianLearningVaultWriteApi } from '../../core/learning/obsidianLearningVaultWriteApi'
import { isLLMDebugCaptureEnabled } from '../../core/llm/debugCapture'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import { getYoloLearningDir } from '../../core/paths/yoloPaths'
import type YoloPlugin from '../../main'
import type { ChatAssistantMessage, ChatUserMessage } from '../../types/chat'
import { openMarkdownFile } from '../../utils/obsidian'
import { ConfirmModal } from '../modals/ConfirmModal'

import type {
  LearningLocale,
  LearningSettings,
  LearningUiBridge,
  LearningUiHost,
} from './LearningUiHost'

type LearningVaultServices = Pick<
  LearningUiHost,
  | 'vault'
  | 'vaultWriter'
  | 'ankiImportJournalStorage'
  | 'ankiWorkerHost'
  | 'ankiRuntimeHost'
  | 'cardFileStore'
>

const learningVaultServices = new WeakMap<object, LearningVaultServices>()

function getLearningVaultServices(plugin: YoloPlugin): LearningVaultServices {
  const cached = learningVaultServices.get(plugin.app)
  if (cached) return cached
  const vault = createObsidianLearningVaultReadApi(plugin.app)
  const vaultWriter = createObsidianLearningVaultWriteApi(plugin.app)
  const services = {
    vault,
    vaultWriter,
    ankiImportJournalStorage: new ObsidianAnkiImportJournalStorage(
      plugin.app,
      () => plugin.getLearningSrsStore().getLearningDataRootDir(),
    ),
    ankiWorkerHost: createBrowserAnkiWorkerHost(),
    ankiRuntimeHost: createObsidianAnkiRuntimeHost({
      adapter: plugin.app.vault.adapter,
      manifest: plugin.manifest,
      configDir: plugin.app.vault.configDir,
    }),
    cardFileStore: new LearningCardFileStore(vault, vaultWriter),
  }
  learningVaultServices.set(plugin.app, services)
  return services
}

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

export function subscribeLearningViewWorkspaceChanges(
  plugin: LearningViewPluginAdapter,
  listener: () => void,
): () => void {
  const refs = [
    plugin.app.workspace.on('window-open', listener),
    plugin.app.workspace.on('window-close', listener),
    plugin.app.workspace.on('layout-change', listener),
  ]
  return () => refs.forEach((ref) => plugin.app.workspace.offref(ref))
}

function createLearningUiBridge(plugin: YoloPlugin): LearningUiBridge {
  const app = plugin.app
  return {
    showNotice: (message) => {
      new Notice(message)
    },
    confirm: (options) => {
      new ConfirmModal(app, options).open()
    },
    createMarkdownRenderer: () => {
      const component = new Component()
      component.load()
      return {
        render: (markdown, container, sourcePath) =>
          MarkdownRenderer.render(
            app,
            markdown,
            container,
            sourcePath,
            component,
          ),
        unload: () => component.unload(),
      }
    },
    movePathToTrash: async (path) => {
      const normalizedPath = normalizePath(path)
      const entry = app.vault.getAbstractFileByPath(normalizedPath)
      if (entry) {
        await app.fileManager.trashFile(entry)
        return true
      }
      if (!(await app.vault.adapter.exists(normalizedPath))) return false
      const trashed = await app.vault.adapter.trashSystem(normalizedPath)
      if (!trashed) await app.vault.adapter.trashLocal(normalizedPath)
      return true
    },
    openMarkdownAtLine: (path, line) => openMarkdownFile(app, path, line),
    openLinkText: (linktext, sourcePath, openInNewLeaf) =>
      app.workspace.openLinkText(linktext, sourcePath, openInNewLeaf),
    triggerHoverLink: ({ event, targetEl, linktext, sourcePath }) => {
      app.workspace.trigger('hover-link', {
        event,
        source: 'preview',
        hoverParent: { hoverPopover: null },
        targetEl,
        linktext,
        sourcePath,
      })
    },
    isModEvent: (event) => Boolean(Keymap.isModEvent(event)),
    htmlToMarkdown,
  }
}

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
  const {
    vault,
    vaultWriter,
    ankiImportJournalStorage,
    ankiWorkerHost,
    ankiRuntimeHost,
    cardFileStore,
  } = getLearningVaultServices(plugin)
  return {
    bridge: createLearningUiBridge(plugin),
    vault,
    vaultWriter,
    ankiImportJournalStorage,
    ankiWorkerHost,
    ankiRuntimeHost,
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
    cardFileStore,
    generationAgent: {
      stream: (request) => streamGenerationAgent(plugin, request),
    },
    isGenerationDebugEnabled: isLLMDebugCaptureEnabled,
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
