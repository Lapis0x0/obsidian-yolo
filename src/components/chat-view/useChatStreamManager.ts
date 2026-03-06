import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { Notice, TFile } from 'obsidian'
import { useCallback, useRef } from 'react'

import { useApp } from '../../contexts/app-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
  LLMModelNotFoundException,
} from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import { listLiteSkillEntries } from '../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../core/skills/skillPolicy'
import { ChatMessage } from '../../types/chat'
import { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { mergeCustomParameters } from '../../utils/custom-parameters'
import { ErrorModal } from '../modals/ErrorModal'

import { ChatMode } from './chat-input/ChatModeSelect'
import { ReasoningLevel } from './chat-input/ReasoningSelect'

type UseChatStreamManagerParams = {
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  autoScrollToBottom: () => void
  promptGenerator: PromptGenerator
  conversationOverrides?: ConversationOverrideSettings
  modelId: string
  chatMode: ChatMode
  currentFileOverride?: TFile | null
  assistantIdOverride?: string
}

const DEFAULT_MAX_AUTO_TOOL_ITERATIONS = 100

const reconcileAssistantGenerationState = (
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
): ChatMessage[] => {
  const previousAssistantStateMap = new Map(
    previousMessages
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.id, message.metadata?.generationState]),
  )

  return nextMessages.map((message) => {
    if (message.role !== 'assistant') {
      return message
    }

    const previousGenerationState = previousAssistantStateMap.get(message.id)
    if (
      previousGenerationState === 'aborted' &&
      message.metadata?.generationState === 'streaming'
    ) {
      return {
        ...message,
        metadata: {
          ...message.metadata,
          generationState: 'aborted',
        },
      }
    }

    return message
  })
}

export type UseChatStreamManager = {
  abortActiveStreams: () => void
  submitChatMutation: UseMutationResult<
    void,
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
  autoScrollToBottom,
  promptGenerator,
  conversationOverrides,
  modelId,
  chatMode,
  currentFileOverride,
  assistantIdOverride,
}: UseChatStreamManagerParams): UseChatStreamManager {
  const app = useApp()
  const plugin = usePlugin()
  const { settings } = useSettings()
  const { getMcpManager } = useMcp()

  const activeStreamAbortControllersRef = useRef<AbortController[]>([])

  const abortActiveStreams = useCallback(() => {
    for (const abortController of activeStreamAbortControllersRef.current) {
      abortController.abort()
    }
    setChatMessages((prevChatMessages) => {
      let hasUpdates = false
      const nextChatMessages = prevChatMessages.map((message) => {
        if (
          message.role !== 'assistant' ||
          message.metadata?.generationState !== 'streaming'
        ) {
          return message
        }

        hasUpdates = true
        return {
          ...message,
          metadata: {
            ...message.metadata,
            generationState: 'aborted' as const,
          },
        }
      })

      return hasUpdates ? nextChatMessages : prevChatMessages
    })
    activeStreamAbortControllersRef.current = []
  }, [setChatMessages])

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
        // chatMessages is empty
        return
      }

      abortActiveStreams()
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
          })
        } catch (error) {
          if (
            error instanceof LLMModelNotFoundException &&
            settings.chatModels.length > 0
          ) {
            resolvedClient = getChatModelClient({
              settings,
              modelId: settings.chatModels[0].id,
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
        const enabledSkillEntries =
          chatMode === 'agent' && selectedAssistant
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
          chatMode === 'agent'
            ? (selectedAssistant?.enableTools ?? true)
            : false
        const effectiveIncludeBuiltinTools = effectiveEnableTools
          ? (selectedAssistant?.includeBuiltinTools ?? true)
          : false

        const mcpManager = await getMcpManager()
        const onRunnerMessages = (responseMessages: ChatMessage[]) => {
          setChatMessages((prevChatMessages) => {
            const lastMessageIndex = prevChatMessages.findIndex(
              (message) => message.id === lastMessage.id,
            )
            if (lastMessageIndex === -1) {
              // The last message no longer exists in the chat history.
              // This likely means a new message was submitted while this stream was running.
              // Abort this stream and keep the current chat history.
              abortController.abort()
              return prevChatMessages
            }
            return reconcileAssistantGenerationState(prevChatMessages, [
              ...prevChatMessages.slice(0, lastMessageIndex + 1),
              ...responseMessages,
            ])
          })
          autoScrollToBottom()
        }

        const agentService = plugin.getAgentService()
        unsubscribeRunner = agentService.subscribe(
          conversationId,
          (state) => {
            onRunnerMessages(state.messages)
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
            promptGenerator,
            mcpManager,
            abortSignal: abortController.signal,
            reasoningLevel,
            allowedToolNames: effectiveEnableTools
              ? selectedAssistant?.enabledToolNames
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
      } catch (error) {
        // Ignore AbortError
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        throw error
      } finally {
        if (unsubscribeRunner) {
          unsubscribeRunner()
        }
        activeStreamAbortControllersRef.current =
          activeStreamAbortControllersRef.current.filter(
            (controller) => controller !== abortController,
          )
      }
    },
    onError: (error) => {
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
