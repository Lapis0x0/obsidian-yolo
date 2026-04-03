import { TFile } from 'obsidian'

import type {
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
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
  currentFileContextMode,
  currentFileOverride,
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
  currentFileContextMode?: 'full' | 'summary'
  currentFileOverride?: TFile | null
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
    currentFileContextMode,
    currentFileOverride,
  })

  return estimateJsonTokens({
    messages: requestMessages,
    tools: requestTools,
  })
}
