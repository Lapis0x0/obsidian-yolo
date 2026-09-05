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
import type { NativePathBoundary } from '../../tools/native/paths'
import type { ChatModeCapabilityOverrides } from '../../tools/types'
import type { ToolCapabilityMode } from '../tool-capability-prompt'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from '../types'

export type SubagentParentContext = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  apiType?: LLMProviderApiType | null
  conversationId: string
  allowedToolNames?: string[]
  toolPreferences?: Record<string, AssistantToolPreference>
  builtinCapabilityPreferences?: Record<string, AssistantToolPreference>
  toolServerPreferences?: Record<string, AssistantToolServerPreference>
  workspaceScope?: AssistantWorkspaceScope
  allowedSkillPaths?: string[]
  reasoningLevel?: ReasoningLevel
  requestParams?: AgentRuntimeRunInput['requestParams']
  loopConfig: AgentRuntimeLoopConfig
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  assistantId?: string
  bypassToolApproval?: boolean
  /**
   * The parent's running mode, and everything about it a child has to run
   * under too (master.md §4 Q11: a subagent inherits Max's tool set *and* its
   * trust tier). `allowedToolNames` alone is not enough — it says which tools
   * exist, not that the mode grants `terminal` past a global switch, not
   * where the vault boundary is, and not what the environment looks like.
   */
  capabilityOverrides?: ChatModeCapabilityOverrides
  vaultPathBoundary?: NativePathBoundary
  toolCapabilityMode?: ToolCapabilityMode
  /**
   * The parent mode's environment section. A child runs with
   * `systemPromptOverride`, which skips section assembly entirely, so the
   * runner appends this to the subagent's own system prompt instead — without
   * it a Max child would be handed real filesystem and shell tools and no
   * statement of where it is or which OS it is on.
   */
  modeEnvironmentPrompt?: string
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
    builtinCapabilityPreferences: input.builtinCapabilityPreferences,
    toolServerPreferences: input.toolServerPreferences,
    workspaceScope: input.workspaceScope,
    allowedSkillPaths: input.allowedSkillPaths,
    reasoningLevel: input.reasoningLevel,
    requestParams: input.requestParams,
    loopConfig,
    requestContextBuilder: input.requestContextBuilder,
    mcpManager: input.mcpManager,
    assistantId: input.assistantId,
    bypassToolApproval: input.bypassToolApproval,
    capabilityOverrides: input.capabilityOverrides,
    vaultPathBoundary: input.vaultPathBoundary,
    toolCapabilityMode: input.toolCapabilityMode,
    modeEnvironmentPrompt: input.modeEnvironmentPrompt,
  }
}
