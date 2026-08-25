import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { Platform, TFile } from 'obsidian'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'

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
import { buildToolCapabilityPrompt } from '../../core/agent/tool-capability-prompt'
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
import type { ResponseDeliveryMode } from '../../core/llm/responseDeliveryMode'
import { promoteProviderTransportModeToObsidian } from '../../core/llm/transportModePromotion'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import { listLiteSkillEntries } from '../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../core/skills/skillPolicy'
import { useChatManager } from '../../hooks/useJsonManagers'
import type { AssistantToolPreference } from '../../types/assistant.types'
import {
  ChatConversationCompaction,
  ChatConversationCompactionState,
  ChatMessage,
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
import {
  providerOwnsConversationContext,
  resolveChatModelProvider,
} from '../../utils/llm/provider-config'
import { ErrorModal } from '../modals/ErrorModal'

import { ChatMode, isModuleChatMode } from './chat-input/ChatModeSelect'
import { resolveWorkspaceScopeForRuntimeInput } from './chat-runtime-inputs'
import {
  type ChatModeRuntime,
  resolveChatModeRuntime,
  resolveNativeToolPolicy,
} from './chat-runtime-profiles'
import {
  createProviderSessionAccessor,
  resolveTurnIdentity,
} from './providerSessionAccessor'
import { useAgentConversationState } from './useAgentConversationState'
import type { ContextBreakdownInputs } from './useContextBreakdown'

type UseChatStreamManagerParams = {
  autoScrollToBottom: () => void
  requestContextBuilder: RequestContextBuilder
  currentConversationId: string
  cancelRuntimeRun: (conversationId: string) => void
  conversationOverrides?: ConversationOverrideSettings
  modelId: string
  chatMode: ChatMode
  yoloEnabled: boolean
  currentFileOverride?: TFile | null
  currentFileViewState?: import('../../types/mentionable').CurrentFileViewState
  assistantIdOverride?: string
  compaction?: ChatConversationCompactionState
  onRunSettled?: (result: { aborted: boolean; failed: boolean }) => void
}

type BranchRetryTarget = {
  branchId: string
  sourceUserMessageId: string
  branchModelId?: string
  branchLabel?: string
}

type AssistantErrorContinuationRunTarget = {
  assistantMessageId: string
  sourceUserMessageId: string
  modelId: string
  branchId?: string
  branchLabel?: string
}

const AUTO_CONTEXT_COMPACT_TOOL_FQN = getToolName(
  getLocalFileToolServerName(),
  CONTEXT_COMPACT_TOOL_NAME,
)

// D9 (docs/plans/2026-08-15-tool-registry/phase2-migration.md D9):
// `context_compact`'s owning capability id — `getCapabilityForTool` isn't
// used here since this constant must survive even if the tool were ever
// renamed independently of its capability; matches the hardcoded id already
// used at the capability's own definition site
// (`core/tools/capabilities/context-compaction.ts`).
const AUTO_CONTEXT_COMPACT_CAPABILITY_ID = 'context_compaction'

const AUTO_CONTEXT_COMPACT_TOOL_PREFERENCE: AssistantToolPreference = {
  enabled: true,
  approvalMode: 'full_access',
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
    // `context_compact` is a built-in tool: its enabled/approval state is
    // resolved from `builtinCapabilityPreferences`, not `toolPreferences`
    // (D9) — forcing it on for auto-compaction must write there instead.
    builtinCapabilityPreferences: {
      ...(runtime.builtinCapabilityPreferences ?? {}),
      [AUTO_CONTEXT_COMPACT_CAPABILITY_ID]: {
        ...(runtime.builtinCapabilityPreferences?.[
          AUTO_CONTEXT_COMPACT_CAPABILITY_ID
        ] ?? {}),
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
      assistantContinuation?: AssistantErrorContinuationRunTarget
      compactionOverride?: ChatConversationCompactionState
    }
  >
}

/**
 * Sidebar Chat contextual injections.
 */
const buildChatContextualInjections = ({
  app,
  includeFocusSync,
  currentFile,
  currentFileViewState,
}: {
  app: import('obsidian').App
  includeFocusSync: boolean
  currentFile: TFile | null | undefined
  currentFileViewState?: import('../../types/mentionable').CurrentFileViewState
}): ContextualInjection[] => {
  const injections: ContextualInjection[] = []

  if (!includeFocusSync) {
    return injections
  }

  if (currentFile) {
    injections.push({
      type: 'current-file-pointer',
      file: currentFile,
      viewState: currentFileViewState,
    })
  }

  if (!Platform.isMobile) {
    injections.push({
      type: 'browser-context',
      app,
    })
  }

  return injections
}

export function useChatStreamManager({
  autoScrollToBottom,
  requestContextBuilder,
  currentConversationId,
  cancelRuntimeRun,
  conversationOverrides,
  modelId,
  chatMode,
  yoloEnabled,
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
  const chatManager = useChatManager()

  const moduleChatModeRegistry = plugin.getModuleChatModeRegistry()
  const moduleChatModeSnapshot = useSyncExternalStore(
    moduleChatModeRegistry.subscribe,
    moduleChatModeRegistry.getSnapshot,
  )
  // `chatMode` here is always an *effective* value (see
  // `resolveEffectiveChatMode` in `useYoloChatSession`) — an unavailable
  // module id never reaches this hook as `'agent'` is substituted upstream.
  // Still guard on a registered+available match so a stale mode id (e.g. a
  // module disabled between render and this lookup) degrades to the
  // built-in branch of `resolveChatModeRuntime` instead of throwing.
  const resolveModuleChatMode = useCallback(() => {
    if (!isModuleChatMode(chatMode)) return undefined
    return moduleChatModeSnapshot.find(
      (entry) =>
        entry.fullModeId === chatMode &&
        entry.availability.status === 'available',
    )
  }, [chatMode, moduleChatModeSnapshot])

  const activeStreamAbortControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  )
  const baseConversationMessagesRef = useRef<ChatMessage[]>([])
  const baseCompactionStateRef = useRef<ChatConversationCompactionState>(
    compaction ?? [],
  )
  // Pure shadow of AgentService's run status for `currentConversationId` — no
  // write path bypasses AgentService for this value (unlike `chatMessages`/
  // `compactionState`/`pendingCompactionAnchorMessageId`, which still have
  // legitimate direct writes elsewhere and stay as-is; see the 2026-08-11
  // architecture-governance audit). Safe to source purely from the
  // subscription instead of a manually-forwarded `useState`.
  const agentConversationState = useAgentConversationState(
    plugin.getAgentService(),
    currentConversationId,
  )
  const currentConversationRunSummary = useMemo(
    () => buildAgentConversationRunSummary(agentConversationState),
    [agentConversationState],
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

      // The `chatMessages`/`compactionState`/`pendingCompactionAnchorMessageId`
      // mirror into React state used to happen here — it's now
      // `ChatSessionController`'s own independent AgentService subscription
      // (see docs/plans/2026-08-11-arch-governance-step3-chat-state-ownership.md,
      // "分期 C1"). This effect keeps its own subscription only for
      // `baseConversationMessagesRef`/`baseCompactionStateRef` (read by
      // `compactConversation`/`submitChatMutation` below) and the
      // auto-scroll trigger.
      if (!runSummary.isActive) {
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
        autoScrollToBottom()
      }
    }

    // `currentConversationRunSummary` no longer needs a reset here: it's
    // sourced from `useAgentConversationState`, which re-derives a fresh
    // snapshot for the new `currentConversationId` synchronously during
    // render (see that hook) — no stale-flag carryover from the previous
    // conversation to guard against.
    syncConversationState(agentService.getState(currentConversationId))

    const unsubscribe = agentService.subscribe(
      currentConversationId,
      syncConversationState,
      { emitCurrent: false },
    )

    return () => {
      unsubscribe()
    }
  }, [autoScrollToBottom, currentConversationId, plugin])

  const abortConversationRun = useCallback(
    (conversationId: string) => {
      activeStreamAbortControllersRef.current.get(conversationId)?.abort()
      activeStreamAbortControllersRef.current.delete(conversationId)
      cancelRuntimeRun(conversationId)
    },
    [cancelRuntimeRun],
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
      // Module chat modes never inherit an assistant's default model —
      // ChatContextPolicy.useAssistant === false cuts the assistant out of
      // model resolution entirely. A user's own in-session model pick
      // (`modelId`) still always wins.
      const requestedModelId =
        modelId ||
        (isModuleChatMode(chatMode) ? undefined : selectedAssistant?.modelId) ||
        settings.chatModelId

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
          yoloEnabled,
          assistant: selectedAssistant,
          assistantEnabledToolNames:
            getEnabledAssistantToolNames(selectedAssistant),
          moduleChatMode: resolveModuleChatMode(),
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
        app,
        includeFocusSync: resolveAssistantIncludeCurrentFileContent(
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
      const {
        filteredTools,
        hasTools,
        hasMemoryTools,
        hasOnDemandTools,
        requestTools,
      } = await selectAllowedTools({
        availableTools,
        allowedToolNames: effectiveAllowedToolNames,
        toolPreferences: chatModeRuntime.toolPreferences,
        toolServerPreferences: chatModeRuntime.toolServerPreferences,
        apiType: manualApiType,
        enableToolDisclosure: settings.mcp.enableToolDisclosure,
        jsSandboxSettings: mcpManager.getJsSandboxSettings(),
        settings,
      })
      const runtimeModePrompt = buildToolCapabilityPrompt({
        mode: chatModeRuntime.toolCapabilityMode,
        toolNames: filteredTools.map((tool) => tool.name),
      })
      const compactionPrefix =
        await requestContextBuilder.generateRequestMessages({
          messages,
          hasTools,
          hasMemoryTools,
          hasOnDemandTools,
          model: effectiveModel,
          conversationId: currentConversationId,
          compaction: manualCompaction,
          contextualInjections: manualContextualInjections,
          runtimeModePrompt,
          modePersonaPrompt: chatModeRuntime.modePersonaPrompt,
          modePersonaModuleId: chatModeRuntime.modePersonaModuleId,
          moduleChatModeId: chatModeRuntime.moduleChatModeId,
          contextPolicy: chatModeRuntime.contextPolicy,
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
            toolServerPreferences: chatModeRuntime.toolServerPreferences,
            toolCapabilityMode: chatModeRuntime.toolCapabilityMode,
            contextualInjections: manualContextualInjections,
            modePersonaPrompt: chatModeRuntime.modePersonaPrompt,
            modePersonaModuleId: chatModeRuntime.modePersonaModuleId,
            moduleChatModeId: chatModeRuntime.moduleChatModeId,
            contextPolicy: chatModeRuntime.contextPolicy,
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
      resolveModuleChatMode,
      yoloEnabled,
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
      assistantContinuation,
      compactionOverride,
    }: {
      chatMessages: ChatMessage[]
      requestMessages?: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
      modelIds?: string[]
      branchTarget?: BranchRetryTarget
      assistantContinuation?: AssistantErrorContinuationRunTarget
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
          modelId ||
          (isModuleChatMode(chatMode)
            ? undefined
            : selectedAssistant?.modelId) ||
          settings.chatModelId
        const targetModelIds = assistantContinuation?.modelId
          ? [assistantContinuation.modelId]
          : branchTarget?.branchModelId?.trim()
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

        const resolvedClient = assistantContinuation
          ? getChatModelClient({
              settings,
              modelId: assistantContinuation.modelId,
              onAutoPromoteTransportMode: handleAutoPromoteTransportMode,
            })
          : resolveClientForModelId(targetModelIds[0])

        const currentProvider = settings.providers.find(
          (provider) => provider.id === resolvedClient.model.providerId,
        )
        const deliveryMode: ResponseDeliveryMode =
          conversationOverrides?.stream === false ? 'buffered' : 'incremental'

        const modelTemperature = resolvedClient.model.temperature
        const modelTopP = resolvedClient.model.topP
        const modelMaxTokens = resolvedClient.model.maxOutputTokens
        const effectiveModel = resolvedClient.model
        const autoContextCompactionOptions =
          resolveAutoContextCompactionChatOptions(settings.chatOptions)
        const chatModeRuntime = enableAutoContextCompactionTool(
          resolveChatModeRuntime({
            mode: chatMode,
            yoloEnabled,
            assistant: selectedAssistant,
            assistantEnabledToolNames:
              getEnabledAssistantToolNames(selectedAssistant),
            moduleChatMode: resolveModuleChatMode(),
          }),
          autoContextCompactionOptions.autoContextCompactionEnabled,
        )

        const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
        // Module chat modes bypass assistant skill preferences entirely
        // (ChatContextPolicy.useAssistant === false): the allowed set is the
        // mode's own declared skills (scoped by `moduleChatModeId`) plus
        // every enabled vault skill. Built-in modes keep the exact prior
        // behavior: no assistant selected means no skills.
        const { turnId, parentTurnId } = resolveTurnIdentity(
          requestMessages ?? chatMessages,
        )
        const isModuleMode = isModuleChatMode(chatMode)
        const skillScope = chatModeRuntime.moduleChatModeId
          ? { moduleChatModeId: chatModeRuntime.moduleChatModeId }
          : undefined
        const enabledSkillEntries =
          isModuleMode || selectedAssistant
            ? (
                await listLiteSkillEntries(app, {
                  settings,
                  scope: skillScope,
                })
              ).filter((skill) =>
                isSkillEnabledForAssistant({
                  assistant: isModuleMode ? null : selectedAssistant,
                  skillName: skill.name,
                  disabledSkillNames,
                }),
              )
            : []
        const allowedSkillPaths = enabledSkillEntries.map((skill) => skill.path)

        const mcpManager = await getMcpManager()

        const loopConfig = chatModeRuntime.loopConfig
        const buildAutoContextCompactionInput = (
          model: AgentRuntimeRunInput['model'],
        ): AgentRuntimeRunInput['autoContextCompaction'] => {
          const modelProvider = resolveChatModelProvider(settings, model)
          if (modelProvider && providerOwnsConversationContext(modelProvider)) {
            return undefined
          }
          return autoContextCompactionOptions.autoContextCompactionEnabled
            ? {
                chatOptions: autoContextCompactionOptions,
                maxContextTokens: resolveEffectiveMaxContextTokens(model),
              }
            : undefined
        }
        const requestParams = {
          deliveryMode,
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
          builtinCapabilityPreferences:
            chatModeRuntime.builtinCapabilityPreferences,
          toolServerPreferences: chatModeRuntime.toolServerPreferences,
          toolCapabilityMode: chatModeRuntime.toolCapabilityMode,
          bypassToolApproval: chatModeRuntime.bypassToolApproval,
          blockedCommandPrefixes: settings.mcp.builtinCapabilityOptions.terminal
            ?.blockedPrefixes ?? [...DEFAULT_BLOCKED_PREFIXES],
          // The assistant selector stays populated in settings even while a
          // module chat mode is active (D4 hides it in the UI); its
          // workspace scope must not leak into a run where the assistant
          // otherwise takes no part at all.
          workspaceScope: isModuleMode
            ? undefined
            : resolveWorkspaceScopeForRuntimeInput(selectedAssistant),
          allowedSkillPaths,
          bashReadOnly: chatModeRuntime.bashReadOnly,
          moduleToolApprovalPolicies:
            chatModeRuntime.moduleToolApprovalPolicies,
          modePersonaPrompt: chatModeRuntime.modePersonaPrompt,
          modePersonaModuleId: chatModeRuntime.modePersonaModuleId,
          moduleChatModeId: chatModeRuntime.moduleChatModeId,
          contextPolicy: chatModeRuntime.contextPolicy,
          requestParams,
          contextualInjections: buildChatContextualInjections({
            app,
            includeFocusSync: resolveAssistantIncludeCurrentFileContent(
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
          // Only providers that keep a native session ever read these; for
          // every other provider they are inert, so they are built
          // unconditionally rather than by sniffing the selected provider.
          // The accessor loads lazily, so an unused one costs nothing.
          ...(turnId
            ? {
                session: createProviderSessionAccessor({
                  chatManager,
                  conversationId,
                  turnId,
                  parentTurnId,
                }),
              }
            : {}),
          nativeToolPolicy: resolveNativeToolPolicy(chatModeRuntime),
          sourceUserMessageId: assistantContinuation?.sourceUserMessageId,
          continueAssistantMessageId: assistantContinuation?.assistantMessageId,
        }

        const effectiveBranchTarget = assistantContinuation?.branchId
          ? {
              branchId: assistantContinuation.branchId,
              sourceUserMessageId: assistantContinuation.sourceUserMessageId,
              branchModelId: assistantContinuation.modelId,
              branchLabel: assistantContinuation.branchLabel,
            }
          : branchTarget

        if (
          effectiveBranchTarget &&
          (assistantContinuation || requestLastMessage?.role === 'user')
        ) {
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
              branchId: effectiveBranchTarget.branchId,
              sourceUserMessageId: effectiveBranchTarget.sourceUserMessageId,
              branchLabel:
                effectiveBranchTarget.branchLabel ??
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
        error instanceof LLMBaseUrlNotSetException ||
        error instanceof LLMModelNotFoundException
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
        modelId ||
        (isModuleChatMode(chatMode) ? undefined : selectedAssistant?.modelId) ||
        settings.chatModelId

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
        yoloEnabled,
        assistant: selectedAssistant,
        assistantEnabledToolNames:
          getEnabledAssistantToolNames(selectedAssistant),
        moduleChatMode: resolveModuleChatMode(),
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
        toolServerPreferences: chatModeRuntime.toolServerPreferences,
        toolCapabilityMode: chatModeRuntime.toolCapabilityMode,
        modePersonaPrompt: chatModeRuntime.modePersonaPrompt,
        modePersonaModuleId: chatModeRuntime.modePersonaModuleId,
        moduleChatModeId: chatModeRuntime.moduleChatModeId,
        contextPolicy: chatModeRuntime.contextPolicy,
        contextualInjections: buildChatContextualInjections({
          app,
          includeFocusSync: resolveAssistantIncludeCurrentFileContent(
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
      resolveModuleChatMode,
      yoloEnabled,
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
