import type { ChatContextPolicy } from '../../components/chat-view/chat-runtime-profiles'
import type { AssistantToolApprovalMode } from '../../types/assistant.types'
import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import type { NativeToolPolicy } from '../../types/llm/request'
import type { ProviderSessionAccessor } from '../../types/provider-session.types'
import { LLMProvider, LLMProviderApiType } from '../../types/provider.types'
import { ReasoningLevel } from '../../types/reasoning'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { BaseLLMProvider } from '../llm/base'
import type { ResponseDeliveryMode } from '../llm/responseDeliveryMode'
import { McpManager } from '../mcp/mcpManager'

import type { AutoContextCompactionChatOptions } from './compaction'
import type { ToolCapabilityMode } from './tool-capability-prompt'

export type AgentRuntimeSnapshot = {
  messages: ChatMessage[]
  compaction: ChatConversationCompactionState
  pendingCompactionAnchorMessageId: string | null
}

export type AgentRuntimeSubscribe = (snapshot: AgentRuntimeSnapshot) => void

export type AgentPendingUserMessageDrain = {
  messages: ChatUserMessage[]
  sourceUserMessageId: string
}

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
  /** Resume an interrupted assistant message during the first LLM turn. */
  continueAssistantMessageId?: string
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
      approvalMode?: AssistantToolApprovalMode
    }
  >
  /**
   * Per-capability enabled/approval state for built-in tools (D9,
   * docs/plans/2026-08-15-tool-registry/phase2-migration.md D9). Sibling to
   * `toolPreferences` above, which as of that migration only carries remote
   * MCP tool state — built-in tool approval/enablement resolution
   * (`AgentToolGateway.resolveApprovalMode`/`isToolAllowed`) needs both.
   */
  builtinCapabilityPreferences?: Record<
    string,
    {
      enabled?: boolean
      approvalMode?: AssistantToolApprovalMode
    }
  >
  toolServerPreferences?: Record<
    string,
    {
      approvalMode?: AssistantToolApprovalMode
      disclosureMode?: 'always' | 'on_demand'
    }
  >
  workspaceScope?: {
    enabled: boolean
    include: string[]
    exclude: string[]
  }
  allowedSkillPaths?: string[]
  contextualInjections?: ContextualInjection[]
  toolCapabilityMode?: ToolCapabilityMode
  /** Module chat mode persona, injected in place of assistant instructions. */
  modePersonaPrompt?: string
  /** The owning module id, for the persona injection's `module="..."` attribute. */
  modePersonaModuleId?: string
  /** Full running mode id (`module:<moduleId>:<modeId>`) — scopes skill
   * resolution to the mode's own declared skills. See
   * `ChatModeRuntime.moduleChatModeId`. Undefined for built-in modes. */
  moduleChatModeId?: string
  /**
   * Explicit context-assembly policy from `resolveChatModeRuntime`. Absent
   * (built-in modes) is equivalent to `{ useAssistant: true }` — every
   * consumer defaults accordingly, so omitting it never changes existing
   * behavior.
   */
  contextPolicy?: ChatContextPolicy
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
  /**
   * Session handle for a provider that keeps a native session of its own (see
   * `LLMOptions.session`). Absent for every stateless provider and for runs
   * with no conversation record behind them.
   */
  session?: ProviderSessionAccessor
  /** See `LLMOptions.nativeToolPolicy`. */
  nativeToolPolicy?: NativeToolPolicy
  autoContextCompaction?: {
    chatOptions: AutoContextCompactionChatOptions
    maxContextTokens?: number
  }
  /**
   * Optional hook called at every `llm_request` boundary inside the runtime
   * loop. Returns user messages that should be merged into the response stream
   * before the next LLM turn together with the visual-turn anchor they create.
   * Used to inject mid-run user messages enqueued by the service layer.
   * Returning null is a no-op.
   *
   * Not invoked by the single-turn fast path (single LLM call, no boundary).
   */
  drainPendingUserMessages?: () => AgentPendingUserMessageDrain | null
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
  /**
   * When true, the bash tool for this entire run is the structurally
   * read-only variant: mkdir/mv/rm/rmdir are unavailable (command not found)
   * regardless of approval tier. Set by callers that only granted a
   * read-only capability (see `src/core/modules/moduleAgent.ts`'s
   * `vault-read` module agent capability). Defaults to false.
   */
  bashReadOnly?: boolean
  /**
   * For module chat modes: full tool name → the mode's declared
   * `requiresApproval` for each of the mode's own tools. See
   * `ChatModeRuntime.moduleToolApprovalPolicies` — threaded through
   * unchanged to `AgentToolGateway`, which uses it to fix a persisted
   * `approvalPolicy` (and, for bash calls, `executionConstraints`) onto
   * every `ToolCallRequest` at creation time. Undefined for built-in modes.
   */
  moduleToolApprovalPolicies?: ReadonlyMap<string, boolean>
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
      forceStopReason?: 'repeated_tool_failure' | 'repeated_read_call'
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
        | 'repeated_read_call'
        | 'aborted'
    }
  | {
      type: 'error'
      runId: string
      error: string
    }
