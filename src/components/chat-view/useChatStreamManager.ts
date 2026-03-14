import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { Notice, TFile } from 'obsidian'
import { useCallback, useEffect, useRef } from 'react'

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
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'

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
const CHAT_READONLY_TOOL_NAMES = [
  getToolName(getLocalFileToolServerName(), 'fs_search'),
  getToolName(getLocalFileToolServerName(), 'fs_read'),
  getToolName(getLocalFileToolServerName(), 'open_skill'),
]
const MIN_STREAM_FLUSH_INTERVAL_MS = 16
const FAST_STREAM_FLUSH_INTERVAL_MS = 24
const BALANCED_STREAM_FLUSH_INTERVAL_MS = 32
const IDLE_STREAM_FLUSH_INTERVAL_MS = 40

function getNowMs(): number {
  if (typeof performance !== 'undefined') {
    return performance.now()
  }

  return Date.now()
}

function getAssistantVisibleTextLength(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    if (message.role !== 'assistant') {
      return total
    }

    return total + message.content.length + (message.reasoning?.length ?? 0)
  }, 0)
}

function hasStreamingAssistantMessage(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.metadata?.generationState === 'streaming',
  )
}

function getStreamFlushInterval(charsPerSecond: number): number {
  if (charsPerSecond >= 220) {
    return MIN_STREAM_FLUSH_INTERVAL_MS
  }

  if (charsPerSecond >= 120) {
    return FAST_STREAM_FLUSH_INTERVAL_MS
  }

  if (charsPerSecond >= 48) {
    return BALANCED_STREAM_FLUSH_INTERVAL_MS
  }

  return IDLE_STREAM_FLUSH_INTERVAL_MS
}

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
  const pendingRunnerMessagesRef = useRef<ChatMessage[] | null>(null)
  const pendingLastUserMessageRef = useRef<ChatMessage | null>(null)
  const pendingAbortControllerRef = useRef<AbortController | null>(null)
  const streamFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const streamFlushRafRef = useRef<number | null>(null)
  const lastFlushAtRef = useRef(0)
  const smoothedCharsPerSecondRef = useRef(0)
  const lastObservedRunnerSnapshotRef = useRef({ at: 0, textLength: 0 })

  const resetStreamSchedulingState = useCallback(() => {
    pendingRunnerMessagesRef.current = null
    pendingLastUserMessageRef.current = null
    pendingAbortControllerRef.current = null
    lastFlushAtRef.current = 0
    smoothedCharsPerSecondRef.current = 0
    lastObservedRunnerSnapshotRef.current = { at: 0, textLength: 0 }
  }, [])

  const cancelScheduledRunnerFlush = useCallback(() => {
    if (streamFlushTimeoutRef.current) {
      clearTimeout(streamFlushTimeoutRef.current)
      streamFlushTimeoutRef.current = null
    }

    if (streamFlushRafRef.current !== null) {
      cancelAnimationFrame(streamFlushRafRef.current)
      streamFlushRafRef.current = null
    }
  }, [])

  const flushPendingRunnerMessages = useCallback(() => {
    const responseMessages = pendingRunnerMessagesRef.current
    const lastUserMessage = pendingLastUserMessageRef.current
    if (!responseMessages || !lastUserMessage) {
      return
    }

    pendingRunnerMessagesRef.current = null
    pendingLastUserMessageRef.current = null
    lastFlushAtRef.current = getNowMs()

    setChatMessages((prevChatMessages) => {
      const lastMessageIndex = prevChatMessages.findIndex(
        (message) => message.id === lastUserMessage.id,
      )
      if (lastMessageIndex === -1) {
        pendingAbortControllerRef.current?.abort()
        return prevChatMessages
      }

      return reconcileAssistantGenerationState(prevChatMessages, [
        ...prevChatMessages.slice(0, lastMessageIndex + 1),
        ...responseMessages,
      ])
    })
    if (!hasStreamingAssistantMessage(responseMessages)) {
      requestAnimationFrame(() => {
        autoScrollToBottom()
        requestAnimationFrame(() => {
          autoScrollToBottom()
        })
      })
    }
  }, [autoScrollToBottom, setChatMessages])

  const scheduleRunnerMessagesFlush = useCallback(
    (options?: { immediate?: boolean }) => {
      const immediate = options?.immediate ?? false
      cancelScheduledRunnerFlush()

      const requestFlush = () => {
        streamFlushRafRef.current = requestAnimationFrame(() => {
          streamFlushRafRef.current = null
          flushPendingRunnerMessages()
        })
      }

      if (immediate) {
        flushPendingRunnerMessages()
        return
      }

      const now = getNowMs()
      const targetInterval = getStreamFlushInterval(
        smoothedCharsPerSecondRef.current,
      )
      const elapsedSinceLastFlush = lastFlushAtRef.current
        ? now - lastFlushAtRef.current
        : targetInterval
      const waitMs = Math.max(0, targetInterval - elapsedSinceLastFlush)

      if (waitMs === 0) {
        requestFlush()
        return
      }

      streamFlushTimeoutRef.current = setTimeout(() => {
        streamFlushTimeoutRef.current = null
        requestFlush()
      }, waitMs)
    },
    [cancelScheduledRunnerFlush, flushPendingRunnerMessages],
  )

  useEffect(() => {
    return () => {
      cancelScheduledRunnerFlush()
      resetStreamSchedulingState()
    }
  }, [cancelScheduledRunnerFlush, resetStreamSchedulingState])

  const abortActiveStreams = useCallback(() => {
    cancelScheduledRunnerFlush()
    resetStreamSchedulingState()
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
  }, [cancelScheduledRunnerFlush, resetStreamSchedulingState, setChatMessages])

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
            ? selectedAssistant?.enabledToolNames
            : CHAT_READONLY_TOOL_NAMES
          : undefined

        const mcpManager = await getMcpManager()
        const onRunnerMessages = (responseMessages: ChatMessage[]) => {
          const now = getNowMs()
          const nextVisibleTextLength =
            getAssistantVisibleTextLength(responseMessages)
          const previousSnapshot = lastObservedRunnerSnapshotRef.current
          const textDelta = nextVisibleTextLength - previousSnapshot.textLength
          const timeDelta = now - previousSnapshot.at

          if (textDelta > 0 && timeDelta > 0) {
            const instantaneousCharsPerSecond = (textDelta * 1000) / timeDelta
            smoothedCharsPerSecondRef.current =
              smoothedCharsPerSecondRef.current
                ? smoothedCharsPerSecondRef.current * 0.65 +
                  instantaneousCharsPerSecond * 0.35
                : instantaneousCharsPerSecond
          }

          lastObservedRunnerSnapshotRef.current = {
            at: now,
            textLength: nextVisibleTextLength,
          }
          pendingRunnerMessagesRef.current = responseMessages
          pendingLastUserMessageRef.current = lastMessage
          pendingAbortControllerRef.current = abortController

          const hasStreamingAssistant =
            hasStreamingAssistantMessage(responseMessages)
          const shouldImmediateFlush =
            !hasStreamingAssistant &&
            responseMessages.at(-1)?.role === 'assistant'

          // Coalesce intermediate snapshots to avoid one-frame UI gaps between
          // tool-phase completion and the next assistant streaming shell.
          // Flush terminal assistant snapshots immediately for responsiveness.
          scheduleRunnerMessagesFlush({ immediate: shouldImmediateFlush })
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
            allowedToolNames: effectiveAllowedToolNames,
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
        cancelScheduledRunnerFlush()
        flushPendingRunnerMessages()
        resetStreamSchedulingState()
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
