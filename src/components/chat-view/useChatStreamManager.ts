import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { Notice, TFile } from 'obsidian'
import { useCallback, useRef } from 'react'

import { useApp } from '../../contexts/app-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import { useBufferedRunnerMessages } from '../../hooks/useBufferedRunnerMessages'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
  LLMModelNotFoundException,
} from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import { getEnabledAssistantToolNames } from '../../core/agent/tool-preferences'
import { promoteProviderTransportModeToObsidian } from '../../core/llm/transportModePromotion'
import { listLiteSkillEntries } from '../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../core/skills/skillPolicy'
import { ChatMessage } from '../../types/chat'
import { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { mergeCustomParameters } from '../../utils/custom-parameters'
import { ErrorModal } from '../modals/ErrorModal'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'

import { ChatMode } from './chat-input/ChatModeSelect'
import { ReasoningLevel } from './chat-input/ReasoningSelect'

type UseChatStreamManagerParams = {
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  autoScrollToBottom: () => void
  requestContextBuilder: RequestContextBuilder
  conversationOverrides?: ConversationOverrideSettings
  modelId: string
  chatMode: ChatMode
  currentFileOverride?: TFile | null
  assistantIdOverride?: string
  onRunSettled?: (result: {
    taskKey?: string
    aborted: boolean
    failed: boolean
  }) => void
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

export type UseChatStreamManager = {
  abortActiveStreams: () => void
  submitChatMutation: UseMutationResult<
    { taskKey?: string; aborted: boolean },
    Error,
    {
      chatMessages: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
      taskKey?: string
    }
  >
}

export function useChatStreamManager({
  setChatMessages,
  autoScrollToBottom,
  requestContextBuilder,
  conversationOverrides,
  modelId,
  chatMode,
  currentFileOverride,
  assistantIdOverride,
  onRunSettled,
}: UseChatStreamManagerParams): UseChatStreamManager {
  const app = useApp()
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { getMcpManager } = useMcp()

  const activeStreamAbortControllersRef = useRef<AbortController[]>([])

  const {
    beginBufferedRunnerSession,
    queueBufferedRunnerMessages,
    flushBufferedRunnerMessages,
    abortBufferedRunnerSession,
  } = useBufferedRunnerMessages({
    setChatMessages,
    autoScrollToBottom,
  })

  const handleAutoPromoteToObsidian = useCallback(
    (providerId: string) => {
      void promoteProviderTransportModeToObsidian({
        getSettings: () => plugin.settings,
        setSettings,
        providerId,
      })
    },
    [plugin, setSettings],
  )

  const abortActiveStreams = useCallback(() => {
    for (const abortController of activeStreamAbortControllersRef.current) {
      abortController.abort()
    }
    abortBufferedRunnerSession()
    activeStreamAbortControllersRef.current = []
  }, [abortBufferedRunnerSession])

  const submitChatMutation = useMutation({
    mutationFn: async ({
      chatMessages,
      conversationId,
      reasoningLevel,
      taskKey,
    }: {
      chatMessages: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
      taskKey?: string
    }) => {
      const lastMessage = chatMessages.at(-1)
      if (!lastMessage) {
        // chatMessages is empty
        return {
          taskKey,
          aborted: false,
        }
      }

      abortActiveStreams()
      beginBufferedRunnerSession(chatMessages)
      const abortController = new AbortController()
      activeStreamAbortControllersRef.current.push(abortController)

      let unsubscribeRunner: (() => void) | undefined

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
            onAutoPromoteToObsidian: handleAutoPromoteToObsidian,
          })
        } catch (error) {
          if (
            error instanceof LLMModelNotFoundException &&
            settings.chatModels.length > 0
          ) {
            resolvedClient = getChatModelClient({
              settings,
              modelId: settings.chatModels[0].id,
              onAutoPromoteToObsidian: handleAutoPromoteToObsidian,
            })
          } else {
            throw error
          }
        }

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

        const agentService = plugin.getAgentService()
        unsubscribeRunner = agentService.subscribe(
          conversationId,
          (state) => {
            queueBufferedRunnerMessages({
              responseMessages: state.messages,
              anchorMessageId: lastMessage.id,
              abortController,
            })
          },
          { emitCurrent: false },
        )
        await agentService.run({
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
              stream: conversationOverrides?.stream ?? true,
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
            taskKey,
            aborted: true,
          }
        }
      } catch (error) {
        // Ignore AbortError
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            taskKey,
            aborted: true,
          }
        }
        throw error
      } finally {
        flushBufferedRunnerMessages()
        if (unsubscribeRunner) {
          unsubscribeRunner()
        }
        activeStreamAbortControllersRef.current =
          activeStreamAbortControllersRef.current.filter(
            (controller) => controller !== abortController,
          )
      }

      return {
        taskKey,
        aborted: false,
      }
    },
    onSuccess: (data) => {
      onRunSettled?.({
        taskKey: data.taskKey,
        aborted: data.aborted,
        failed: false,
      })
    },
    onError: (error, variables) => {
      onRunSettled?.({
        taskKey: variables.taskKey,
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
    abortActiveStreams,
    submitChatMutation,
  }
}
