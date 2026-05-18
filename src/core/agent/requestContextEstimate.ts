import type {
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { estimateJsonTokens } from '../../utils/llm/contextTokenEstimate'
import { McpManager } from '../mcp/mcpManager'
import type { ModelTaskRuntimeOptions } from '../mcp/modelTaskTool'

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
  allowedToolNames,
  modelTaskOptions,
  allowedSkillIds,
  allowedSkillNames,
  contextualInjections,
}: {
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  model: ChatModel
  messages: ChatMessage[]
  conversationId: string
  compaction?: ChatConversationCompactionLike | null
  enableTools: boolean
  includeBuiltinTools: boolean
  allowedToolNames?: string[]
  modelTaskOptions?: ModelTaskRuntimeOptions
  allowedSkillIds?: string[]
  allowedSkillNames?: string[]
  contextualInjections?: ContextualInjection[]
}): Promise<number> => {
  const availableTools = enableTools
    ? await mcpManager.listAvailableTools({
        includeBuiltinTools,
        // Tailor built-in tool schemas to the active model so the token
        // estimate reflects what the model will actually see at request time.
        chatModelModalities: model.modalities,
        modelTaskOptions,
      })
    : []
  const { hasTools, hasMemoryTools, requestTools } = selectAllowedTools({
    availableTools,
    allowedToolNames,
    allowedSkillIds,
    allowedSkillNames,
  })

  const requestMessages = await requestContextBuilder.generateRequestMessages({
    messages,
    hasTools,
    hasMemoryTools,
    model,
    conversationId,
    compaction,
    contextualInjections,
  })

  return await estimateJsonTokens({
    messages: requestMessages,
    tools: requestTools,
  })
}
