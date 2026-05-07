import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { TFile } from '../../runtime/react-compat'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import {
  buildManualCompactionState,
  createConversationCompactionSummary,
  getLastAssistantPromptTokens,
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
import { promoteProviderTransportModeToObsidian } from '../../core/llm/transportModePromotion'
import { listLiteSkillEntries } from '../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../core/skills/skillPolicy'
import {
  ChatConversationCompaction,
  ChatConversationCompactionState,
  ChatMessage,
  ChatToolMessage,
} from '../../types/chat'
import { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import { ReasoningLevel } from '../../types/reasoning'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { useYoloRuntime } from '../../runtime'
import { ErrorModal } from '../modals/ErrorModal'

import { ChatMode } from './chat-input/ChatModeSelect'
import { resolveChatModeRuntime } from './chat-runtime-profiles'

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
  currentFileViewState?: import('../../types/mentionable').CurrentFileViewState
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

type BranchRetryTarget = {
  branchId: string
  sourceUserMessageId: string
  branchModelId?: string
  branchLabel?: string
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
      branchTarget?: BranchRetryTarget
      compactionOverride?: ChatConversationCompactionState
    }
  >
}

const isRunSummaryActive = (summary: AgentConversationRunSummary): boolean => {
  return summary.isRunning || summary.isWaitingApproval
}

/**
 * Sidebar Chat focus sync → current-file-pointer injection.
 * Returns an empty array when the user has disabled focus sync or no file
 * is active.
 */
const buildChatContextualInjections = ({
  includeCurrentFileContent,
  currentFile,
  currentFileViewState,
}: {
  includeCurrentFileContent: boolean
  currentFile: TFile | null | undefined
  currentFileViewState?: import('../../types/mentionable').CurrentFileViewState
}): ContextualInjection[] => {
  if (!includeCurrentFileContent || !currentFile) {
    return []
  }
  return [
    {
      type: 'current-file-pointer',
      file: currentFile,
      viewState: currentFileViewState,
    },
  ]
}

const annotateBranchMessages = (
  messages: ChatMessage[],
  branch: ActiveBranchRun,
  branchState: AgentConversationState,
): ChatMessage[] => {
  const branchRunSummary = buildRunSummary(branchState)

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
          branchRunStatus: branchState.status,
          branchWaitingApproval: branchRunSummary.isWaitingApproval,
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
          branchRunStatus: branchState.status,
          branchWaitingApproval: branchRunSummary.isWaitingApproval,
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
  currentFileViewState,
  assistantIdOverride,
  compaction,
  onRunSettled,
}: UseChatStreamManagerParams): UseChatStreamManager {
  const runtime = useYoloRuntime()
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
          result.push(
            ...annotateBranchMessages(responseMessages, branch, branchState),
          )
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

      const visibleMessages = buildVisibleConversationMessages(state.messages)
      if (
        visibleMessages.length > 0 &&
        !visibleMessages.some(
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

      const effectiveModel = resolvedClient.model
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
      const chatModeRuntime = resolveChatModeRuntime({
        mode: chatMode,
        assistant: selectedAssistant,
        assistantEnabledToolNames:
          getEnabledAssistantToolNames(selectedAssistant),
      })
      const effectiveEnableTools = chatModeRuntime.loopConfig.enableTools
      const effectiveIncludeBuiltinTools =
        chatModeRuntime.loopConfig.includeBuiltinTools
      const effectiveAllowedToolNames = chatModeRuntime.allowedToolNames
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
              conversationOverrides?.maxContextMessages ?? undefined,
            contextualInjections: buildChatContextualInjections({
              includeCurrentFileContent:
                settings.chatOptions.includeCurrentFileContent,
              currentFile: currentFileOverride,
              currentFileViewState,
            }),
          })
      } catch (error) {
        console.warn(
          '[YOLO][Compact] failed to estimate continuation context tokens',
          error,
        )
      }

      const preCompactionTokens = getLastAssistantPromptTokens(messages)
      if (
        typeof preCompactionTokens === 'number' &&
        typeof nextCompaction.estimatedNextContextTokens === 'number'
      ) {
        const saved =
          preCompactionTokens - nextCompaction.estimatedNextContextTokens
        if (saved > 0) {
          nextCompaction.estimatedTokensSaved = saved
        }
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
      currentFileViewState,
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
      branchTarget,
      compactionOverride,
    }: {
      chatMessages: ChatMessage[]
      requestMessages?: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
      modelIds?: string[]
      branchTarget?: BranchRetryTarget
      compactionOverride?: ChatConversationCompactionState
    }) => {
      if (chatMessages.length === 0) {
        return {
          aborted: false,
        }
      }
      const requestLastMessage = (requestMessages ?? chatMessages).at(-1)

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
        const targetModelIds = branchTarget?.branchModelId?.trim()
          ? [branchTarget.branchModelId]
          : modelIds && modelIds.length > 0
            ? modelIds
            : [requestedModelId]
        baseConversationMessagesRef.current = chatMessages
        baseCompactionStateRef.current =
          (compactionOverride ?? compaction) ?? []

        await runtime.agent.run({
          conversationId,
          messages: chatMessages,
          requestMessages,
          conversationMessages: chatMessages,
          compaction: compactionOverride ?? compaction,
          modelId:
            branchTarget?.branchModelId?.trim() || targetModelIds[0],
          modelIds:
            branchTarget || requestLastMessage?.role !== 'user'
              ? undefined
              : targetModelIds,
          assistantId: effectiveAssistantId,
          reasoningLevel,
          branchTarget: branchTarget
            ? {
                branchId: branchTarget.branchId,
                sourceUserMessageId: branchTarget.sourceUserMessageId,
                branchLabel: branchTarget.branchLabel,
              }
            : undefined,
          overrides: {
            ...(conversationOverrides ?? {}),
            chatMode,
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
