import type { App } from 'obsidian'

import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from './types'

import type { ChatMode } from '../../components/chat-view/chat-input/ChatModeSelect'
import { resolveChatModeRuntime } from '../../components/chat-view/chat-runtime-profiles'
import { resolveWorkspaceScopeForRuntimeInput } from '../../components/chat-view/chat-runtime-inputs'
import type { McpManager } from '../mcp/mcpManager'
import type { RunYoloAgentInput } from '../../runtime/yoloRuntime.types'
import type { Assistant } from '../../types/assistant.types'
import { getChatModelClient } from '../llm/manager'
import { LLMModelNotFoundException } from '../llm/exception'
import { shouldUseStreamingForProvider } from '../llm/streamingPolicy'
import { listLiteSkillEntries } from '../skills/liteSkills'
import { isSkillEnabledForAssistant } from '../skills/skillPolicy'
import { getEnabledAssistantToolNames } from './tool-preferences'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'

/**
 * Minimal plugin surface required by buildAgentRuntimeInput.
 */
export type BuildAgentRuntimePlugin = {
  app: App
  settings: SmartComposerSettings
  getMcpManager(): Promise<McpManager>
}

export type BuildAgentRuntimeResult = {
  /** The AgentRuntimeRunInput ready to pass to AgentService.run().input */
  input: AgentRuntimeRunInput
  /** loopConfig derived from the assistant and mode */
  loopConfig: AgentRuntimeLoopConfig
  /** The resolved assistant (null when none selected / not found) */
  selectedAssistant: Assistant | null
}

/**
 * Build the full AgentRuntimeRunInput from a RunYoloAgentInput.
 *
 * Extracted from `useChatStreamManager.ts` mutationFn — this is the standard
 * (non-branch, single-model) path. Callers may spread the returned `input`
 * and override fields (e.g. abortSignal, requestMessages) before passing it
 * to AgentService.run().
 */
export async function buildAgentRuntimeInput(
  plugin: BuildAgentRuntimePlugin,
  input: RunYoloAgentInput,
): Promise<BuildAgentRuntimeResult> {
  const { app, settings } = plugin

  // ---- 1. Resolve assistant ----
  const effectiveAssistantId =
    input.assistantId ?? settings.currentAssistantId
  const selectedAssistant: Assistant | null = effectiveAssistantId
    ? (settings.assistants ?? []).find(
        (a) => a.id === effectiveAssistantId,
      ) ?? null
    : null

  // ---- 2. Resolve model + provider client ----
  const requestedModelId =
    input.modelId ||
    selectedAssistant?.modelId ||
    settings.chatModelId

  const resolveClientForModelId = (
    requestedId: string,
  ): ReturnType<typeof getChatModelClient> => {
    try {
      return getChatModelClient({
        settings,
        modelId: requestedId,
      })
    } catch (error) {
      if (
        error instanceof LLMModelNotFoundException &&
        settings.chatModels.length > 0
      ) {
        return getChatModelClient({
          settings,
          modelId: settings.chatModels[0].id,
        })
      }
      throw error
    }
  }

  const resolvedClient = resolveClientForModelId(requestedModelId)
  const effectiveModel = resolvedClient.model

  const currentProvider = settings.providers.find(
    (p) => p.id === effectiveModel.providerId,
  )

  // ---- 3. Streaming policy ----
  const shouldStreamResponse = shouldUseStreamingForProvider({
    requestedStream: input.overrides?.stream ?? true,
    provider: currentProvider,
  })

  // ---- 4. Skills ----
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

  // ---- 5. Chat mode runtime (loopConfig, tool prefs) ----
  const effectiveChatMode: ChatMode =
    input.overrides?.chatMode === 'chat' ? 'chat' : 'agent'

  const chatModeRuntime = resolveChatModeRuntime({
    mode: effectiveChatMode,
    assistant: selectedAssistant,
    assistantEnabledToolNames: getEnabledAssistantToolNames(selectedAssistant),
  })

  // ---- 6. MCP manager ----
  const mcpManager = await plugin.getMcpManager()

  // ---- 7. Request context builder ----
  const requestContextBuilder = new RequestContextBuilder(app, settings)

  // ---- 8. Request params ----
  const requestParams: AgentRuntimeRunInput['requestParams'] = {
    stream: shouldStreamResponse,
    temperature:
      input.overrides?.temperature ?? effectiveModel.temperature,
    top_p: input.overrides?.top_p ?? effectiveModel.topP,
    max_tokens: effectiveModel.maxOutputTokens,
    primaryRequestTimeoutMs:
      settings.continuationOptions.primaryRequestTimeoutMs,
    streamFallbackRecoveryEnabled:
      settings.continuationOptions.streamFallbackRecoveryEnabled,
  }

  // ---- 9. Workspace scope ----
  const workspaceScope = resolveWorkspaceScopeForRuntimeInput(selectedAssistant)

  // ---- 10. Build the AgentRuntimeRunInput ----
  const agentRunInput: AgentRuntimeRunInput = {
    providerClient: resolvedClient.providerClient,
    model: effectiveModel,
    messages: input.messages,
    requestMessages: input.requestMessages,
    conversationId: input.conversationId,
    branchId: input.branchTarget?.branchId,
    sourceUserMessageId: input.branchTarget?.sourceUserMessageId,
    branchLabel: input.branchTarget?.branchLabel,
    requestContextBuilder,
    mcpManager,
    requestParams,
    reasoningLevel: input.reasoningLevel,
    allowedToolNames: chatModeRuntime.allowedToolNames,
    toolPreferences: chatModeRuntime.toolPreferences,
    workspaceScope,
    allowedSkillIds,
    allowedSkillNames,
    maxContextOverride: input.overrides?.maxContextMessages ?? undefined,
    contextualInjections: [],
    geminiTools: {
      useWebSearch: input.overrides?.useWebSearch ?? false,
      useUrlContext: input.overrides?.useUrlContext ?? false,
    },
  }

  return {
    input: agentRunInput,
    loopConfig: chatModeRuntime.loopConfig,
    selectedAssistant,
  }
}
