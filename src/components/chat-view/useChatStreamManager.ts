import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { TFile } from 'obsidian'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import { resolveAssistantIncludeCurrentFileContent } from '../../core/agent/assistant-capabilities'
import { DEFAULT_BLOCKED_PREFIXES } from '../../core/agent/bash/command-classifier'
import {
  CONTEXT_COMPACT_TOOL_NAME,
  buildManualCompactionState,
  createConversationCompactionSummary,
  getLastAssistantPromptTokens,
  resolveAutoContextCompactionChatOptions,
} from '../../core/agent/compaction'
import { estimateContinuationRequestContextTokens } from '../../core/agent/requestContextEstimate'
import {
  type AgentConversationRunSummary,
  type AgentConversationState,
  buildAgentConversationRunSummary,
} from '../../core/agent/service'
import { getEnabledAssistantToolNames } from '../../core/agent/tool-preferences'
import { selectAllowedTools } from '../../core/agent/tool-selection'
import type { AgentRuntimeRunInput } from '../../core/agent/types'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
  LLMModelNotFoundException,
} from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import type { AutoPromotedTransportMode } from '../../core/llm/requestTransport'
import { shouldUseStreamingForProvider } from '../../core/llm/streamingPolicy'
import { promoteProviderTransportModeToObsidian } from '../../core/llm/transportModePromotion'
import {
  TERMINAL_COMMAND_TOOL_NAME,
  getLocalFileToolServerName,
} from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import { listLiteSkillEntries } from '../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../core/skills/skillPolicy'
import type { AssistantToolPreference } from '../../types/assistant.types'
import {
  ChatConversationCompaction,
  ChatConversationCompactionState,
  ChatMessage,
  ChatToolMessage,
} from '../../types/chat'
import { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import {
  ReasoningLevel,
  normalizeStoredReasoningLevel,
  resolveRequestReasoningLevel,
} from '../../types/reasoning'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { resolveEffectiveMaxContextTokens } from '../../utils/llm/model-capability-registry'
import { ErrorModal } from '../modals/ErrorModal'

import { ChatMode } from './chat-input/ChatModeSelect'
import { resolveWorkspaceScopeForRuntimeInput } from './chat-runtime-inputs'
import {
  type ChatModeRuntime,
  resolveChatModeRuntime,
} from './chat-runtime-profiles'
import type { ContextBreakdownInputs } from './useContextBreakdown'

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

const AUTO_CONTEXT_COMPACT_TOOL_FQN = getToolName(
  getLocalFileToolServerName(),
  CONTEXT_COMPACT_TOOL_NAME,
)

const AUTO_CONTEXT_COMPACT_TOOL_PREFERENCE: AssistantToolPreference = {
  enabled: true,
  approvalMode: 'full_access',
  disclosureMode: 'always',
}

const enableAutoContextCompactionTool = (
  runtime: ChatModeRuntime,
  enabled: boolean,
): ChatModeRuntime => {
  if (!enabled) {
    return runtime
  }

  const allowedToolNames =
    runtime.allowedToolNames === undefined && runtime.loopConfig.enableTools
      ? undefined
      : [
          ...new Set([
            ...(runtime.allowedToolNames ?? []),
            AUTO_CONTEXT_COMPACT_TOOL_FQN,
          ]),
        ]

  return {
    ...runtime,
    loopConfig: {
      ...runtime.loopConfig,
      enableTools: true,
      includeBuiltinTools: true,
    },
    allowedToolNames,
    toolPreferences: {
      ...(runtime.toolPreferences ?? {}),
      [AUTO_CONTEXT_COMPACT_TOOL_FQN]: {
        ...(runtime.toolPreferences?.[AUTO_CONTEXT_COMPACT_TOOL_FQN] ?? {}),
        ...AUTO_CONTEXT_COMPACT_TOOL_PREFERENCE,
      },
    },
  }
}

export type UseChatStreamManager = {
  abortConversationRun: (conversationId: string) => void
  compactConversation: (
    messages: ChatMessage[],
  ) => Promise<ChatConversationCompaction | null>
  currentConversationRunSummary: AgentConversationRunSummary
  buildContextBreakdownInputs: (
    messages: ChatMessage[],
  ) => Promise<ContextBreakdownInputs | null>
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
  return summary.isActive
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
  const branchRunSummary = buildAgentConversationRunSummary(branchState)

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
        return state ? buildAgentConversationRunSummary(state) : null
      })
      const activeSummaries = branchSummaries.filter(
        (summary): summary is AgentConversationRunSummary =>
          summary !== null && isRunSummaryActive(summary),
      )
      if (activeSummaries.length > 0) {
        const hasWaitingApproval = activeSummaries.some(
          (summary) => summary.isWaitingApproval,
        )
        const hasWaitingUserInput = activeSummaries.some(
          (summary) => summary.isWaitingUserInput,
        )
        setCurrentConversationRunSummary({
          conversationId: currentConversationId,
          status: 'running',
          isRunning: activeSummaries.some((summary) => summary.isRunning),
          isActive: true,
          isAbortable: activeSummaries.some((summary) => summary.isAbortable),
          isQueueable: activeSummaries.some((summary) => summary.isQueueable),
          isWaitingApproval: hasWaitingApproval,
          isWaitingUserInput: hasWaitingUserInput,
        })
      }
    },
    [buildVisibleConversationMessages, currentConversationId, setChatMessages],
  )

  const handleAutoPromoteTransportMode = useCallback(
    (providerId: string, mode: AutoPromotedTransportMode) => {
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
      const runSummary = buildAgentConversationRunSummary(state)
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
      if (!runSummary.isActive && activeBranchRunsRef.current.size === 0) {
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

    // Reset summary on conversation switch — syncConversationState below
    // bails out early for fresh/idle conversations and would otherwise leave
    // stale flags (e.g. isWaitingUserInput) from the previous conversation
    // bleeding into the new one's input-box guards.
    setCurrentConversationRunSummary(
      agentService.getConversationRunSummary(currentConversationId),
    )

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
      const autoContextCompactionOptions =
        resolveAutoContextCompactionChatOptions(settings.chatOptions)
      const chatModeRuntime = enableAutoContextCompactionTool(
        resolveChatModeRuntime({
          mode: chatMode,
          assistant: selectedAssistant,
          assistantEnabledToolNames:
            getEnabledAssistantToolNames(selectedAssistant),
        }),
        autoContextCompactionOptions.autoContextCompactionEnabled,
      )
      const effectiveEnableTools = chatModeRuntime.loopConfig.enableTools
      const effectiveIncludeBuiltinTools =
        chatModeRuntime.loopConfig.includeBuiltinTools
      const effectiveAllowedToolNames = chatModeRuntime.allowedToolNames
      const manualProvider = settings.providers.find(
        (provider) => provider.id === effectiveModel.providerId,
      )
      const manualApiType = manualProvider?.apiType ?? null
      const manualContextualInjections = buildChatContextualInjections({
        includeCurrentFileContent: resolveAssistantIncludeCurrentFileContent(
          selectedAssistant,
          settings,
        ),
        currentFile: currentFileOverride,
        currentFileViewState,
      })
      const manualCompaction = baseCompactionStateRef.current
      // Paths 2/3 mirror the main line: reasoning comes from the last user
      // message's stored level (same source as resolveReasoningLevelForMessages
      // in Chat.tsx). This keeps the compaction request's thinking config
      // aligned with the prior turn so the cache-warm prefix still matches.
      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === 'user')
      const manualReasoning = resolveRequestReasoningLevel(
        effectiveModel,
        lastUserMessage?.role === 'user'
          ? (normalizeStoredReasoningLevel(lastUserMessage.reasoningLevel) ??
              undefined)
          : undefined,
      )

      // Path 2/3: rebuild a cache-warm prefix + tools that match what the main
      // line just sent, so the out-of-band summarize request can hit the
      // provider's prefix cache (same model, same serialized prefix, same tools).
      const mcpManager = await getMcpManager()
      const availableTools = effectiveEnableTools
        ? await mcpManager.listAvailableTools({
            includeBuiltinTools: effectiveIncludeBuiltinTools,
            chatModelModalities: effectiveModel.modalities,
          })
        : []
      const { hasTools, hasMemoryTools, requestTools } = selectAllowedTools({
        availableTools,
        allowedToolNames: effectiveAllowedToolNames,
        toolPreferences: chatModeRuntime.toolPreferences,
        apiType: manualApiType,
        enableToolDisclosure: settings.mcp.enableToolDisclosure,
        jsSandboxSettings: mcpManager.getJsSandboxSettings(),
      })
      const compactionPrefix =
        await requestContextBuilder.generateRequestMessages({
          messages,
          hasTools,
          hasMemoryTools,
          model: effectiveModel,
          conversationId: currentConversationId,
          compaction: manualCompaction,
          contextualInjections: manualContextualInjections,
          runtimeModePrompt: chatModeRuntime.runtimeModePrompt,
          // Reuse the frozen snapshot; never create one outside the real request.
          systemPromptSnapshotMode: 'reuse',
        })

      const summary = await createConversationCompactionSummary({
        providerClient: resolvedClient.providerClient,
        model: effectiveModel,
        requestMessages: compactionPrefix,
        tools: requestTools,
        reasoningLevel: manualReasoning,
      })

      const nextCompaction = await buildManualCompactionState({
        messages,
        summary,
        summaryModelId: effectiveModel.id,
      })

      if (!nextCompaction) {
        return null
      }

      try {
        nextCompaction.estimatedNextContextTokens =
          await estimateContinuationRequestContextTokens({
            requestContextBuilder,
            mcpManager,
            model: effectiveModel,
            messages,
            conversationId: currentConversationId,
            compaction: nextCompaction,
            enableTools: effectiveEnableTools,
            includeBuiltinTools: effectiveIncludeBuiltinTools,
            apiType: manualApiType,
            allowedToolNames: effectiveAllowedToolNames,
            enableToolDisclosure: settings.mcp.enableToolDisclosure,
            toolPreferences: chatModeRuntime.toolPreferences,
            runtimeModePrompt: chatModeRuntime.runtimeModePrompt,
            contextualInjections: manualContextualInjections,
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
      currentConversationId,
      currentFileOverride,
      currentFileViewState,
      getMcpManager,
      handleAutoPromoteTransportMode,
      modelId,
      requestContextBuilder,
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
      const lastMessage = chatMessages.at(-1)
      if (!lastMessage) {
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
        const shouldStreamResponse = shouldUseStreamingForProvider({
          requestedStream: conversationOverrides?.stream ?? true,
          provider: currentProvider,
        })

        const modelTemperature = resolvedClient.model.temperature
        const modelTopP = resolvedClient.model.topP
        const modelMaxTokens = resolvedClient.model.maxOutputTokens
        const effectiveModel = resolvedClient.model
        const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
        const enabledSkillEntries = selectedAssistant
          ? (await listLiteSkillEntries(app, { settings })).filter((skill) =>
              isSkillEnabledForAssistant({
                assistant: selectedAssistant,
                skillName: skill.name,
                disabledSkillNames,
              }),
            )
          : []
        const allowedSkillPaths = enabledSkillEntries.map((skill) => skill.path)

        const autoContextCompactionOptions =
          resolveAutoContextCompactionChatOptions(settings.chatOptions)
        const chatModeRuntime = enableAutoContextCompactionTool(
          resolveChatModeRuntime({
            mode: chatMode,
            assistant: selectedAssistant,
            assistantEnabledToolNames:
              getEnabledAssistantToolNames(selectedAssistant),
          }),
          autoContextCompactionOptions.autoContextCompactionEnabled,
        )

        const mcpManager = await getMcpManager()

        const loopConfig = chatModeRuntime.loopConfig
        const buildAutoContextCompactionInput = (
          model: AgentRuntimeRunInput['model'],
        ): AgentRuntimeRunInput['autoContextCompaction'] =>
          autoContextCompactionOptions.autoContextCompactionEnabled
            ? {
                chatOptions: autoContextCompactionOptions,
                maxContextTokens: resolveEffectiveMaxContextTokens(model),
              }
            : undefined
        const requestParams = {
          stream: shouldStreamResponse,
          temperature: conversationOverrides?.temperature ?? modelTemperature,
          top_p: conversationOverrides?.top_p ?? modelTopP,
          max_tokens: modelMaxTokens,
          primaryRequestTimeoutMs:
            settings.continuationOptions.primaryRequestTimeoutMs,
          streamFallbackRecoveryEnabled:
            settings.continuationOptions.streamFallbackRecoveryEnabled,
        }
        const effectiveCompactionForRequest = compactionOverride ?? compaction
        const baseInput = {
          messages: chatMessages,
          assistantId: selectedAssistant?.id,
          requestContextBuilder,
          mcpManager,
          compaction: effectiveCompactionForRequest,
          apiType: currentProvider?.apiType ?? null,
          reasoningLevel,
          allowedToolNames: chatModeRuntime.allowedToolNames,
          enableToolDisclosure: settings.mcp.enableToolDisclosure,
          toolPreferences: chatModeRuntime.toolPreferences,
          runtimeModePrompt: chatModeRuntime.runtimeModePrompt,
          bypassToolApproval: chatModeRuntime.bypassToolApproval,
          blockedCommandPrefixes: settings.mcp.builtinToolOptions[
            TERMINAL_COMMAND_TOOL_NAME
          ]?.blockedPrefixes ?? [...DEFAULT_BLOCKED_PREFIXES],
          workspaceScope:
            resolveWorkspaceScopeForRuntimeInput(selectedAssistant),
          allowedSkillPaths,
          requestParams,
          contextualInjections: buildChatContextualInjections({
            includeCurrentFileContent:
              resolveAssistantIncludeCurrentFileContent(
                selectedAssistant,
                settings,
              ),
            currentFile: currentFileOverride,
            currentFileViewState,
          }),
          geminiTools: {
            useWebSearch: conversationOverrides?.useWebSearch ?? false,
            useUrlContext: conversationOverrides?.useUrlContext ?? false,
          },
        }

        if (branchTarget && requestLastMessage?.role === 'user') {
          const branchRunMessages = requestMessages ?? chatMessages
          baseConversationMessagesRef.current = chatMessages
          plugin
            .getAgentService()
            .replaceConversationMessages(
              conversationId,
              chatMessages,
              effectiveCompactionForRequest,
              { persistState: true },
            )

          await plugin.getAgentService().run({
            conversationId,
            persistState: true,
            loopConfig,
            input: {
              ...baseInput,
              messages: branchRunMessages,
              requestMessages,
              providerClient: resolvedClient.providerClient,
              model: effectiveModel,
              conversationId,
              autoContextCompaction:
                buildAutoContextCompactionInput(effectiveModel),
              branchId: branchTarget.branchId,
              sourceUserMessageId: branchTarget.sourceUserMessageId,
              branchLabel:
                branchTarget.branchLabel ??
                effectiveModel.name ??
                effectiveModel.model ??
                effectiveModel.id,
              abortSignal: abortController.signal,
            },
          })
        } else if (
          targetModelIds.length <= 1 ||
          requestLastMessage?.role !== 'user'
        ) {
          await plugin.getAgentService().run({
            conversationId,
            loopConfig,
            input: {
              ...baseInput,
              requestMessages,
              providerClient: resolvedClient.providerClient,
              model: effectiveModel,
              conversationId,
              autoContextCompaction:
                buildAutoContextCompactionInput(effectiveModel),
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
            const branchModel = branchResolvedClient.model
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
                apiType: branchProvider?.apiType ?? null,
                conversationId,
                autoContextCompaction:
                  buildAutoContextCompactionInput(branchModel),
                branchId,
                sourceUserMessageId: lastMessage.id,
                branchLabel,
                abortSignal: branchAbortController.signal,
                requestParams: {
                  ...requestParams,
                  stream: branchShouldStream,
                  temperature:
                    conversationOverrides?.temperature ??
                    branchResolvedClient.model.temperature,
                  top_p:
                    conversationOverrides?.top_p ??
                    branchResolvedClient.model.topP,
                  max_tokens: branchResolvedClient.model.maxOutputTokens,
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
        console.error('Failed to generate response', error)
      }
    },
  })

  /**
   * Build the input bag for the per-bucket context-breakdown estimator. Mirrors
   * the resolution done in `compactConversation` / submit so the popover sees
   * exactly what the next request would send. Returns null if no model can be
   * resolved or no messages exist (popover surfaces this as an error state).
   */
  const buildContextBreakdownInputs = useCallback(
    async (messages: ChatMessage[]): Promise<ContextBreakdownInputs | null> => {
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
          return null
        }
      }

      const effectiveModel = resolvedClient.model
      const chatModeRuntime = resolveChatModeRuntime({
        mode: chatMode,
        assistant: selectedAssistant,
        assistantEnabledToolNames:
          getEnabledAssistantToolNames(selectedAssistant),
      })
      const provider = settings.providers.find(
        (p) => p.id === effectiveModel.providerId,
      )

      const mcpManager = await getMcpManager()
      return {
        requestContextBuilder,
        mcpManager,
        model: effectiveModel,
        messages,
        conversationId: currentConversationId ?? '',
        compaction,
        enableTools: chatModeRuntime.loopConfig.enableTools,
        includeBuiltinTools: chatModeRuntime.loopConfig.includeBuiltinTools,
        apiType: provider?.apiType ?? null,
        allowedToolNames: chatModeRuntime.allowedToolNames,
        enableToolDisclosure: settings.mcp.enableToolDisclosure,
        toolPreferences: chatModeRuntime.toolPreferences,
        runtimeModePrompt: chatModeRuntime.runtimeModePrompt,
        contextualInjections: buildChatContextualInjections({
          includeCurrentFileContent: resolveAssistantIncludeCurrentFileContent(
            selectedAssistant,
            settings,
          ),
          currentFile: currentFileOverride,
          currentFileViewState,
        }),
      }
    },
    [
      app,
      assistantIdOverride,
      chatMode,
      compaction,
      currentConversationId,
      currentFileOverride,
      currentFileViewState,
      getMcpManager,
      handleAutoPromoteTransportMode,
      modelId,
      requestContextBuilder,
      settings,
    ],
  )

  return {
    abortConversationRun,
    currentConversationRunSummary,
    compactConversation,
    submitChatMutation,
    buildContextBreakdownInputs,
  }
}
