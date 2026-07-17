import type { AssistantToolPreference } from '../../types/assistant.types'
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
  contextualInjections,
  toolCapabilityMode,
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
  contextualInjections?: ContextualInjection[]
  toolCapabilityMode?: ToolCapabilityMode
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
    apiType,
    enableToolDisclosure,
    jsSandboxSettings: mcpManager.getJsSandboxSettings(),
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
    // Token estimate only: never create/freeze the snapshot ahead of the real request.
    systemPromptSnapshotMode: 'reuse',
  })

  return await estimateJsonTokens({
    messages: requestMessages,
    tools: requestTools,
  })
}
