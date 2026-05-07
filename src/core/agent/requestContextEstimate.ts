import type {
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { estimateJsonTokens } from '../../utils/llm/contextTokenEstimate'
import type { McpManager } from '../mcp/mcpManager'

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
  allowedSkillIds,
  allowedSkillNames,
  maxContextOverride,
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
  allowedSkillIds?: string[]
  allowedSkillNames?: string[]
  maxContextOverride?: number
  contextualInjections?: ContextualInjection[]
}): Promise<number> => {
  const availableTools = enableTools
    ? await mcpManager.listAvailableTools({ includeBuiltinTools })
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
    maxContextOverride,
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
