import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { LLMProvider } from '../../types/provider.types'
import { ReasoningLevel } from '../../types/reasoning'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { BaseLLMProvider } from '../llm/base'
import { McpManager } from '../mcp/mcpManager'
import type { ModelTaskRuntimeOptions } from '../mcp/modelTaskTool'

export type AgentRuntimeSnapshot = {
  messages: ChatMessage[]
  compaction: ChatConversationCompactionState
  pendingCompactionAnchorMessageId: string | null
}

export type AgentRuntimeSubscribe = (snapshot: AgentRuntimeSnapshot) => void

export type AgentRuntimeRunInput = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  messages: ChatMessage[]
  requestMessages?: ChatMessage[]
  conversationId: string
  branchId?: string
  sourceUserMessageId?: string
  branchLabel?: string
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  compaction?: ChatConversationCompactionLike | null
  compactionProviderClient?: BaseLLMProvider<LLMProvider>
  compactionModel?: ChatModel
  abortSignal?: AbortSignal
  reasoningLevel?: ReasoningLevel
  requestParams?: {
    stream?: boolean
    temperature?: number
    top_p?: number
    max_tokens?: number
    primaryRequestTimeoutMs?: number
    streamFallbackRecoveryEnabled?: boolean
  }
  allowedToolNames?: string[]
  modelTaskOptions?: ModelTaskRuntimeOptions
  toolPreferences?: Record<
    string,
    {
      enabled?: boolean
      approvalMode?: 'full_access' | 'require_approval'
    }
  >
  workspaceScope?: {
    enabled: boolean
    include: string[]
    exclude: string[]
  }
  allowedSkillIds?: string[]
  allowedSkillNames?: string[]
  contextualInjections?: ContextualInjection[]
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
  /**
   * Optional hook called at every `llm_request` boundary inside the runtime
   * loop. Returns user messages that should be merged into the response stream
   * before the next LLM turn. Used to inject mid-run user messages enqueued by
   * the service layer. Returning an empty array is a no-op.
   *
   * Not invoked by the single-turn fast path (single LLM call, no boundary).
   */
  drainPendingUserMessages?: () => ChatMessage[]
}

export type AgentRuntimeLoopConfig = {
  enableTools: boolean
  maxAutoIterations: number
  includeBuiltinTools: boolean
}

export type AgentWorkerInbound =
  | {
      type: 'start'
      runId: string
      maxIterations: number
    }
  | {
      type: 'llm_result'
      runId: string
      hasToolCalls: boolean
      hasAssistantOutput: boolean
    }
  | {
      type: 'tool_result'
      runId: string
      hasPendingTools: boolean
    }
  | {
      type: 'abort'
      runId: string
    }

export type AgentWorkerOutbound =
  | {
      type: 'llm_request'
      runId: string
      iteration: number
    }
  | {
      type: 'tool_phase'
      runId: string
    }
  | {
      type: 'done'
      runId: string
      reason: 'completed' | 'max_iterations' | 'aborted'
    }
  | {
      type: 'error'
      runId: string
      error: string
    }
