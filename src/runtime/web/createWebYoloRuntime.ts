import type {
  AgentConversationRunSummary,
  AgentConversationState,
} from '../../core/agent/service'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import {
  type ChatConversationCompactionLike,
  type ChatMessage,
  normalizeChatConversationCompactionState,
} from '../../types/chat'
import type {
  RunYoloAgentInput,
  YoloFileRef,
  YoloPluginInfo,
  YoloRuntime,
  YoloVaultIndexEntry,
} from '../yoloRuntime.types'
import { Notice } from './obsidianCompat'
import { createWebCompatApp } from './createWebCompatApp'
import { createWebCompatPlugin } from './createWebCompatPlugin'
import { createWebCompatibilityBridge } from './createWebCompatibilityBridge'
import { WebApiClient, WebApiError } from './WebApiClient'
import type { WebThemeSnapshot } from './webTheme'

export type WebBootstrapPayload = {
  pluginInfo: YoloPluginInfo
  settings: SmartComposerSettings
  vaultName: string
  activeFile: YoloFileRef | null
  theme: WebThemeSnapshot
}

const IDLE_AGENT_STATE: AgentConversationState = {
  conversationId: '',
  status: 'idle',
  messages: [],
}

type AgentStateListener = (state: AgentConversationState) => void

export function createWebYoloRuntime(
  api: WebApiClient,
  bootstrap: WebBootstrapPayload,
  initialVaultIndex: YoloVaultIndexEntry[],
): YoloRuntime {
  let currentSettings = bootstrap.settings
  const settingsListeners = new Set<(settings: SmartComposerSettings) => void>()
  const agentStates = new Map<string, AgentConversationState>()
  const agentStateListeners = new Map<string, Set<AgentStateListener>>()
  const runSummaryListeners = new Set<
    (summaries: Map<string, AgentConversationRunSummary>) => void
  >()
  let runtime!: YoloRuntime

  const app = createWebCompatApp({
    api,
    vaultName: bootstrap.vaultName,
    initialIndex: initialVaultIndex,
    initialActiveFile: bootstrap.activeFile,
  })
  const plugin = createWebCompatPlugin({
    app,
    pluginInfo: bootstrap.pluginInfo,
    getRuntime: () => runtime,
  })
  const compatibility = createWebCompatibilityBridge({ app, plugin })

  const notifyRunSummaryListeners = () => {
    const summaries = new Map<string, AgentConversationRunSummary>()
    for (const [conversationId, state] of agentStates) {
      summaries.set(conversationId, buildRunSummary(state))
    }
    runSummaryListeners.forEach((listener) => listener(summaries))
  }

  const emitAgentState = (conversationId: string, state: AgentConversationState) => {
    agentStates.set(conversationId, state)
    agentStateListeners.get(conversationId)?.forEach((listener) => {
      listener(state)
    })
    notifyRunSummaryListeners()
  }

  runtime = {
    mode: 'web',
    ...compatibility,
    pluginInfo: bootstrap.pluginInfo,
    settings: {
      get: () => currentSettings,
      update: async (next) => {
        currentSettings = await api.postJson('/api/settings/update', next)
        settingsListeners.forEach((listener) => listener(currentSettings))
      },
      subscribe: (listener) => {
        settingsListeners.add(listener)
        return () => settingsListeners.delete(listener)
      },
    },
    chat: {
      list: () => api.getJson('/api/chat/list'),
      get: async (id) => {
        try {
          return await api.getJson(`/api/chat/get/${encodeURIComponent(id)}`)
        } catch (error) {
          if (error instanceof WebApiError && error.status === 404) {
            return null
          }
          throw error
        }
      },
      save: (input) => api.postJson('/api/chat/save', input),
      delete: (id) => api.postJson('/api/chat/delete', { id }),
      togglePinned: (id) => api.postJson('/api/chat/toggle-pinned', { id }),
      updateTitle: (id, title, options) =>
        api.postJson('/api/chat/update-title', { id, title, ...options }),
      generateTitle: (id, messages) =>
        api.postJson('/api/chat/generate-title', { id, messages }),
    },
    agent: {
      run: async (input: RunYoloAgentInput) => {
        const previousState = agentStates.get(input.conversationId)
        const primedMessages =
          input.conversationMessages ??
          previousState?.messages ??
          input.messages
        const primedCompaction =
          input.compaction == null
            ? (previousState?.compaction ?? [])
            : normalizeChatConversationCompactionState(input.compaction)
        emitAgentState(input.conversationId, {
          conversationId: input.conversationId,
          status: 'running',
          messages: primedMessages,
          compaction: primedCompaction,
        })
        await api.postJson('/api/agent/run', input)
      },
      abort: async (conversationId) => {
        await api.postJson(`/api/agent/abort/${encodeURIComponent(conversationId)}`, {})
      },
      subscribe: (conversationId, listener) => {
        const listeners =
          agentStateListeners.get(conversationId) ?? new Set<AgentStateListener>()
        listeners.add(listener)
        agentStateListeners.set(conversationId, listeners)

        const es = api.openEventSource(
          `/api/agent/stream/${encodeURIComponent(conversationId)}`,
        )
        es.addEventListener('state', (event) => {
          const state = JSON.parse((event as MessageEvent).data) as AgentConversationState
          emitAgentState(conversationId, state)
        })

        return () => {
          listeners.delete(listener)
          es.close()
        }
      },
      getState: (conversationId) =>
        agentStates.get(conversationId) ?? { ...IDLE_AGENT_STATE, conversationId },
      getConversationRunSummary: (conversationId) =>
        buildRunSummary(
          agentStates.get(conversationId) ?? {
            ...IDLE_AGENT_STATE,
            conversationId,
          },
        ),
      getMessages: (conversationId) =>
        agentStates.get(conversationId)?.messages ?? [],
      approveToolCall: async (input) => {
        const res = await api.postJson<{ ok: boolean }>(
          '/api/agent/approve-tool-call',
          input,
        )
        return res.ok
      },
      rejectToolCall: (input) => {
        void api.postJson('/api/agent/reject-tool-call', input)
        return true
      },
      abortToolCall: (input) => {
        void api.postJson('/api/agent/abort-tool-call', input)
        return true
      },
      replaceConversationMessages: (
        conversationId,
        messages,
        compaction,
        _options,
      ) => {
        const previousState =
          agentStates.get(conversationId) ?? {
            ...IDLE_AGENT_STATE,
            conversationId,
          }
        emitAgentState(conversationId, {
          ...previousState,
          conversationId,
          messages,
          compaction:
            compaction == null
              ? undefined
              : normalizeChatConversationCompactionState(
                  compaction as ChatConversationCompactionLike,
                ),
        })
      },
      isRunning: (conversationId) =>
        buildRunSummary(
          agentStates.get(conversationId) ?? {
            ...IDLE_AGENT_STATE,
            conversationId,
          },
        ).isRunning,
      subscribeToRunSummaries: (callback) => {
        runSummaryListeners.add(callback)
        callback(
          new Map(
            Array.from(agentStates.entries()).map(([conversationId, state]) => [
              conversationId,
              buildRunSummary(state),
            ]),
          ),
        )
        return () => runSummaryListeners.delete(callback)
      },
      subscribeToPendingExternalAgentResults: () => () => {},
    },
    vault: {
      getActiveFile: () => app.workspace.getActiveFile(),
      read: async (file) => app.vault.read(file),
      readBinary: async (file) => app.vault.readBinary(file),
      search: (query) =>
        api.getJson(`/api/vault/search?query=${encodeURIComponent(query)}`),
      listIndex: async () =>
        [
          ...app.vault.getAllFolders().filter((folder: {
            path: string
          }) => folder.path !== '/' && folder.path.length > 0).map((folder: {
            path: string
            name: string
          }) => ({
            kind: 'folder' as const,
            path: folder.path,
            name: folder.name,
            basename: folder.name,
            extension: '',
          })),
          ...app.vault.getFiles().map((file: {
            path: string
            name: string
            basename: string
            extension: string
            stat?: {
              ctime: number
              mtime: number
              size: number
            }
          }) => ({
            kind: 'file' as const,
            path: file.path,
            name: file.name,
            basename: file.basename,
            extension: file.extension,
            stat: file.stat,
          })),
        ] satisfies YoloVaultIndexEntry[],
      getAbstractFileByPath: (path) => app.vault.getAbstractFileByPath(path),
      getFileByPath: (path) => app.vault.getFileByPath(path),
      createFolder: (path) => app.vault.createFolder(path),
      modify: (file, content) =>
        app.vault.modify(
          typeof file === 'string' ? app.vault.getFileByPath(file) : file,
          content,
        ),
      create: (path, content) => app.vault.create(path, content),
      trashFile: (file) =>
        app.fileManager.trashFile(
          typeof file === 'string'
            ? app.vault.getAbstractFileByPath(file)
            : file,
        ),
      getLeavesOfType: (type) => app.workspace.getLeavesOfType(type),
      getLeaf: (split) => app.workspace.getLeaf(split),
    },
    ui: {
      notice: (message, timeoutMs) => {
        new Notice(message, timeoutMs)
      },
      openSettings: (tabId) => {
        window.dispatchEvent(
          new CustomEvent('yolo:web-open-settings', {
            detail: tabId ? { tabId } : undefined,
          }),
        )
      },
      openApplyReview: () => Promise.resolve(false),
    },
  }

  return runtime
}

function buildRunSummary(
  state: AgentConversationState,
): AgentConversationRunSummary {
  const isWaitingApproval = (state.messages ?? []).some(
    isPendingApprovalToolMessage,
  )

  return {
    conversationId: state.conversationId,
    status: state.status,
    isRunning: state.status === 'running' && !isWaitingApproval,
    isWaitingApproval,
  }
}

function isPendingApprovalToolMessage(message: ChatMessage): boolean {
  if (message.role !== 'tool') {
    return false
  }

  return message.toolCalls.some(
    (toolCall) => toolCall.response.status === 'pending_approval',
  )
}
