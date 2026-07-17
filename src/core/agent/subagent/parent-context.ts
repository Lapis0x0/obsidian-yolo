import type {
  AssistantToolPreference,
  AssistantToolServerPreference,
  AssistantWorkspaceScope,
} from '../../../types/assistant.types'
import type { ChatModel } from '../../../types/chat-model.types'
import type {
  LLMProvider,
  LLMProviderApiType,
} from '../../../types/provider.types'
import type { ReasoningLevel } from '../../../types/reasoning'
import type { RequestContextBuilder } from '../../../utils/chat/requestContextBuilder'
import type { BaseLLMProvider } from '../../llm/base'
import type { McpManager } from '../../mcp/mcpManager'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from '../types'

export type SubagentParentContext = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  apiType?: LLMProviderApiType | null
  conversationId: string
  allowedToolNames?: string[]
  toolPreferences?: Record<string, AssistantToolPreference>
  toolServerPreferences?: Record<string, AssistantToolServerPreference>
  workspaceScope?: AssistantWorkspaceScope
  allowedSkillPaths?: string[]
  enableToolDisclosure?: boolean
  reasoningLevel?: ReasoningLevel
  requestParams?: AgentRuntimeRunInput['requestParams']
  loopConfig: AgentRuntimeLoopConfig
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  assistantId?: string
  bypassToolApproval?: boolean
}

export function buildSubagentParentContext(
  input: AgentRuntimeRunInput,
  loopConfig: AgentRuntimeLoopConfig,
): SubagentParentContext {
  return {
    providerClient: input.providerClient,
    model: input.model,
    apiType: input.apiType,
    conversationId: input.conversationId,
    allowedToolNames: input.allowedToolNames,
    toolPreferences: input.toolPreferences,
    toolServerPreferences: input.toolServerPreferences,
    workspaceScope: input.workspaceScope,
    allowedSkillPaths: input.allowedSkillPaths,
    enableToolDisclosure: input.enableToolDisclosure,
    reasoningLevel: input.reasoningLevel,
    requestParams: input.requestParams,
    loopConfig,
    requestContextBuilder: input.requestContextBuilder,
    mcpManager: input.mcpManager,
    assistantId: input.assistantId,
    bypassToolApproval: input.bypassToolApproval,
  }
}
