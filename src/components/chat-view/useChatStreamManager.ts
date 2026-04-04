import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { Notice, TFile } from 'obsidian'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import {
  buildManualCompactionState,
  createConversationCompactionSummary,
} from '../../core/agent/compaction'
import { estimateContinuationRequestContextTokens } from '../../core/agent/requestContextEstimate'
import type {
  AgentConversationRunSummary,
  AgentConversationState,
} from '../../core/agent/service'
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
  ChatToolMessage,
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

type ActiveBranchRun = {
  branchId: string
  branchConversationId: string
  sourceUserMessageId: string
  branchModelId: string
  branchLabel: string
}

const DEFAULT_MAX_AUTO_TOOL_ITERATIONS = 100
const CHAT_SAFE_TOOL_NAMES = [
  getToolName(getLocalFileToolServerName(), 'fs_search'),
  getToolName(getLocalFileToolServerName(), 'fs_read'),
  getToolName(getLocalFileToolServerName(), 'memory_add'),
  getToolName(getLocalFileToolServerName(), 'memory_update'),
  getToolName(getLocalFileToolServerName(), 'memory_delete'),
  getToolName(getLocalFileToolServerName(), 'open_skill'),
]

const intersectToolNames = (
  allowedToolNames: string[],
  modeAllowedToolNames: string[],
): string[] => {
  const modeAllowed = new Set(modeAllowedToolNames)
  return allowedToolNames.filter((toolName) => modeAllowed.has(toolName))
}

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
      requestMessages?: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
      modelIds?: string[]
    }
  >
}

const isRunSummaryActive = (summary: AgentConversationRunSummary): boolean => {
  return summary.isRunning || summary.isWaitingApproval
}

