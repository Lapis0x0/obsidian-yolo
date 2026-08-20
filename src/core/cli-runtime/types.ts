import type { App } from 'obsidian'

import type { ChatMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import type { ResponseUsage } from '../../types/llm/response'
import type { ToolEditSummary } from '../../types/tool-call.types'

import type { CliChatMode } from './permission-profile'

/**
 * Single source of truth for which CLI runtimes exist. Order here is the
 * selector's display order. `CliRuntimeId` is derived from it so the two can
 * never drift; adding a runtime means adding one entry here (plus a
 * `CliRuntimeDescriptor` in `registry.ts` and a factory in `coordinator.ts`).
 */
export const CLI_RUNTIME_IDS = ['claude-code', 'codex', 'hermes', 'pi'] as const
export type CliRuntimeId = (typeof CLI_RUNTIME_IDS)[number]
export type ChatRuntimeId = 'yolo' | CliRuntimeId

export type YoloConversationRef = {
  runtimeId: 'yolo'
  conversationId: string
}

export type CliSessionRef = {
  runtimeId: CliRuntimeId
  nativeSessionId: string
  sessionPathHint?: string
  /**
   * Hermes profile this session lives under (its `HERMES_HOME/profiles/<id>`
   * directory, or `'default'` for the root profile). Undefined for runtimes
   * without a profile concept.
   */
  profileId?: string
}

export type ConversationRef = YoloConversationRef | CliSessionRef

export const isCliSessionRef = (ref: ConversationRef): ref is CliSessionRef =>
  ref.runtimeId !== 'yolo'

export type CliSessionHydration = {
  ref: CliSessionRef
  messages: ChatMessage[]
  compactionBoundaries: CliCompactionBoundary[]
  /**
   * Set when the requested session could not be resumed (`loadSession`
   * failed) and this hydration bound a fresh fallback session instead of
   * `requestedRef`. `ref` above is the fallback session actually bound.
   */
  sessionFallback?: Readonly<{ requestedRef: CliSessionRef }>
}

export type CliCompactionBoundary = Readonly<{
  id: string
  /** Visible transcript message immediately preceding this native event. */
  afterMessageId: string | null
  trigger?: 'manual' | 'auto'
  preTokens?: number
  postTokens?: number
}>

/**
 * Anchors a "resumed session couldn't be reached, started a fresh one
 * instead" notice to a point in the transcript, mirroring
 * `CliCompactionBoundary`'s anchoring. Populated when `openSession`/
 * `ensureReady` recovers via `AcpCliRuntimeOptions.sessionRecovery`.
 */
export type CliSessionFallbackBoundary = Readonly<{
  id: string
  /** Visible transcript message immediately preceding this native event. */
  afterMessageId: string | null
  /** The provider-native session that could not be resumed. */
  requestedRef: CliSessionRef
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
      /**
       * Set when this bind is a recovery fallback: `ref` above is a fresh
       * session, and `fallbackFrom` is the originally requested session that
       * could not be resumed.
       */
      fallbackFrom?: CliSessionRef
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
  /**
   * Prepare the process for turns. `session_bound` may be emitted here, or
   * deferred until the first `sendTurn` when the provider has no session yet.
   */
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

/** Call-time context every runtime factory needs to construct a `CliRuntime`. */
export type CliRuntimeFactoryDeps = Readonly<{
  app: App
  vaultPath: string
  /**
   * Profile to launch this runtime instance under, for runtimes with a
   * profile concept (currently Hermes only; see `CliSessionRef.profileId`).
   * Ignored by factories without one. Undefined means "use that runtime's
   * own default".
   */
  profileId?: string
}>

/**
 * Constructs one runtime id's `CliRuntime` instances. Provider-specific setup
 * (launch resolution, pooled host processes, etc.) belongs behind this
 * boundary, in the factory's own module — the coordinator only calls `create`
 * and, when present, the optional lifecycle hooks.
 */
export type CliRuntimeFactory = Readonly<{
  create(deps: CliRuntimeFactoryDeps): CliRuntime
  /** Pre-warms shared, factory-owned infrastructure ahead of first use. */
  warm?(): Promise<void>
  /** Tears down shared, factory-owned infrastructure (e.g. a pooled host process). */
  dispose?(): Promise<void>
}>

export type CliRuntimeFactories = Readonly<
  Record<CliRuntimeId, CliRuntimeFactory>
>
