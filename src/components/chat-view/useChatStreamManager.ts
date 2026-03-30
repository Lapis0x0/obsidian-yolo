import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { Notice, TFile } from 'obsidian'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import type {
  AgentConversationRunSummary,
  AgentConversationState,
} from '../../core/agent/service'
import {
  buildManualCompactionState,
  createConversationCompactionSummary,
} from '../../core/agent/compaction'
import { getEnabledAssistantToolNames } from '../../core/agent/tool-preferences'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
  LLMModelNotFoundException,
} from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import { shouldUseStreamingForProvider } from '../../core/llm/streamingPolicy'
import { promoteProviderTransportModeToObsidian } from '../../core/llm/transportModePromotion'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import { listLiteSkillEntries } from '../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../core/skills/skillPolicy'
import {
  ChatConversationCompaction,
  ChatConversationCompactionState,
  ChatMessage,
} from '../../types/chat'
import { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { mergeCustomParameters } from '../../utils/custom-parameters'
import { ErrorModal } from '../modals/ErrorModal'

import { ChatMode } from './chat-input/ChatModeSelect'
import { ReasoningLevel } from './chat-input/ReasoningSelect'

type UseChatStreamManagerParams = {
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  setCompactionState: React.Dispatch<
    React.SetStateAction<ChatConversationCompactionState>
  >
  setPendingCompactionAnchorMessageId: React.Dispatch<
    React.SetStateAction<string | null>
  >
  autoScrollToBottom: () => void
  requestContextBuilder: RequestContextBuilder
  currentConversationId: string
  conversationOverrides?: ConversationOverrideSettings
  modelId: string
  chatMode: ChatMode
  currentFileOverride?: TFile | null
  assistantIdOverride?: string
  compaction?: ChatConversationCompactionState
  onRunSettled?: (result: { aborted: boolean; failed: boolean }) => void
}

const DEFAULT_MAX_AUTO_TOOL_ITERATIONS = 100
const CHAT_READONLY_TOOL_NAMES = [
  getToolName(getLocalFileToolServerName(), 'fs_search'),
  getToolName(getLocalFileToolServerName(), 'fs_read'),
  getToolName(getLocalFileToolServerName(), 'memory_add'),
  getToolName(getLocalFileToolServerName(), 'memory_update'),
  getToolName(getLocalFileToolServerName(), 'memory_delete'),
  getToolName(getLocalFileToolServerName(), 'open_skill'),
]

const buildRunSummary = ({
  conversationId,
  status,
  messages,
}: AgentConversationState): AgentConversationRunSummary => {
  const isWaitingApproval = messages.some(
    (message) =>
      message.role === 'tool' &&
      message.toolCalls.some(
        (toolCall) =>
          toolCall.response.status === ToolCallResponseStatus.PendingApproval,
      ),
  )

  return {
    conversationId,
    status,
    isRunning: status === 'running' && !isWaitingApproval,
    isWaitingApproval,
  }
}

export type UseChatStreamManager = {
  abortConversationRun: (conversationId: string) => void
  compactConversation: (
    messages: ChatMessage[],
  ) => Promise<ChatConversationCompaction | null>
  currentConversationRunSummary: AgentConversationRunSummary
  submitChatMutation: UseMutationResult<
    { aborted: boolean },
    Error,
    {
      chatMessages: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
    }
  >
}

export function useChatStreamManager({
  setChatMessages,
  setCompactionState,
  setPendingCompactionAnchorMessageId,
  autoScrollToBottom,
  requestContextBuilder,
  currentConversationId,
  conversationOverrides,
  modelId,
  chatMode,
  currentFileOverride,
  assistantIdOverride,
  compaction,
  onRunSettled,
}: UseChatStreamManagerParams): UseChatStreamManager {
  const app = useApp()
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { getMcpManager } = useMcp()

  const activeStreamAbortControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  )
  const [currentConversationRunSummary, setCurrentConversationRunSummary] =
    useState<AgentConversationRunSummary>(() =>
      plugin.getAgentService().getConversationRunSummary(currentConversationId),
    )

  const handleAutoPromoteTransportMode = useCallback(
    (providerId: string, mode: 'node' | 'obsidian') => {
      void promoteProviderTransportModeToObsidian({
        getSettings: () => plugin.settings,
        setSettings,
        providerId,
        mode,
      })
    },
    [plugin, setSettings],
  )

  useEffect(() => {
    const agentService = plugin.getAgentService()

    const syncConversationState = (state: AgentConversationState) => {
      const runSummary = buildRunSummary(state)
      setCurrentConversationRunSummary(runSummary)
      const hasTrackedState =
        state.messages.length > 0 || state.status !== 'idle'
      if (!hasTrackedState) {
        return
      }

      setChatMessages(state.messages)
      setCompactionState(state.compaction ?? [])
      setPendingCompactionAnchorMessageId(
        state.pendingCompactionAnchorMessageId ?? null,
      )
      if (!(state.status === 'running' || runSummary.isWaitingApproval)) {
        return
      }

      if (
        state.messages.length > 0 &&
        !state.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.metadata?.generationState === 'streaming',
        )
      ) {
        requestAnimationFrame(() => {
          autoScrollToBottom()
        })
      }
    }

    syncConversationState(agentService.getState(currentConversationId))

    const unsubscribe = agentService.subscribe(
      currentConversationId,
      syncConversationState,
      { emitCurrent: false },
    )

    return () => {
      unsubscribe()
    }
  }, [
    autoScrollToBottom,
    currentConversationId,
    plugin,
    setChatMessages,
    setCompactionState,
    setPendingCompactionAnchorMessageId,
  ])

  const abortConversationRun = useCallback(
    (conversationId: string) => {
      activeStreamAbortControllersRef.current.get(conversationId)?.abort()
      activeStreamAbortControllersRef.current.delete(conversationId)
      plugin.getAgentService().abortConversation(conversationId)
    },
    [plugin],
  )

  const resolveCompactionClient = useCallback(() => {
    const effectiveAssistantId =
      assistantIdOverride ?? settings.currentAssistantId
    const selectedAssistant = effectiveAssistantId
      ? (settings.assistants || []).find(
          (assistant) => assistant.id === effectiveAssistantId,
        ) || null
      : null

    const requestedModelId =
      modelId || selectedAssistant?.modelId || settings.chatModelId
    const compactionModelId = settings.chatTitleModelId || requestedModelId

    let resolvedClient: ReturnType<typeof getChatModelClient>
    try {
      resolvedClient = getChatModelClient({
        settings,
        modelId: requestedModelId,
        onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
      })
    } catch (error) {
      if (
        error instanceof LLMModelNotFoundException &&
        settings.chatModels.length > 0
      ) {
        resolvedClient = getChatModelClient({
          settings,
          modelId: settings.chatModels[0].id,
          onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
        })
      } else {
        throw error
      }
    }

    try {
      return getChatModelClient({
        settings,
        modelId: compactionModelId,
        onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
      })
    } catch {
      return resolvedClient
    }
  }, [assistantIdOverride, handleAutoPromoteTransportMode, modelId, settings])

  const compactConversation = useCallback(
    async (messages: ChatMessage[]) => {
      if (messages.length === 0) {
        return null
      }

      const resolvedCompactionClient = resolveCompactionClient()
      const summary = await createConversationCompactionSummary({
        providerClient: resolvedCompactionClient.providerClient,
        model: resolvedCompactionClient.model,
        messages,
      })

      return buildManualCompactionState({
        messages,
        summary,
        summaryModelId: resolvedCompactionClient.model.id,
      })
    },
    [resolveCompactionClient],
  )

  const submitChatMutation = useMutation({
    mutationFn: async ({
      chatMessages,
      conversationId,
      reasoningLevel,
    }: {
      chatMessages: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
    }) => {
      const lastMessage = chatMessages.at(-1)
      if (!lastMessage) {
        return {
          aborted: false,
        }
      }

      abortConversationRun(conversationId)

      const abortController = new AbortController()
      activeStreamAbortControllersRef.current.set(
        conversationId,
        abortController,
      )

      try {
        const effectiveAssistantId =
          assistantIdOverride ?? settings.currentAssistantId
        const selectedAssistant = effectiveAssistantId
          ? (settings.assistants || []).find(
              (assistant) => assistant.id === effectiveAssistantId,
            ) || null
          : null

        const requestedModelId =
          modelId || selectedAssistant?.modelId || settings.chatModelId

        let resolvedClient: ReturnType<typeof getChatModelClient>
        try {
          resolvedClient = getChatModelClient({
            settings,
            modelId: requestedModelId,
            onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
          })
        } catch (error) {
          if (
            error instanceof LLMModelNotFoundException &&
            settings.chatModels.length > 0
          ) {
            resolvedClient = getChatModelClient({
              settings,
              modelId: settings.chatModels[0].id,
              onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
            })
          } else {
            throw error
          }
        }

        const currentProvider = settings.providers.find(
          (provider) => provider.id === resolvedClient.model.providerId,
        )
        const resolvedCompactionClient = resolveCompactionClient()
        const shouldStreamResponse = shouldUseStreamingForProvider({
          requestedStream: conversationOverrides?.stream ?? true,
          provider: currentProvider,
        })

        const modelTemperature = resolvedClient.model.temperature
        const modelTopP = resolvedClient.model.topP
        const modelMaxTokens = resolvedClient.model.maxOutputTokens
        const assistantTemperature =
          chatMode === 'agent' ? selectedAssistant?.temperature : undefined
        const assistantTopP =
          chatMode === 'agent' ? selectedAssistant?.topP : undefined
        const assistantMaxTokens =
          chatMode === 'agent' ? selectedAssistant?.maxOutputTokens : undefined
        const assistantMaxContextMessages =
          chatMode === 'agent'
            ? selectedAssistant?.maxContextMessages
            : undefined
        const effectiveModel =
          chatMode === 'agent' && selectedAssistant
            ? {
                ...resolvedClient.model,
                customParameters: mergeCustomParameters(
                  resolvedClient.model.customParameters,
                  selectedAssistant.customParameters,
                ),
              }
            : resolvedClient.model
        const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
        const enabledSkillEntries = selectedAssistant
          ? listLiteSkillEntries(app, { settings }).filter((skill) =>
              isSkillEnabledForAssistant({
                assistant: selectedAssistant,
                skillId: skill.id,
                disabledSkillIds,
              }),
            )
          : []
        const allowedSkillIds = enabledSkillEntries.map((skill) => skill.id)
        const allowedSkillNames = enabledSkillEntries.map((skill) => skill.name)

        const effectiveEnableTools =
          chatMode === 'agent' ? (selectedAssistant?.enableTools ?? true) : true
        const effectiveIncludeBuiltinTools = effectiveEnableTools
          ? chatMode === 'agent'
            ? (selectedAssistant?.includeBuiltinTools ?? true)
            : true
          : false
        const effectiveAllowedToolNames = effectiveEnableTools
          ? chatMode === 'agent'
            ? getEnabledAssistantToolNames(selectedAssistant)
            : CHAT_READONLY_TOOL_NAMES
          : undefined

        const mcpManager = await getMcpManager()

        await plugin.getAgentService().run({
          conversationId,
          loopConfig: {
            enableTools: effectiveEnableTools,
            maxAutoIterations: DEFAULT_MAX_AUTO_TOOL_ITERATIONS,
            includeBuiltinTools: effectiveIncludeBuiltinTools,
          },
          input: {
            providerClient: resolvedClient.providerClient,
            model: effectiveModel,
            messages: chatMessages,
            conversationId,
            requestContextBuilder,
            mcpManager,
            compaction,
            compactionProviderClient: resolvedCompactionClient.providerClient,
            compactionModel: resolvedCompactionClient.model,
            abortSignal: abortController.signal,
            reasoningLevel,
            allowedToolNames: effectiveAllowedToolNames,
            toolPreferences:
              chatMode === 'agent'
                ? selectedAssistant?.toolPreferences
                : undefined,
            allowedSkillIds,
            allowedSkillNames,
            requestParams: {
              stream: shouldStreamResponse,
              temperature:
                conversationOverrides?.temperature ??
                assistantTemperature ??
                modelTemperature,
              top_p: conversationOverrides?.top_p ?? assistantTopP ?? modelTopP,
              max_tokens: assistantMaxTokens ?? modelMaxTokens,
            },
            maxContextOverride:
              conversationOverrides?.maxContextMessages ??
              assistantMaxContextMessages ??
              undefined,
            currentFileContextMode: chatMode === 'agent' ? 'summary' : 'full',
            currentFileOverride,
            geminiTools: {
              useWebSearch: conversationOverrides?.useWebSearch ?? false,
              useUrlContext: conversationOverrides?.useUrlContext ?? false,
            },
          },
        })

        if (abortController.signal.aborted) {
          return {
            aborted: true,
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            aborted: true,
          }
        }
        throw error
      } finally {
        if (
          activeStreamAbortControllersRef.current.get(conversationId) ===
          abortController
        ) {
          activeStreamAbortControllersRef.current.delete(conversationId)
        }
      }

      return {
        aborted: false,
      }
    },
    onSuccess: (data) => {
      onRunSettled?.({
        aborted: data.aborted,
        failed: false,
      })
    },
    onError: (error) => {
      onRunSettled?.({
        aborted: false,
        failed: true,
      })
      if (
        error instanceof LLMAPIKeyNotSetException ||
        error instanceof LLMAPIKeyInvalidException ||
        error instanceof LLMBaseUrlNotSetException
      ) {
        new ErrorModal(app, 'Error', error.message, error.rawError?.message, {
          showSettingsButton: true,
        }).open()
      } else {
        new Notice(error.message)
        console.error('Failed to generate response', error)
      }
    },
  })

  return {
    abortConversationRun,
    currentConversationRunSummary,
    compactConversation,
    submitChatMutation,
  }
}
