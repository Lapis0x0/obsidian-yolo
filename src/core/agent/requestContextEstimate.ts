import type { ChatContextPolicy } from '../../components/chat-view/chat-runtime-profiles'
import type {
  AssistantToolPreference,
  AssistantToolServerPreference,
} from '../../types/assistant.types'
import type {
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { LLMProviderApiType } from '../../types/provider.types'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { estimateJsonTokens } from '../../utils/llm/contextTokenEstimate'
import { McpManager } from '../mcp/mcpManager'

import {
  type ToolCapabilityMode,
  buildToolCapabilityPrompt,
} from './tool-capability-prompt'
import { selectAllowedTools } from './tool-selection'

export const estimateContinuationRequestContextTokens = async ({
  requestContextBuilder,
  mcpManager,
  model,
  messages,
  conversationId,
  compaction,
  enableTools,
  includeBuiltinTools,
  apiType,
  allowedToolNames,
  enableToolDisclosure,
  toolPreferences,
  toolServerPreferences,
  contextualInjections,
  toolCapabilityMode,
  modePersonaPrompt,
  modePersonaModuleId,
  moduleChatModeId,
  contextPolicy,
}: {
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  model: ChatModel
  messages: ChatMessage[]
  conversationId: string
  compaction?: ChatConversationCompactionLike | null
  enableTools: boolean
  includeBuiltinTools: boolean
  apiType?: LLMProviderApiType | null
  allowedToolNames?: string[]
  enableToolDisclosure?: boolean
  toolPreferences?: Record<string, AssistantToolPreference>
  toolServerPreferences?: Record<string, AssistantToolServerPreference>
  contextualInjections?: ContextualInjection[]
  toolCapabilityMode?: ToolCapabilityMode
  modePersonaPrompt?: string
  modePersonaModuleId?: string
  moduleChatModeId?: string
  contextPolicy?: ChatContextPolicy
}): Promise<number> => {
  const availableTools = enableTools
    ? await mcpManager.listAvailableTools({
        includeBuiltinTools,
        // Tailor built-in tool schemas to the active model so the token
        // estimate reflects what the model will actually see at request time.
        chatModelModalities: model.modalities,
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
    allowedToolNames,
    toolPreferences,
    toolServerPreferences,
    apiType,
    enableToolDisclosure,
    jsSandboxSettings: mcpManager.getJsSandboxSettings(),
    settings: mcpManager.getSettingsSnapshot(),
  })

  const runtimeModePrompt = buildToolCapabilityPrompt({
    mode: toolCapabilityMode ?? 'agent',
    toolNames: filteredTools.map((tool) => tool.name),
  })
  const requestMessages = await requestContextBuilder.generateRequestMessages({
    messages,
    hasTools,
    hasMemoryTools,
    hasOnDemandTools,
    model,
    conversationId,
    compaction,
    contextualInjections,
    runtimeModePrompt,
    modePersonaPrompt,
    modePersonaModuleId,
    moduleChatModeId,
    contextPolicy,
    // Token estimate only: never create/freeze the snapshot ahead of the real request.
    systemPromptSnapshotMode: 'reuse',
  })

  return await estimateJsonTokens({
    messages: requestMessages,
    tools: requestTools,
  })
}
