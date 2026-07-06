import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { LLMProvider, LLMProviderApiType } from '../../types/provider.types'
import { ReasoningLevel } from '../../types/reasoning'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { BaseLLMProvider } from '../llm/base'
import type { ResponseDeliveryMode } from '../llm/responseDeliveryMode'
import { McpManager } from '../mcp/mcpManager'

import type { CitationRegistry } from './citationRegistry'
import type { AutoContextCompactionChatOptions } from './compaction'

export type AgentRunContext = {
  citationRegistry: CitationRegistry
}

export type AgentRuntimeSnapshot = {
  messages: ChatMessage[]
  compaction: ChatConversationCompactionState
  pendingCompactionAnchorMessageId: string | null
}

export type AgentRuntimeSubscribe = (snapshot: AgentRuntimeSnapshot) => void

export type AgentRuntimeRunInput = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  /**
   * API protocol of the active provider. Used by the tool stub builder to
   * pick a schema that the provider accepts (Gemini's restricted OpenAPI
   * subset vs. the open `additionalProperties` form used by everyone else).
   */
  apiType?: LLMProviderApiType | null
  messages: ChatMessage[]
  requestMessages?: ChatMessage[]
  conversationId: string
  assistantId?: string
  branchId?: string
  sourceUserMessageId?: string
  branchLabel?: string
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  compaction?: ChatConversationCompactionLike | null
  abortSignal?: AbortSignal
  reasoningLevel?: ReasoningLevel
  requestParams?: {
    deliveryMode?: ResponseDeliveryMode
    temperature?: number
    top_p?: number
    max_tokens?: number
    primaryRequestTimeoutMs?: number
    streamFallbackRecoveryEnabled?: boolean
  }
  allowedToolNames?: string[]
  enableToolDisclosure?: boolean
  toolPreferences?: Record<
    string,
    {
      enabled?: boolean
      approvalMode?: 'full_access' | 'require_approval'
      disclosureMode?: 'always' | 'on_demand'
    }
  >
  toolServerPreferences?: Record<
    string,
    {
      approvalMode?: 'full_access' | 'require_approval'
    }
  >
  workspaceScope?: {
    enabled: boolean
    include: string[]
    exclude: string[]
  }
  allowedSkillPaths?: string[]
  contextualInjections?: ContextualInjection[]
  runtimeModePrompt?: string
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
  autoContextCompaction?: {
    chatOptions: AutoContextCompactionChatOptions
    maxContextTokens?: number
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
  /**
   * Per-run side-channel for state that flows down to tool execution but isn't
   * part of the LLM-visible message stream (e.g. the citation registry that
   * collects fs_search hits across multiple tool calls).
   */
  runContext?: AgentRunContext
  /** Isolated subagent runs: replace the normal system prompt assembly. */
  systemPromptOverride?: string
  /** Conversation whose approval state should be used for tool auto-execution. */
  toolApprovalConversationId?: string
  /** Terminal command prefixes rejected before execution or approval. */
  blockedCommandPrefixes?: string[]
  /**
   * When true, auto-execute all allowed tools without per-tool approval.
   * Dangerous command prefix blocklist and global tool enable gates still apply.
   */
  bypassToolApproval?: boolean
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
      forceStopReason?: 'repeated_tool_failure'
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
      reason:
        | 'completed'
        | 'max_iterations'
        | 'repeated_tool_failure'
        | 'aborted'
    }
  | {
      type: 'error'
      runId: string
      error: string
    }
