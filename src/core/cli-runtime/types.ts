import type { ChatMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import type { ResponseUsage } from '../../types/llm/response'
import type { ToolEditSummary } from '../../types/tool-call.types'

import type { CliChatMode } from './permission-profile'

export type CliRuntimeId = 'claude-code' | 'codex'
export type ChatRuntimeId = 'yolo' | CliRuntimeId

export type YoloConversationRef = {
  runtimeId: 'yolo'
  conversationId: string
}

export type CliSessionRef = {
  runtimeId: CliRuntimeId
  nativeSessionId: string
  sessionPathHint?: string
}

export type ConversationRef = YoloConversationRef | CliSessionRef

export const isCliSessionRef = (ref: ConversationRef): ref is CliSessionRef =>
  ref.runtimeId !== 'yolo'

export type CliSessionHydration = {
  ref: CliSessionRef
  messages: ChatMessage[]
  compactionBoundaries: CliCompactionBoundary[]
}

export type CliCompactionBoundary = Readonly<{
  id: string
  /** Visible transcript message immediately preceding this native event. */
  afterMessageId: string | null
  trigger?: 'manual' | 'auto'
  preTokens?: number
  postTokens?: number
}>

export type CliSubagentRef = Readonly<{
  parentSessionRef: CliSessionRef
  toolCallId: string
  subagentId: string
}>

export type CliSubagentTranscriptListener = (
  messages: readonly ChatMessage[],
) => void

export type CliRuntimeSkill = {
  name: string
  description: string
  path: string
}

/**
 * Connection status for one MCP server, normalized across Claude Code
 * (live SDK query, read-write) and Codex (app-server snapshot, read-only).
 * `'unknown'` covers states neither adapter can confidently classify, e.g.
 * a Codex server with neither `serverInfo` nor a recognized auth status.
 */
export type CliRuntimeMcpServerStatus = {
  name: string
  status:
    | 'connected'
    | 'failed'
    | 'needs-auth'
    | 'pending'
    | 'disabled'
    | 'unknown'
  toolCount?: number
  scope?: string
  errorMessage?: string
  /** Codex only exposes a read-only snapshot; Claude supports toggle/reconnect. */
  readOnly: boolean
}

export type CliRuntimeReadyInput = {
  sessionRef?: CliSessionRef
}

export type CliReasoningEffortOption = {
  id: string
  description?: string
}

export type CliRuntimeModel = {
  id: string
  label: string
  description?: string
  reasoningEfforts: CliReasoningEffortOption[]
  defaultReasoningEffort?: string
  isDefault?: boolean
}

export type CliRuntimeConfiguration = {
  models: CliRuntimeModel[]
  /** `null` delegates model selection to the provider-native CLI default. */
  modelId: string | null
  /** `null` delegates reasoning effort to the provider-native CLI default. */
  reasoningEffort: string | null
}

export type CliRuntimeConfigurationUpdate = {
  modelId?: string | null
  reasoningEffort?: string | null
}

export type CliPermissionProfileUpdate = {
  mode: CliChatMode
  yoloEnabled: boolean
}

export type CliTurnConfiguration = Readonly<
  Pick<CliRuntimeConfiguration, 'modelId' | 'reasoningEffort'>
>

export type CliSessionOverlay = Readonly<{
  messages: readonly ChatMessage[]
  turnConfigurationByUserMessageId: Readonly<
    Record<string, CliTurnConfiguration>
  >
  lastCacheHitRate?: number
}>

export type CliTurnInput = {
  sessionRef?: CliSessionRef
  userMessageId?: string
  content: string | ContentPart[]
  selectedSkills?: CliRuntimeSkill[]
}

export type CliRewriteTurnInput = Omit<CliTurnInput, 'sessionRef'> & {
  sessionRef: CliSessionRef
  sourceUserMessageId: string
  userMessageId: string
}

export type CliRuntimeRunState =
  | 'idle'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_user'
  | 'completed'
  | 'aborted'
  | 'error'

/**
 * Run states in which a CLI conversation still owns a live provider process,
 * so it must outlive its view and stay visible to background monitoring.
 */
export type CliActiveRunState = Extract<
  CliRuntimeRunState,
  'running' | 'waiting_for_approval' | 'waiting_for_user'
>

/**
 * Ephemeral mirror of provider-reported context-window usage for the ring UI.
 * Not persisted in YOLO conversation storage; restored via CLI resume/replay.
 */
export type CliContextUsageBucket =
  | 'system'
  | 'tools'
  | 'rules'
  | 'skills'
  | 'memory'
  | 'conversation'
  | 'reasoning'

export type CliContextUsageCategory = Readonly<{
  name: string
  tokens: number
  /** Theme swatch aligned with the native local-estimate breakdown. */
  bucket: CliContextUsageBucket
}>

export type CliContextUsage = Readonly<{
  promptTokens: number
  maxContextTokens: number | null
  /** Fraction of the previous provider turn's input served from prompt cache. */
  cacheHitRate?: number
  /** Claude `getContextUsage()` categories; Codex has no equivalent. */
  categories?: readonly CliContextUsageCategory[]
}>

export type CliRuntimeEvent =
  | {
      type: 'session_bound'
      ref: CliSessionRef
    }
  | {
      type: 'message_upsert'
      message: ChatMessage
    }
  | {
      type: 'message_remove'
      messageId: string
    }
  | {
      type: 'run_state'
      state: CliRuntimeRunState
      error?: string
    }
  | {
      type: 'turn_edit_summary'
      sourceUserMessageId: string
      summary: ToolEditSummary
    }
  | {
      type: 'context_usage'
      usage: CliContextUsage
    }
  | {
      type: 'turn_metrics'
      usage?: ResponseUsage
      durationMs?: number
    }
  | {
      type: 'compaction_state'
      isCompacting: boolean
    }
  | {
      type: 'compaction_boundary'
      boundary: Omit<CliCompactionBoundary, 'afterMessageId'>
    }

export type CliApprovalDecision =
  | 'approve_once'
  | 'approve_for_session'
  | 'reject'

export type CliApprovalResponse = {
  requestId: string
  decision: CliApprovalDecision
}

export type CliQuestionResponse = {
  requestId: string
  answer: unknown
}

export type CliRuntimeEventListener = (event: CliRuntimeEvent) => void

export type CliRuntime = {
  readonly runtimeId: CliRuntimeId

  listModels?(): Promise<CliRuntimeModel[]>
  listSkills?(): Promise<CliRuntimeSkill[]>
  /** Compact the active provider-native session without creating a user turn. */
  compact?(): Promise<void>
  /**
   * Best-effort hot-reload of plugin state into the live session. Claude Code
   * only; other runtimes leave this undefined and callers treat it as a no-op.
   */
  reloadPlugins?(): Promise<void>
  /**
   * Current status of all configured MCP servers. Claude returns a live,
   * writable snapshot; Codex returns a read-only snapshot and may reject
   * with an error when the running CLI predates the query method.
   */
  mcpServerStatus?(): Promise<CliRuntimeMcpServerStatus[]>
  /** Claude Code only. Throws when the runtime does not support toggling. */
  toggleMcpServer?(name: string, enabled: boolean): Promise<void>
  /** Claude Code only. Throws when the runtime does not support reconnecting. */
  reconnectMcpServer?(name: string): Promise<void>
  openSession(ref: CliSessionRef): Promise<CliSessionHydration>
  readSubagent?(ref: CliSubagentRef): Promise<readonly ChatMessage[]>
  watchSubagent?(
    ref: CliSubagentRef,
    listener: CliSubagentTranscriptListener,
  ): Promise<() => void>
  ensureReady(input: CliRuntimeReadyInput): Promise<void>
  getConfiguration(
    cachedModels?: readonly CliRuntimeModel[],
  ): Promise<CliRuntimeConfiguration>
  updateConfiguration(
    update: CliRuntimeConfigurationUpdate,
  ): Promise<CliRuntimeConfiguration>
  /**
   * Hot-update the live session permission profile.
   * Claude applies immediately via setPermissionMode; Codex stores the profile
   * and reasserts it on the next turn/start (and on subsequent thread
   * start/resume).
   */
  updatePermissionProfile?(update: CliPermissionProfileUpdate): Promise<void>
  /** Best-effort update of the provider-native conversation title. */
  setSessionTitle?(ref: CliSessionRef, title: string): Promise<void>
  sendTurn(input: CliTurnInput): Promise<void>
  rewriteTurn(input: CliRewriteTurnInput): Promise<void>
  cancel(): Promise<void>
  respondApproval(response: CliApprovalResponse): Promise<boolean>
  respondQuestion(response: CliQuestionResponse): Promise<boolean>
  subscribe(listener: CliRuntimeEventListener): () => void
  dispose(): Promise<void>
}