const annotateBranchMessages = (
  messages: ChatMessage[],
  branch: ActiveBranchRun,
): ChatMessage[] => {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        ...message,
        metadata: {
          ...message.metadata,
          sourceUserMessageId: branch.sourceUserMessageId,
          branchId: branch.branchId,
          branchModelId: branch.branchModelId,
          branchLabel: branch.branchLabel,
          branchConversationId: branch.branchConversationId,
        },
      }
    }

    if (message.role === 'tool') {
      const toolMessage: ChatToolMessage = {
        ...message,
        metadata: {
          ...message.metadata,
          sourceUserMessageId: branch.sourceUserMessageId,
          branchId: branch.branchId,
          branchModelId: branch.branchModelId,
          branchLabel: branch.branchLabel,
          branchConversationId: branch.branchConversationId,
        },
      }
      return toolMessage
    }

    return message
  })
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
  const activeBranchRunsRef = useRef<Map<string, ActiveBranchRun>>(new Map())
  const branchStateMapRef = useRef<Map<string, AgentConversationState>>(
    new Map(),
  )
  const branchUnsubscribeMapRef = useRef<Map<string, () => void>>(new Map())
  const baseConversationMessagesRef = useRef<ChatMessage[]>([])
  const baseCompactionStateRef = useRef<ChatConversationCompactionState>(
    compaction ?? [],
  )
  const [currentConversationRunSummary, setCurrentConversationRunSummary] =
    useState<AgentConversationRunSummary>(() =>
      plugin.getAgentService().getConversationRunSummary(currentConversationId),
    )

  const buildVisibleConversationMessages = useCallback(
    (baseMessages: ChatMessage[]): ChatMessage[] => {
      const activeBranches = Array.from(activeBranchRunsRef.current.values())
      if (activeBranches.length === 0) {
        return baseMessages
      }

      const result: ChatMessage[] = []
      for (const message of baseMessages) {
        result.push(message)
        if (message.role !== 'user') {
          continue
        }

        for (const branch of activeBranches) {
          if (branch.sourceUserMessageId !== message.id) {
            continue
          }
          const branchState = branchStateMapRef.current.get(
            branch.branchConversationId,
          )
          if (!branchState) {
            continue
          }
          const anchorIndex = branchState.messages.findIndex(
            (candidate) => candidate.id === branch.sourceUserMessageId,
          )
          const responseMessages =
            anchorIndex >= 0
              ? branchState.messages.slice(anchorIndex + 1)
              : branchState.messages
          result.push(...annotateBranchMessages(responseMessages, branch))
        }
      }

      return result
    },
    [],
  )

  const syncVisibleConversationState = useCallback(
    (baseMessages?: ChatMessage[]) => {
      const resolvedBaseMessages =
        baseMessages ?? baseConversationMessagesRef.current
      const visibleMessages =
        buildVisibleConversationMessages(resolvedBaseMessages)
      setChatMessages(visibleMessages)

      const branchSummaries = Array.from(
        activeBranchRunsRef.current.values(),
      ).map((branch) => {
        const state = branchStateMapRef.current.get(branch.branchConversationId)
        return state ? buildRunSummary(state) : null
      })
      const activeSummaries = branchSummaries.filter(
        (summary): summary is AgentConversationRunSummary =>
          summary !== null && isRunSummaryActive(summary),
      )
      if (activeSummaries.length > 0) {
        const hasWaitingApproval = activeSummaries.some(
          (summary) => summary.isWaitingApproval,
        )
        setCurrentConversationRunSummary({
          conversationId: currentConversationId,
          status: hasWaitingApproval ? 'running' : 'running',
          isRunning: activeSummaries.some((summary) => summary.isRunning),
          isWaitingApproval: hasWaitingApproval,
        })
      }
    },
    [buildVisibleConversationMessages, currentConversationId, setChatMessages],
  )

  const clearBranchRunTracking = useCallback(() => {
    branchUnsubscribeMapRef.current.forEach((unsubscribe) => {
      unsubscribe()
    })
    branchUnsubscribeMapRef.current.clear()
    branchStateMapRef.current.clear()
    activeBranchRunsRef.current.clear()
  }, [])

  const finalizeBranchRunsIfSettled = useCallback(() => {
    if (activeBranchRunsRef.current.size === 0) {
      return
    }

    const branchSummaries = Array.from(
      activeBranchRunsRef.current.values(),
    ).map((branch) => {
      const state = branchStateMapRef.current.get(branch.branchConversationId)
      return state ? buildRunSummary(state) : null
    })
    if (
      branchSummaries.some(
        (summary) => summary !== null && isRunSummaryActive(summary),
      )
    ) {
      syncVisibleConversationState()
      return
    }

    const mergedMessages = buildVisibleConversationMessages(
      baseConversationMessagesRef.current,
    )
    clearBranchRunTracking()
    plugin
      .getAgentService()
      .replaceConversationMessages(
        currentConversationId,
        mergedMessages,
        baseCompactionStateRef.current,
        { persistState: true },
      )
    setCurrentConversationRunSummary(
      plugin.getAgentService().getConversationRunSummary(currentConversationId),
    )
  }, [
    buildVisibleConversationMessages,
    clearBranchRunTracking,
    currentConversationId,
    plugin,
    syncVisibleConversationState,
  ])

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
      baseConversationMessagesRef.current = state.messages
      baseCompactionStateRef.current = state.compaction ?? []
      const runSummary = buildRunSummary(state)
      const hasTrackedState =
        state.messages.length > 0 || state.status !== 'idle'
      if (!hasTrackedState) {
        return
      }

      if (activeBranchRunsRef.current.size === 0) {
        setCurrentConversationRunSummary(runSummary)
      }
      syncVisibleConversationState(state.messages)
      setCompactionState(state.compaction ?? [])
      setPendingCompactionAnchorMessageId(
        state.pendingCompactionAnchorMessageId ?? null,
      )
      if (
        !(state.status === 'running' || runSummary.isWaitingApproval) &&
        activeBranchRunsRef.current.size === 0
      ) {
        return
      }

      if (
        buildVisibleConversationMessages(state.messages).length > 0 &&
        !buildVisibleConversationMessages(state.messages).some(
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
    setCompactionState,
    setPendingCompactionAnchorMessageId,
    buildVisibleConversationMessages,
    syncVisibleConversationState,
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
      const assistantEnabledToolNames =
        getEnabledAssistantToolNames(selectedAssistant)
      const effectiveEnableTools = selectedAssistant?.enableTools ?? true
      const effectiveIncludeBuiltinTools = effectiveEnableTools
        ? (selectedAssistant?.includeBuiltinTools ?? true)
        : false
      const effectiveAllowedToolNames = effectiveEnableTools
        ? chatMode === 'agent'
          ? assistantEnabledToolNames
          : intersectToolNames(assistantEnabledToolNames, CHAT_SAFE_TOOL_NAMES)
        : undefined
      const assistantMaxContextMessages =
        chatMode === 'agent' ? selectedAssistant?.maxContextMessages : undefined
      const resolvedCompactionClient = resolveCompactionClient()
      const summary = await createConversationCompactionSummary({
        providerClient: resolvedCompactionClient.providerClient,
        model: resolvedCompactionClient.model,
        messages,
        retainLatestToolBoundary: false,
      })

      const nextCompaction = buildManualCompactionState({
        messages,
        summary,
        summaryModelId: resolvedCompactionClient.model.id,
      })

      if (!nextCompaction) {
        return null
      }

      try {
        nextCompaction.estimatedNextContextTokens =
          await estimateContinuationRequestContextTokens({
            requestContextBuilder,
            mcpManager: await getMcpManager(),
            model: effectiveModel,
            messages,
            conversationId: currentConversationId,
            compaction: nextCompaction,
            enableTools: effectiveEnableTools,
            includeBuiltinTools: effectiveIncludeBuiltinTools,
            allowedToolNames: effectiveAllowedToolNames,
            allowedSkillIds,
            allowedSkillNames,
            maxContextOverride:
              conversationOverrides?.maxContextMessages ??
              assistantMaxContextMessages ??
              undefined,
            currentFileContextMode: chatMode === 'agent' ? 'summary' : 'full',
            currentFileOverride,
          })
      } catch (error) {
        console.warn(
          '[YOLO][Compact] failed to estimate continuation context tokens',
          error,
        )
      }

      return nextCompaction
    },
    [
      app,
      assistantIdOverride,
      chatMode,
      conversationOverrides?.maxContextMessages,
      currentConversationId,
      currentFileOverride,
      getMcpManager,
      handleAutoPromoteTransportMode,
      modelId,
      requestContextBuilder,
      resolveCompactionClient,
      settings,
    ],
  )

  const submitChatMutation = useMutation({
    mutationFn: async ({
      chatMessages,
      requestMessages,
      conversationId,
      reasoningLevel,
      modelIds,
    }: {
      chatMessages: ChatMessage[]
      requestMessages?: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
      modelIds?: string[]
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
        const targetModelIds =
          modelIds && modelIds.length > 0 ? modelIds : [requestedModelId]

        const resolveClientForModelId = (
          requestedId: string,
        ): ReturnType<typeof getChatModelClient> => {
          try {
            return getChatModelClient({
              settings,
              modelId: requestedId,
              onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
            })
          } catch (error) {
            if (
              error instanceof LLMModelNotFoundException &&
              settings.chatModels.length > 0
            ) {
              return getChatModelClient({
                settings,
                modelId: settings.chatModels[0].id,
                onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
              })
            }
            throw error
          }
        }

        const resolvedClient = resolveClientForModelId(targetModelIds[0])

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

        const assistantEnabledToolNames =
          getEnabledAssistantToolNames(selectedAssistant)
        const effectiveEnableTools = selectedAssistant?.enableTools ?? true
        const effectiveIncludeBuiltinTools = effectiveEnableTools
          ? (selectedAssistant?.includeBuiltinTools ?? true)
          : false
        const effectiveAllowedToolNames = effectiveEnableTools
          ? chatMode === 'agent'
            ? assistantEnabledToolNames
            : intersectToolNames(
                assistantEnabledToolNames,
                CHAT_SAFE_TOOL_NAMES,
              )
          : undefined

        const mcpManager = await getMcpManager()

        const loopConfig = {
          enableTools: effectiveEnableTools,
          maxAutoIterations: DEFAULT_MAX_AUTO_TOOL_ITERATIONS,
          includeBuiltinTools: effectiveIncludeBuiltinTools,
        }
        const requestParams = {
          stream: shouldStreamResponse,
          temperature:
            conversationOverrides?.temperature ??
            assistantTemperature ??
            modelTemperature,
          top_p: conversationOverrides?.top_p ?? assistantTopP ?? modelTopP,
          max_tokens: assistantMaxTokens ?? modelMaxTokens,
          primaryRequestTimeoutMs:
            settings.continuationOptions.primaryRequestTimeoutMs,
          streamFallbackRecoveryEnabled:
            settings.continuationOptions.streamFallbackRecoveryEnabled,
        }
        const maxContextOverride =
          conversationOverrides?.maxContextMessages ??
          assistantMaxContextMessages ??
          undefined
        const currentFileContextMode: 'full' | 'summary' =
          chatMode === 'agent' ? 'summary' : 'full'
        const baseInput = {
          messages: chatMessages,
          requestContextBuilder,
          mcpManager,
          compaction,
          compactionProviderClient: resolvedCompactionClient.providerClient,
          compactionModel: resolvedCompactionClient.model,
          reasoningLevel,
          allowedToolNames: effectiveAllowedToolNames,
          toolPreferences:
            chatMode === 'agent'
              ? selectedAssistant?.toolPreferences
              : undefined,
          allowedSkillIds,
          allowedSkillNames,
          requestParams,
          maxContextOverride,
          currentFileContextMode,
          currentFileOverride,
          geminiTools: {
            useWebSearch: conversationOverrides?.useWebSearch ?? false,
            useUrlContext: conversationOverrides?.useUrlContext ?? false,
          },
        }

        if (targetModelIds.length <= 1 || lastMessage.role !== 'user') {
          await plugin.getAgentService().run({
            conversationId,
            loopConfig,
            input: {
              ...baseInput,
              requestMessages,
              providerClient: resolvedClient.providerClient,
              model: effectiveModel,
              conversationId,
              abortSignal: abortController.signal,
            },
          })
        } else {
          baseConversationMessagesRef.current = chatMessages
          plugin
            .getAgentService()
            .replaceConversationMessages(
              conversationId,
              chatMessages,
              baseCompactionStateRef.current,
              { persistState: true },
            )

          const runPromises = targetModelIds.map(async (targetModelId) => {
            const branchResolvedClient = resolveClientForModelId(targetModelId)
            const branchProvider = settings.providers.find(
              (provider) =>
                provider.id === branchResolvedClient.model.providerId,
            )
            const branchShouldStream = shouldUseStreamingForProvider({
              requestedStream: conversationOverrides?.stream ?? true,
              provider: branchProvider,
            })
            const branchAbortController = new AbortController()
            const branchModel =
              chatMode === 'agent' && selectedAssistant
                ? {
                    ...branchResolvedClient.model,
                    customParameters: mergeCustomParameters(
                      branchResolvedClient.model.customParameters,
                      selectedAssistant.customParameters,
                    ),
                  }
                : branchResolvedClient.model
            const branchLabel =
              branchModel.name?.trim() || branchModel.model || branchModel.id
            const branchId = `${lastMessage.id}:${branchModel.id}`

            await plugin.getAgentService().run({
              conversationId,
              persistState: true,
              loopConfig,
              input: {
                ...baseInput,
                requestMessages,
                providerClient: branchResolvedClient.providerClient,
                model: branchModel,
                conversationId,
                branchId,
                sourceUserMessageId: lastMessage.id,
                branchLabel,
                abortSignal: branchAbortController.signal,
                requestParams: {
                  ...requestParams,
                  stream: branchShouldStream,
                  temperature:
                    conversationOverrides?.temperature ??
                    assistantTemperature ??
                    branchResolvedClient.model.temperature,
                  top_p:
                    conversationOverrides?.top_p ??
                    assistantTopP ??
                    branchResolvedClient.model.topP,
                  max_tokens:
                    assistantMaxTokens ??
                    branchResolvedClient.model.maxOutputTokens,
                },
              },
            })
          })

          await Promise.allSettled(runPromises)
        }

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
