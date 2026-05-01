import type {
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { CurrentFileViewState } from '../../types/mentionable'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { estimateJsonTokens } from '../../utils/llm/contextTokenEstimate'
import { McpManager } from '../mcp/mcpManager'

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
  currentFileOverride,
  currentFileViewState,
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
  currentFileOverride?: import('obsidian').TFile | null
  currentFileViewState?: CurrentFileViewState
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
    currentFileOverride,
    currentFileViewState,
  })

  return estimateJsonTokens({
    messages: requestMessages,
    tools: requestTools,
  })
}
