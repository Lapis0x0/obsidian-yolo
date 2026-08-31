import { v4 as uuidv4 } from 'uuid'

import type {
  AgentConversationRunSummary,
  AgentConversationState,
  AgentService,
} from '../../core/agent/service'
import type {
  ChatRuntimeId,
  CliChatMode,
  CliConversationController,
  CliPermissionProfileUpdate,
  CliRuntimeId,
  CliRuntimeScope,
} from '../../core/cli-runtime'
import type { ChatConversationCliSession } from '../../database/json/chat/types'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatConversationCompaction,
  ChatConversationCompactionState,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { ContentPart } from '../../types/llm/request'
import {
  type ReasoningLevel,
  normalizeStoredReasoningLevel,
} from '../../types/reasoning'
import { groupAssistantAndToolMessages } from '../../utils/chat/message-groups'
import type { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { stampUserMessageTimeContext } from '../../utils/prompt/timeContext'

import { type ChatMode, isModuleChatMode } from './chat-input/ChatModeSelect'
import {
  buildAssistantErrorContinuation,
  buildRetrySubmissionMessages,
  getDisplayedAssistantToolMessages,
  getSourceUserMessageIdForGroup,
} from './chatRetry'
import {
  type CliChatOperationCoordinator,
  type CliChatOperationSnapshot,
  invalidateChatRuntimeNavigation,
  isCliConversationActive,
  submitCliComposerTurn,
} from './cliChatIntegration'
import type { SetStateActionLike } from './ConversationPreferencesController'
import { ConversationPreferencesController } from './ConversationPreferencesController'
import type { QueryProgressState } from './QueryProgress'

function resolveNext<T>(action: SetStateActionLike<T>, prev: T): T {
  return typeof action === 'function'
    ? (action as (prev: T) => T)(prev)
    : action
}

function deleteMapKey<V>(map: Map<string, V>, key: string): Map<string, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

export type ChatSessionSnapshot = {
  currentConversationId: string
  chatMessages: ChatMessage[]
  compactionState: ChatConversationCompactionState
  pendingCompactionAnchorMessageId: string | null
  /** Per-conversation user-message-id -> chat-model-id override. */
  messageModelMap: Map<string, string>
  /** Per-conversation user-message-id -> reasoning-level override. */
  messageReasoningMap: Map<string, ReasoningLevel>
  assistantGroupBoundaryMessageIds: string[]
  activeBranchByUserMessageId: Map<string, string>
}

/**
 * Persist-call outcome, reported back to the caller instead of surfacing a
 * `Notice` directly — Notice/i18n stay in the React hook layer (see
 * `docs/plans/2026-08-11-arch-governance-step3-chat-state-ownership.md`,
 * "分期 C" boundary rules).
 */
export type ChatSessionPersistOutcome = {
  kind: 'persisted'
  ok: Promise<boolean>
}

/**
 * Everything `submit`/`abortRun` need from the CLI runtime side for the
 * currently-active CLI runtime. Still React state owned by
 * `useCliRuntimeOrchestration` (see plan "分期 C" boundary rules — CLI
 * orchestration state stays there until C3); Chat.tsx assembles a fresh bag
 * every render behind a `useLatestRef` and hands the controller only a
 * zero-arg getter, so this file never imports `obsidian` or React to type
 * `app`/`settings` directly (`buildEnvironmentContext` is pre-bound by the
 * hook instead of taking `app`/`currentFile`/... params here).
 */
export type ChatSessionCliContext = {
  runtimeId: CliRuntimeId
  controller: CliConversationController
  coordinator: CliChatOperationCoordinator
  scope: CliRuntimeScope
  settings: YoloSettings
  chatMode: CliChatMode
  yoloEnabled: boolean
  cliConversationId: string | null
  /** Reads `inputDraftRevisionRef.current` live — that ref bumps on every
   * keystroke without a Chat.tsx re-render (see `ChatInputDraftHolder`), so a
   * value snapshotted when this bag was assembled would go stale between
   * renders. Must stay a getter, not a plain field. */
  getDraftRevision: () => number
  buildEnvironmentContext: () => Promise<ContentPart[]>
  createOrTouchCliConversation: (
    id: string,
    cliSession: ChatConversationCliSession,
    overrides: ConversationOverrideSettings | null | undefined,
  ) => Promise<void>
  generateConversationTitle: (
    id: string,
    messages: ChatUserMessage[],
  ) => Promise<string | null>
  syncCliConversationTitle: (conversationId: string, title: string) => void
  setCliConversationId: (id: string) => void
  consumeAcceptedCliDraft: (
    acceptedDraft: NonNullable<CliChatOperationSnapshot['acceptedDraft']>,
  ) => void
  isMounted: () => boolean
}

export type ChatSessionCliSubmitOutcome =
  | { kind: 'ok' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string }

export type ChatSessionSubmitInput = {
  runtimeId: ChatRuntimeId
  /** Built via the hook's `buildInputMessageForSubmit` — mentionables/
   * selectedSkills/reasoningLevel already resolved, not yet time-stamped. */
  message: ChatUserMessage
  /** Resolved by the hook from settings + selected assistant (policy input —
   * see the C1 branch-policy precedent in `branchFromAssistantGroup`). Only
   * consulted on the yolo path; the CLI path always stamps (see
   * `submitCliComposerTurn`). */
  assistantTimeContextEnabled: boolean
  /** Fresh-at-call-time run status from `useChatStreamManager` (still owned
   * there — "不动 streaming 层"). */
  currentConversationRunSummary: Pick<
    AgentConversationRunSummary,
    'isActive' | 'isQueueable' | 'isWaitingApproval' | 'isWaitingUserInput'
  >
}

export type ChatSessionSubmitResult =
  | { kind: 'cli_unavailable' }
  | { kind: 'cli_busy' }
  | { kind: 'cli_submission_blocked' }
  | { kind: 'cli_submitted'; settled: Promise<ChatSessionCliSubmitOutcome> }
  | { kind: 'blocked_waiting_user_input' }
  | { kind: 'blocked_waiting_approval' }
  | { kind: 'blocked_enqueue_awaiting_approval' }
  | { kind: 'blocked_active_tool' }
  | { kind: 'enqueued'; message: ChatUserMessage }
  | { kind: 'submitted'; message: ChatUserMessage }

export type ChatSessionAbortResult =
  | { kind: 'yolo_aborted' }
  | { kind: 'cli_unavailable' }
  | {
      kind: 'cli_cancelling'
      settled: Promise<{ ok: true } | { ok: false; message: string }>
    }

export type ChatSessionCompactResult =
  | { kind: 'blocked_waiting_approval' }
  | { kind: 'blocked_active' }
  | { kind: 'empty' }
  | { kind: 'compacted' }
  | { kind: 'failed'; error: unknown }

export type ChatSessionRetryResult = { kind: 'failed' } | { kind: 'submitted' }

export type ChatSessionContinueErrorResult =
  | { kind: 'failed' }
  | { kind: 'pending' }
  | { kind: 'started' }

export type ChatSessionRunConversationBranchTarget = {
  branchId: string
  sourceUserMessageId: string
  branchModelId?: string
  branchLabel?: string
}

export type ChatSessionAssistantContinuationTarget = {
  assistantMessageId: string
  sourceUserMessageId: string
  modelId: string
  branchId?: string
  branchLabel?: string
}

export type ChatSessionRunConversationParams = {
  chatMessages: ChatMessage[]
  requestMessages?: ChatMessage[]
  conversationId: string
  reasoningLevel?: ReasoningLevel
  modelIds?: string[]
  branchTarget?: ChatSessionRunConversationBranchTarget
  assistantContinuation?: ChatSessionAssistantContinuationTarget
  compactionOverride?: ChatConversationCompactionState
}

export type ChatSessionControllerDeps = {
  /**
   * Long-lived object — read the current AgentService through a getter
   * rather than caching it, matching CLAUDE.md's "Runtime Boundaries" rule
   * for every other controller in this directory.
   */
  getAgentService: () => Pick<
    AgentService,
    | 'subscribe'
    | 'getState'
    | 'replaceConversationMessages'
    | 'enqueueUserMessage'
  >
  createOrUpdateConversation: (
    id: string,
    messages: ChatMessage[],
    overrides: ConversationOverrideSettings | null | undefined,
    conversationModelId: string | undefined,
    messageModelMap: Record<string, string> | undefined,
    activeBranchByUserMessageId: Record<string, string> | undefined,
    reasoningLevel: string | undefined,
    compaction: ChatConversationCompactionState | undefined,
    assistantGroupBoundaryMessageIds: string[] | undefined,
  ) => Promise<void> | undefined
  createOrUpdateConversationImmediately: (
    id: string,
    messages: ChatMessage[],
    overrides: ConversationOverrideSettings | null | undefined,
    conversationModelId: string | undefined,
    messageModelMap: Record<string, string> | undefined,
    activeBranchByUserMessageId: Record<string, string> | undefined,
    reasoningLevel: string | undefined,
    compaction: ChatConversationCompactionState | undefined,
    assistantGroupBoundaryMessageIds: string[] | undefined,
    options?: { touchUpdatedAt?: boolean },
  ) => Promise<void>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  /**
   * `chatModeForSave` is an identity function today (see
   * `chat-input/ChatModeSelect.tsx`) but is kept as an injected seam rather
   * than inlined so every write-back call site stays greppable, matching the
   * intent documented at its definition.
   */
  chatModeForSave: (mode: ChatMode) => ChatMode

  // === C2 additions: submit/abort/compact/retry/recover/continue ===

  /** `RequestContextBuilder` changes identity when `settings` changes — read
   * it through a getter, not a captured reference (same reason
   * `submitChatMutation` etc. below need one). */
  getRequestContextBuilder: () => Pick<
    RequestContextBuilder,
    'compileUserMessagePrompt'
  >
  /** Wraps `useChatStreamManager().submitChatMutation.mutate` — streaming
   * itself is not moved into the controller (plan: "本分期不重写 streaming
   * 层"), only the call-time orchestration around it. */
  runConversation: (
    params: ChatSessionRunConversationParams,
    options?: { onSettled?: () => void },
  ) => void
  abortConversationRun: (conversationId: string) => void
  compactConversation: (
    messages: ChatMessage[],
  ) => Promise<ChatConversationCompaction | null>
  generateConversationTitle: (
    id: string,
    messages: ChatMessage[],
    options?: { force?: boolean },
  ) => Promise<string | null>
  /**
   * Scroll writes stay behind an injected trigger — never a direct
   * `scrollTop` write from this file (CLAUDE.md "Chat Runtime Invariants").
   * `deferToNextFrame` preserves the pre-C2 difference between call sites:
   * `handleUserMessageSubmit` wrapped its call in `requestAnimationFrame`,
   * `handleAssistantErrorContinue` called it synchronously. Scheduling is
   * the dep's job (Chat.tsx wraps it when asked) so this file never touches
   * a browser-only global and stays runnable under Jest's Node test
   * environment.
   */
  forceScrollToBottom: (options?: { deferToNextFrame?: boolean }) => void
  setQueryProgress: (action: SetStateActionLike<QueryProgressState>) => void
  /** Bumped once per new user turn entering the conversation (queued or
   * submitted) so any in-flight CLI/native-action navigation token is
   * invalidated — mirrors the pre-C2 `invalidateChatRuntimeNavigation` call
   * site. Plain `{ current }` object (not `MutableRefObject`) to keep this
   * file React-import-free. */
  runtimeNavigationGenerationRef: { current: number }
  /** `null` whenever the active runtime is `'yolo'`, or the CLI orchestration
   * hook hasn't produced a ready controller/coordinator/scope yet — mirrors
   * the pre-C2 `if (!controller || !coordinator || !scope) return` guard. */
  getCliSubmitContext: () => ChatSessionCliContext | null
}

type Listener = () => void

/** Policy inputs the caller (hook layer) resolves before branching — settings,
 * module-chat-mode registry availability, and i18n all stay out of the
 * controller (see class doc). */
export type BranchFromAssistantGroupPolicy = {
  nextOverrides: ConversationOverrideSettings | null
  nextChatMode: ChatMode
  nextPersistedChatMode: ChatMode
  nextYoloEnabled: boolean
  conversationAssistantId: string
  resolvedConversationModelId: string
  resolvedReasoningLevel: ReasoningLevel
  branchTitle: string
}

export type BranchFromAssistantGroupResult = {
  newConversationId: string
  resolvedReasoningLevel: ReasoningLevel
  persisted: Promise<boolean>
}

/**
 * Message-state septet's唯一 owner: `currentConversationId` / `chatMessages`
 * / `compactionState` / `pendingCompactionAnchorMessageId` /
 * `messageModelMap` / `messageReasoningMap` /
 * `assistantGroupBoundaryMessageIds` / `activeBranchByUserMessageId`.
 *
 * See `docs/plans/2026-08-11-arch-governance-step3-chat-state-ownership.md`,
 * "分期 C" ("C1" slice). Plain TS class — zero React / zero `obsidian`
 * imports, one instance per ChatView (constructed via `useRef` in Chat.tsx,
 * same lifecycle as `ConversationPreferencesController`). React subscribes
 * through `useSyncExternalStore(controller.subscribe, controller.getSnapshot)`.
 *
 * Two API tiers, mirroring `ConversationPreferencesController`:
 * - Raw `SetStateActionLike` setters (`setChatMessages` etc.) — drop-in
 *   replacements for the `useState` setters they used to be, for call sites
 *   that only ever "reduce over the array" (mentionable edits, and the
 *   surviving pre-C2 write points in `useChatDomainActions`/`YoloChatSurface`
 *   documented in the plan). No cascading side effects.
 * - Semantic commands (`removeHistoricalUserMessage`,
 *   `handleAssistantMessageGroupBranch`, ...) — full edit/delete/branch
 *   transactions, including persistence. They return typed results instead
 *   of surfacing `Notice`; the calling hook translates results into UI
 *   reactions (Notice, focus, scroll, input-box rebuild).
 *
 * AgentService is the authoritative source for `chatMessages` /
 * `compactionState` / `pendingCompactionAnchorMessageId` *while a run is in
 * flight or has left tracked state behind* — the controller keeps its own
 * subscription (re-pointed whenever `currentConversationId` changes) and
 * merges pushes into its snapshot, replacing the mirrored `setChatMessages`
 * calls `useChatStreamManager` used to make into React state directly. Direct
 * edits (this file's commands) remain legitimate — see the 2026-08-11
 * architecture-governance audit referenced in the plan for why these three
 * fields are not pure AgentService shadows.
 */
export class ChatSessionController {
  private snapshot: ChatSessionSnapshot
  private readonly listeners = new Set<Listener>()
  private agentUnsubscribe: (() => void) | null = null
  /** Guards `continueAssistantError` against re-entrant clicks — equivalent
   * to the pre-C2 `assistantContinuationPendingRef` in
   * `useChatDomainActions.ts`, now a plain field instead of a React ref. */
  private assistantContinuationPending = false

  readonly chatMessagesStateRef: { current: ChatMessage[] }
  readonly activeBranchByUserMessageIdRef: { current: Map<string, string> }

  constructor(
    initialConversationId: string,
    initialSnapshot: Omit<ChatSessionSnapshot, 'currentConversationId'>,
    private readonly preferencesController: ConversationPreferencesController,
    private readonly deps: ChatSessionControllerDeps,
  ) {
    this.snapshot = {
      currentConversationId: initialConversationId,
      ...initialSnapshot,
    }

    // Arrow-function accessors (not object-literal `get`/`set`, which would
    // rebind `this` to the facade object) so `.current` always reads/writes
    // through this controller instance without aliasing `this`.
    this.chatMessagesStateRef = Object.defineProperty(
      {} as { current: ChatMessage[] },
      'current',
      {
        enumerable: true,
        get: (): ChatMessage[] => this.snapshot.chatMessages,
        set: (value: ChatMessage[]): void => this.setChatMessages(value),
      },
    )
    this.activeBranchByUserMessageIdRef = Object.defineProperty(
      {} as { current: Map<string, string> },
      'current',
      {
        enumerable: true,
        get: (): Map<string, string> =>
          this.snapshot.activeBranchByUserMessageId,
        set: (value: Map<string, string>): void =>
          this.setActiveBranchByUserMessageId(value),
      },
    )

    this.subscribeAgentService(initialConversationId)
  }

  getSnapshot = (): ChatSessionSnapshot => this.snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Call from a mount-once effect's cleanup when the owning ChatView unmounts. */
  dispose = (): void => {
    this.agentUnsubscribe?.()
    this.agentUnsubscribe = null
  }

  /**
   * Re-establish the AgentService subscription after `dispose()` dropped it.
   * React StrictMode (dev builds — see ChatView.tsx) replays the mount effect
   * as setup → cleanup → setup; without this, the cleanup's `dispose()` would
   * leave the second mount permanently unsubscribed.
   */
  resumeAgentSubscription = (): void => {
    if (this.agentUnsubscribe) return
    this.subscribeAgentService(this.snapshot.currentConversationId)
  }

  private commit(partial: Partial<ChatSessionSnapshot>): void {
    const keys = Object.keys(partial) as (keyof ChatSessionSnapshot)[]
    const changed = keys.some(
      (key) => !Object.is(this.snapshot[key], partial[key]),
    )
    if (!changed) return
    this.snapshot = { ...this.snapshot, ...partial }
    this.listeners.forEach((listener) => listener())
  }

  private subscribeAgentService(conversationId: string): void {
    this.agentUnsubscribe?.()
    const agentService = this.deps.getAgentService()
    // Sync once immediately, then subscribe without a duplicate emit — same
    // pattern `useChatStreamManager`'s effect used before this merge moved
    // here.
    this.mergeAgentState(agentService.getState(conversationId))
    this.agentUnsubscribe = agentService.subscribe(
      conversationId,
      (state) => this.mergeAgentState(state),
      { emitCurrent: false },
    )
  }

  private mergeAgentState(state: AgentConversationState): void {
    const hasTrackedState = state.messages.length > 0 || state.status !== 'idle'
    if (!hasTrackedState) return
    this.commit({
      chatMessages: state.messages,
      compactionState: state.compaction ?? [],
      pendingCompactionAnchorMessageId:
        state.pendingCompactionAnchorMessageId ?? null,
    })
  }

  // === Pure helpers (duplicated from useYoloChatSession.ts intentionally —
  // see the C1 completion report for why: importing them would either pull
  // React into this module or force an awkward controller -> hook edge). ===

  private normalizeAssistantGroupBoundaryMessageIds(
    messages: ChatMessage[],
    sourceIds: readonly string[],
  ): string[] {
    const availableNonUserMessageIds = new Set(
      messages
        .filter(
          (message): message is ChatAssistantMessage | ChatToolMessage =>
            message.role === 'assistant' || message.role === 'tool',
        )
        .map((message) => message.id),
    )
    return sourceIds.filter(
      (messageId, index) =>
        availableNonUserMessageIds.has(messageId) &&
        sourceIds.indexOf(messageId) === index,
    )
  }

  /**
   * Public (unlike the other grouping helpers below): the hook layer calls
   * this directly for the mentionable-delete-from-all boundary recompute
   * (`useChatInputController.ts`'s `handleMentionableDeleteFromAll` — see
   * the C2 migration list, "boundary 工具已是 controller 能力").
   */
  buildAssistantGroupBoundaryMessageIdsAfterUserRemoval(
    sourceMessages: ChatMessage[],
    nextMessages: ChatMessage[],
    existingBoundaryMessageIds: readonly string[],
  ): string[] {
    const retainedMessageIds = new Set(
      nextMessages.map((message) => message.id),
    )
    const nextBoundaryMessageIds = [
      ...this.normalizeAssistantGroupBoundaryMessageIds(
        nextMessages,
        existingBoundaryMessageIds,
      ),
    ]
    let lastRetainedNonUserMessageId: string | null = null
    let sawRemovedUserAfterRetainedNonUser = false

    sourceMessages.forEach((message) => {
      const isRetained = retainedMessageIds.has(message.id)

      if (!isRetained) {
        if (message.role === 'user' && lastRetainedNonUserMessageId) {
          sawRemovedUserAfterRetainedNonUser = true
        }
        return
      }

      if (message.role === 'user') {
        lastRetainedNonUserMessageId = null
        sawRemovedUserAfterRetainedNonUser = false
        return
      }

      if (lastRetainedNonUserMessageId && sawRemovedUserAfterRetainedNonUser) {
        nextBoundaryMessageIds.push(message.id)
      }

      lastRetainedNonUserMessageId = message.id
      sawRemovedUserAfterRetainedNonUser = false
    })

    return this.normalizeAssistantGroupBoundaryMessageIds(
      nextMessages,
      nextBoundaryMessageIds,
    )
  }

  private serializeMessageModelMap(
    messages: ChatMessage[],
    sourceMap: Map<string, string>,
  ): Record<string, string> | undefined {
    const persistedEntries = messages.flatMap((message) => {
      if (message.role !== 'user') return []
      const modelId = sourceMap.get(message.id)
      return modelId ? [[message.id, modelId] as const] : []
    })
    return persistedEntries.length > 0
      ? Object.fromEntries(persistedEntries)
      : undefined
  }

  private serializeActiveBranchByUserMessageId(
    messages: ChatMessage[],
    activeBranchByUserMessageId: ReadonlyMap<string, string>,
  ): Record<string, string> | undefined {
    const validUserMessageIds = new Set(
      messages
        .filter(
          (message): message is ChatUserMessage => message.role === 'user',
        )
        .map((message) => message.id),
    )
    const entries = Array.from(activeBranchByUserMessageId.entries()).filter(
      ([userMessageId, branchId]) =>
        validUserMessageIds.has(userMessageId) && branchId.trim().length > 0,
    )
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }

  private effectiveCompactionState(
    messages: ChatMessage[],
  ): ChatConversationCompactionState {
    return this.snapshot.compactionState.filter((entry) =>
      messages.some((message) => message.id === entry.anchorMessageId),
    )
  }

  /**
   * Align AgentService's in-memory copy of the conversation with a message
   * list the user just mutated outside of a run (deletions). Without this the
   * service keeps the pre-deletion list and any later publish — a background
   * task result appending to `entry.state.messages`, for instance — pushes the
   * deleted messages straight back into React state through `mergeAgentState`.
   * Deleting every message used to avoid this only as a side effect of
   * `dropConversation`, which also tombstoned the conversation id.
   *
   * Public for the same reason `persist` below is: the mentionable-delete-from-all
   * path in `useChatInputController.ts` mutates the message list itself.
   */
  syncAgentConversationMessages(messages: ChatMessage[]): void {
    this.deps
      .getAgentService()
      .replaceConversationMessages(
        this.snapshot.currentConversationId,
        messages,
        this.effectiveCompactionState(messages),
      )
  }

  /**
   * Public (debounced persist, no Notice — the caller decides what to show
   * on failure). Exposed for the same reason as
   * `buildAssistantGroupBoundaryMessageIdsAfterUserRemoval` above: the
   * mentionable-delete-from-all path in `useChatInputController.ts` used to
   * go through `useYoloChatSession`'s own `persistConversation` wrapper;
   * this is the controller-owned equivalent.
   *
   * Persisting an empty list is meaningful: an existing conversation the user
   * emptied stays in history with zero messages (the "never created" case is
   * filtered in `persistConversationInternal`, which knows whether the row
   * exists).
   */
  persist(
    messages: ChatMessage[],
    assistantGroupBoundaryIdsOverride?: readonly string[],
  ): Promise<boolean> {
    const conversationId = this.snapshot.currentConversationId
    const prefs = this.preferencesController.getSnapshot()
    const effectiveOverrides = {
      ...(prefs.conversationOverrides ?? {}),
      chatMode: this.deps.chatModeForSave(prefs.persistedChatMode),
      agentYoloEnabled: prefs.yoloEnabled,
    }
    const reasoningLevel =
      this.preferencesController.conversationReasoningLevelRef.current.get(
        conversationId,
      ) ?? prefs.reasoningLevel

    return (async () => {
      try {
        await this.deps.createOrUpdateConversation(
          conversationId,
          messages,
          effectiveOverrides,
          prefs.conversationModelId,
          this.serializeMessageModelMap(
            messages,
            this.snapshot.messageModelMap,
          ),
          this.serializeActiveBranchByUserMessageId(
            messages,
            this.snapshot.activeBranchByUserMessageId,
          ),
          reasoningLevel,
          this.effectiveCompactionState(messages),
          this.normalizeAssistantGroupBoundaryMessageIds(
            messages,
            assistantGroupBoundaryIdsOverride ??
              this.snapshot.assistantGroupBoundaryMessageIds,
          ),
        )
        return true
      } catch (error) {
        console.error('Failed to save chat history', error)
        return false
      }
    })()
  }

  /** Same as `persist`, but through `createOrUpdateConversationImmediately`
   * (no debounce) — used by the C2 recovery paths that must land on disk
   * before the next `run()` call reads the conversation back. */
  private persistImmediately(
    messages: ChatMessage[],
    assistantGroupBoundaryIdsOverride?: readonly string[],
  ): Promise<boolean> {
    const conversationId = this.snapshot.currentConversationId
    const prefs = this.preferencesController.getSnapshot()
    const effectiveOverrides = {
      ...(prefs.conversationOverrides ?? {}),
      chatMode: this.deps.chatModeForSave(prefs.persistedChatMode),
      agentYoloEnabled: prefs.yoloEnabled,
    }
    const reasoningLevel =
      this.preferencesController.conversationReasoningLevelRef.current.get(
        conversationId,
      ) ?? prefs.reasoningLevel

    return (async () => {
      try {
        await this.deps.createOrUpdateConversationImmediately(
          conversationId,
          messages,
          effectiveOverrides,
          prefs.conversationModelId,
          this.serializeMessageModelMap(
            messages,
            this.snapshot.messageModelMap,
          ),
          this.serializeActiveBranchByUserMessageId(
            messages,
            this.snapshot.activeBranchByUserMessageId,
          ),
          reasoningLevel,
          this.effectiveCompactionState(messages),
          this.normalizeAssistantGroupBoundaryMessageIds(
            messages,
            assistantGroupBoundaryIdsOverride ??
              this.snapshot.assistantGroupBoundaryMessageIds,
          ),
        )
        return true
      } catch (error) {
        console.error('Failed to save chat history', error)
        return false
      }
    })()
  }

  /** Equivalent to the original `resolveReasoningLevelForMessages`
   * (`useChatDomainActions.ts`): last user message's stored level, falling
   * back to the current preference. `normalizeStoredReasoningLevel` already
   * validates against `REASONING_LEVELS`, so no extra allow-list check is
   * needed here (the hook's `normalizeReasoningLevel` wrapper was a no-op
   * re-check of the exact same set). */
  private resolveReasoningLevelForMessages(
    messages: ChatMessage[],
  ): ReasoningLevel {
    const lastUserMessage = [...messages]
      .reverse()
      .find((message): message is ChatUserMessage => message.role === 'user')
    return (
      normalizeStoredReasoningLevel(lastUserMessage?.reasoningLevel) ??
      this.preferencesController.getSnapshot().reasoningLevel
    )
  }

  /** Duplicated from `useChatDomainActions.ts` intentionally — same
   * rationale as the grouping helpers above (C1 completion report): pulling
   * it in would either import React into this module or create a
   * controller -> hook edge for a five-line pure function. */
  private getLatestUserSelectedModelIds(
    messages: ChatMessage[],
  ): string[] | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'user') {
        continue
      }
      return message.selectedModelIds?.length
        ? message.selectedModelIds
        : undefined
    }
    return undefined
  }

  /** Equivalent to the original `displayedChatMessages` `useMemo` in
   * Chat.tsx: groups the working copy and resolves each group's active
   * branch. Recomputed on demand (submit/retry/continue are user-triggered,
   * not per-render) rather than cached — `useChatTimelineReadModel`'s
   * memoization existed for render-time reuse, which no longer applies once
   * this lives outside React. */
  private computeDisplayedChatMessages(): ChatMessage[] {
    const grouped = groupAssistantAndToolMessages(
      this.snapshot.chatMessages,
      this.snapshot.assistantGroupBoundaryMessageIds,
    )
    return grouped.flatMap((messageOrGroup): ChatMessage[] => {
      if (!Array.isArray(messageOrGroup)) {
        return [messageOrGroup]
      }
      const sourceUserMessageId =
        getSourceUserMessageIdForGroup(messageOrGroup) ?? ''
      return getDisplayedAssistantToolMessages(
        messageOrGroup,
        this.snapshot.activeBranchByUserMessageId.get(sourceUserMessageId),
      )
    })
  }

  /**
   * Equivalent to the original `handleUserMessageSubmit`
   * (`useChatDomainActions.ts`): compiles the submitted user message's
   * prompt, writes the working copy + AgentService + debounced persistence,
   * and triggers the run. Shared by the normal `submit()` yolo path and
   * `retryAssistantMessageGroup` (its `retryBranchTarget` is the only thing
   * that differs between the two call sites, exactly as before the move).
   */
  private async runNormalSubmission({
    inputChatMessages,
    requestChatMessages,
    retryBranchTarget,
    persistedMessageModelMap,
  }: {
    inputChatMessages: ChatMessage[]
    requestChatMessages?: ChatMessage[]
    retryBranchTarget?: ChatSessionRunConversationBranchTarget
    persistedMessageModelMap?: Map<string, string>
  }): Promise<void> {
    // Captured once, matching the pre-C2 closure semantics: everything after
    // the awaited prompt compilation below must keep targeting the
    // conversation (and its maps) as of the moment the user hit submit — the
    // user may load another conversation while the await is in flight.
    const conversationId = this.snapshot.currentConversationId
    const messageModelMapAtSubmit = this.snapshot.messageModelMap
    const activeBranchAtSubmit = this.snapshot.activeBranchByUserMessageId
    const boundaryIdsAtSubmit = this.snapshot.assistantGroupBoundaryMessageIds
    const compactionForSubmit = this.effectiveCompactionState(
      this.snapshot.chatMessages,
    )

    invalidateChatRuntimeNavigation(this.deps.runtimeNavigationGenerationRef)
    this.deps.abortConversationRun(conversationId)
    this.deps.setQueryProgress({ type: 'idle' })

    this.setChatMessages(inputChatMessages)
    this.deps.forceScrollToBottom({ deferToNextFrame: true })

    const effectiveRequestChatMessages =
      requestChatMessages ?? inputChatMessages
    const lastMessage = effectiveRequestChatMessages.at(-1)
    if (lastMessage?.role !== 'user') {
      throw new Error('Last message is not a user message')
    }

    const prefs = this.preferencesController.getSnapshot()
    const { promptContent } = await this.deps
      .getRequestContextBuilder()
      .compileUserMessagePrompt({
        message: lastMessage,
        onQueryProgressChange: this.deps.setQueryProgress,
        scope: isModuleChatMode(prefs.chatMode)
          ? { moduleChatModeId: prefs.chatMode }
          : undefined,
      })
    const compiledRequestMessages = effectiveRequestChatMessages.map(
      (message) =>
        message.role === 'user' && message.id === lastMessage.id
          ? { ...message, promptContent }
          : message,
    )

    const compiledUserMessagesById = new Map(
      compiledRequestMessages
        .filter(
          (message): message is ChatUserMessage => message.role === 'user',
        )
        .map((message) => [message.id, message]),
    )

    const compiledInputMessages = inputChatMessages.map((message) => {
      if (message.role !== 'user') {
        return message
      }
      const compiledUserMessage = compiledUserMessagesById.get(message.id)
      return compiledUserMessage
        ? { ...message, promptContent: compiledUserMessage.promptContent }
        : message
    })

    const persistedMessages = compiledInputMessages.map((message) => {
      if (message.role !== 'user' || !message.promptContent) {
        return message
      }
      return { ...message, promptContent: null }
    })

    // Working-copy writes only apply while this controller still shows the
    // originating conversation; persistence and the run always target the
    // captured id.
    const stillOnSubmittedConversation =
      this.snapshot.currentConversationId === conversationId
    if (stillOnSubmittedConversation) {
      this.setChatMessages(persistedMessages)
    }
    this.deps
      .getAgentService()
      .replaceConversationMessages(
        conversationId,
        persistedMessages,
        compactionForSubmit,
      )
    if (stillOnSubmittedConversation) {
      this.setCompactionState(compactionForSubmit)
    }
    void this.deps.createOrUpdateConversation(
      conversationId,
      compiledInputMessages,
      {
        ...(prefs.conversationOverrides ?? {}),
        chatMode: prefs.chatMode,
        agentYoloEnabled: prefs.yoloEnabled,
      },
      prefs.conversationModelId,
      this.serializeMessageModelMap(
        compiledInputMessages,
        persistedMessageModelMap ?? messageModelMapAtSubmit,
      ),
      this.serializeActiveBranchByUserMessageId(
        compiledInputMessages,
        activeBranchAtSubmit,
      ),
      this.preferencesController.conversationReasoningLevelRef.current.get(
        conversationId,
      ) ?? prefs.reasoningLevel,
      compactionForSubmit,
      this.normalizeAssistantGroupBoundaryMessageIds(
        compiledInputMessages,
        boundaryIdsAtSubmit,
      ),
    )
    void this.deps.generateConversationTitle(
      conversationId,
      compiledInputMessages,
    )
    const requestReasoningLevel = this.resolveReasoningLevelForMessages(
      compiledRequestMessages,
    )
    const requestModelIds =
      lastMessage.selectedModelIds && lastMessage.selectedModelIds.length > 0
        ? lastMessage.selectedModelIds
        : undefined
    this.deps.runConversation({
      chatMessages: compiledInputMessages,
      requestMessages: compiledRequestMessages,
      conversationId,
      reasoningLevel: requestReasoningLevel,
      modelIds: requestModelIds,
      branchTarget: retryBranchTarget,
      compactionOverride: compactionForSubmit,
    })
  }

  /**
   * CLI branch of `submit()` — equivalent to the CLI half of the original
   * `handleMainInputSubmit` (`useChatInputController.ts`). Notice/i18n stay
   * out: the async result resolves `settled` with a typed outcome and the
   * hook decides what to show.
   */
  private submitCli(message: ChatUserMessage): ChatSessionSubmitResult {
    const cliContext = this.deps.getCliSubmitContext()
    if (!cliContext) return { kind: 'cli_unavailable' }
    const { controller, coordinator, scope } = cliContext
    if (isCliConversationActive(controller.getSnapshot())) {
      return { kind: 'cli_busy' }
    }

    const submission = coordinator.beginSubmission(
      cliContext.getDraftRevision(),
    )
    if (!submission) return { kind: 'cli_submission_blocked' }

    const settled: Promise<ChatSessionCliSubmitOutcome> = (async () => {
      try {
        const environmentContext = await cliContext.buildEnvironmentContext()
        const result = await submitCliComposerTurn({
          settings: cliContext.settings,
          scope,
          controller,
          runtimeId: cliContext.runtimeId,
          userMessage: message,
          environmentContext,
          permissionProfile: {
            mode: cliContext.chatMode,
            yoloEnabled:
              cliContext.chatMode === 'plan' ? false : cliContext.yoloEnabled,
          } satisfies CliPermissionProfileUpdate,
          signal: submission.signal,
          onSendStarted: () => coordinator.markSending(submission.token),
          onPresented: (presentedMessage) =>
            coordinator.markPresented(submission.token, presentedMessage),
          onAccepted: (acceptedMessage) => {
            if (
              coordinator.markAccepted(submission.token, acceptedMessage) &&
              cliContext.isMounted()
            ) {
              const acceptedDraft = coordinator.getSnapshot().acceptedDraft
              if (acceptedDraft) {
                cliContext.consumeAcceptedCliDraft(acceptedDraft)
              }
            }
          },
        })
        const historyConversationId = cliContext.cliConversationId ?? uuidv4()
        await cliContext.createOrTouchCliConversation(
          historyConversationId,
          {
            runtimeId: result.sessionRef.runtimeId,
            nativeSessionId: result.sessionRef.nativeSessionId,
            ...(result.sessionRef.sessionPathHint
              ? { sessionPathHint: result.sessionRef.sessionPathHint }
              : {}),
            ...(result.sessionRef.profileId
              ? { profileId: result.sessionRef.profileId }
              : {}),
          },
          this.preferencesController.getSnapshot().conversationOverrides,
        )
        if (cliContext.cliConversationId === null && cliContext.isMounted()) {
          cliContext.setCliConversationId(historyConversationId)
        }
        void cliContext
          .generateConversationTitle(historyConversationId, [
            result.userMessage,
          ])
          .then((title) => {
            if (title) {
              cliContext.syncCliConversationTitle(historyConversationId, title)
            }
          })
        if (cliContext.isMounted() && result.overlayError) {
          console.warn('[YOLO] Failed to save CLI display metadata', {
            conversationId: historyConversationId,
            error: result.overlayError.message,
          })
        }
        return { kind: 'ok' }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return { kind: 'aborted' }
        }
        return {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        }
      } finally {
        coordinator.finishSubmission(submission.token)
      }
    })()

    return { kind: 'cli_submitted', settled }
  }

  // === Raw setters — `SetStateActionLike` drop-ins for the `useState`
  // setters they replace. No cascading side effects, no persistence. ===

  setChatMessages = (action: SetStateActionLike<ChatMessage[]>): void => {
    this.commit({
      chatMessages: resolveNext(action, this.snapshot.chatMessages),
    })
  }

  setCompactionState = (
    action: SetStateActionLike<ChatConversationCompactionState>,
  ): void => {
    this.commit({
      compactionState: resolveNext(action, this.snapshot.compactionState),
    })
  }

  setPendingCompactionAnchorMessageId = (
    action: SetStateActionLike<string | null>,
  ): void => {
    this.commit({
      pendingCompactionAnchorMessageId: resolveNext(
        action,
        this.snapshot.pendingCompactionAnchorMessageId,
      ),
    })
  }

  setMessageModelMap = (
    action: SetStateActionLike<Map<string, string>>,
  ): void => {
    this.commit({
      messageModelMap: resolveNext(action, this.snapshot.messageModelMap),
    })
  }

  setMessageReasoningMap = (
    action: SetStateActionLike<Map<string, ReasoningLevel>>,
  ): void => {
    this.commit({
      messageReasoningMap: resolveNext(
        action,
        this.snapshot.messageReasoningMap,
      ),
    })
  }

  setAssistantGroupBoundaryMessageIds = (
    action: SetStateActionLike<string[]>,
  ): void => {
    this.commit({
      assistantGroupBoundaryMessageIds: resolveNext(
        action,
        this.snapshot.assistantGroupBoundaryMessageIds,
      ),
    })
  }

  setActiveBranchByUserMessageId = (
    action: SetStateActionLike<Map<string, string>>,
  ): void => {
    this.commit({
      activeBranchByUserMessageId: resolveNext(
        action,
        this.snapshot.activeBranchByUserMessageId,
      ),
    })
  }

  /**
   * Changing the conversation identity re-points the AgentService
   * subscription — every other setter is a plain field write.
   */
  setCurrentConversationId = (action: SetStateActionLike<string>): void => {
    const next = resolveNext(action, this.snapshot.currentConversationId)
    if (next === this.snapshot.currentConversationId) return
    this.commit({ currentConversationId: next })
    this.subscribeAgentService(next)
  }

  // === Semantic commands ===

  /** Equivalent to the original `updateHistoricalUserMessage`. Never persists
   * — matches the pre-migration function exactly. */
  updateHistoricalUserMessage = (
    messageId: string,
    updater: (message: ChatUserMessage) => ChatUserMessage,
  ): boolean => {
    const nextMessages = this.snapshot.chatMessages.map((message) =>
      message.role === 'user' && message.id === messageId
        ? updater(message)
        : message,
    )
    const updatedMessage = nextMessages.find(
      (message): message is ChatUserMessage =>
        message.role === 'user' && message.id === messageId,
    )
    if (!updatedMessage) return false

    this.commit({
      chatMessages: nextMessages,
      assistantGroupBoundaryMessageIds:
        this.normalizeAssistantGroupBoundaryMessageIds(
          nextMessages,
          this.snapshot.assistantGroupBoundaryMessageIds,
        ),
    })
    return true
  }

  /** Equivalent to the original `removeHistoricalUserMessage`. */
  removeHistoricalUserMessage = (
    messageId: string,
  ): { removedMessages: ChatMessage[]; outcome: ChatSessionPersistOutcome } => {
    const sourceMessages = this.snapshot.chatMessages
    const removedMessages = sourceMessages.filter(
      (message) => message.role === 'user' && message.id === messageId,
    )
    const nextMessages = sourceMessages.filter(
      (message) => !(message.role === 'user' && message.id === messageId),
    )
    const nextAssistantGroupBoundaryMessageIds =
      this.buildAssistantGroupBoundaryMessageIdsAfterUserRemoval(
        sourceMessages,
        nextMessages,
        this.snapshot.assistantGroupBoundaryMessageIds,
      )

    this.commit({
      chatMessages: nextMessages,
      assistantGroupBoundaryMessageIds: nextAssistantGroupBoundaryMessageIds,
      messageModelMap: deleteMapKey(this.snapshot.messageModelMap, messageId),
      messageReasoningMap: deleteMapKey(
        this.snapshot.messageReasoningMap,
        messageId,
      ),
      activeBranchByUserMessageId: deleteMapKey(
        this.snapshot.activeBranchByUserMessageId,
        messageId,
      ),
    })

    this.syncAgentConversationMessages(nextMessages)
    const ok = this.persist(nextMessages, nextAssistantGroupBoundaryMessageIds)
    return { removedMessages, outcome: { kind: 'persisted', ok } }
  }

  /** Equivalent to the original `handleAssistantMessageEditSave`. */
  handleAssistantMessageEditSave = (
    groupAnchorMessageId: string,
    replacementMessages: ChatMessage[],
  ): { changed: boolean; outcome: ChatSessionPersistOutcome | null } => {
    const prevMessages = this.snapshot.chatMessages
    const groupedMessages = groupAssistantAndToolMessages(
      prevMessages,
      this.snapshot.assistantGroupBoundaryMessageIds,
    )
    const targetGroup = groupedMessages.find(
      (item): item is AssistantToolMessageGroup =>
        Array.isArray(item) &&
        item.some((message) => message.id === groupAnchorMessageId),
    )
    if (!targetGroup) return { changed: false, outcome: null }

    const anchorMessage = targetGroup.find(
      (message) => message.id === groupAnchorMessageId,
    )
    const anchorBranchId = anchorMessage?.metadata?.branchId
    const targetMessages = anchorBranchId
      ? targetGroup.filter(
          (message) => message.metadata?.branchId === anchorBranchId,
        )
      : targetGroup
    const targetIds = new Set(targetMessages.map((message) => message.id))
    const targetIndexes = prevMessages
      .map((message, index) => (targetIds.has(message.id) ? index : null))
      .filter((index): index is number => index !== null)
    const startIndex = targetIndexes[0]
    const endIndex = targetIndexes.at(-1)
    if (startIndex === undefined || endIndex === undefined) {
      return { changed: false, outcome: null }
    }

    const nextMessages = [
      ...prevMessages.slice(0, startIndex),
      ...replacementMessages,
      ...prevMessages.slice(endIndex + 1),
    ]
    this.commit({ chatMessages: nextMessages })
    const ok = this.persist(nextMessages)
    return { changed: true, outcome: { kind: 'persisted', ok } }
  }

  /** Equivalent to the original `handleAssistantMessageGroupDelete`. */
  handleAssistantMessageGroupDelete = (
    messageIds: string[],
  ): { outcome: ChatSessionPersistOutcome } => {
    const idsToRemove = new Set(messageIds)
    const nextMessages = this.snapshot.chatMessages.filter(
      (message) => !idsToRemove.has(message.id),
    )
    const nextAssistantGroupBoundaryMessageIds =
      this.normalizeAssistantGroupBoundaryMessageIds(
        nextMessages,
        this.snapshot.assistantGroupBoundaryMessageIds,
      )
    this.commit({
      chatMessages: nextMessages,
      assistantGroupBoundaryMessageIds: nextAssistantGroupBoundaryMessageIds,
    })
    this.syncAgentConversationMessages(nextMessages)
    const ok = this.persist(nextMessages, nextAssistantGroupBoundaryMessageIds)
    return { outcome: { kind: 'persisted', ok } }
  }

  /** Equivalent to the original `handleHistoricalUserMessageDelete` — the
   * `isCurrentConversationRunActive` guard stays in the calling hook, which
   * already has that value. Returns `null` when `userMessageId` isn't found
   * (mirrors the original's early `if (startIdx < 0) return`). */
  handleHistoricalUserMessageDelete = (
    userMessageId: string,
  ): {
    removedMessages: ChatMessage[]
    outcome: ChatSessionPersistOutcome
  } | null => {
    const sourceMessages = this.snapshot.chatMessages
    const startIdx = sourceMessages.findIndex(
      (message) => message.id === userMessageId && message.role === 'user',
    )
    if (startIdx < 0) return null

    let endIdx = sourceMessages.length
    for (let i = startIdx + 1; i < sourceMessages.length; i += 1) {
      if (sourceMessages[i].role === 'user') {
        endIdx = i
        break
      }
    }
    const removedIds = new Set(
      sourceMessages.slice(startIdx, endIdx).map((m) => m.id),
    )
    const removedMessages = sourceMessages.slice(startIdx, endIdx)
    const nextMessages = sourceMessages.filter(
      (message) => !removedIds.has(message.id),
    )
    const nextAssistantGroupBoundaryMessageIds =
      this.normalizeAssistantGroupBoundaryMessageIds(
        nextMessages,
        this.snapshot.assistantGroupBoundaryMessageIds,
      )

    this.commit({
      chatMessages: nextMessages,
      assistantGroupBoundaryMessageIds: nextAssistantGroupBoundaryMessageIds,
      messageModelMap: deleteMapKey(
        this.snapshot.messageModelMap,
        userMessageId,
      ),
      messageReasoningMap: deleteMapKey(
        this.snapshot.messageReasoningMap,
        userMessageId,
      ),
      activeBranchByUserMessageId: deleteMapKey(
        this.snapshot.activeBranchByUserMessageId,
        userMessageId,
      ),
    })

    this.syncAgentConversationMessages(nextMessages)
    const ok = this.persist(nextMessages, nextAssistantGroupBoundaryMessageIds)
    return { removedMessages, outcome: { kind: 'persisted', ok } }
  }

  /**
   * Equivalent to the original `handleAssistantMessageGroupBranch`, plus the
   * confirmed AgentService-registration fix: the branched conversation's
   * messages are now registered into AgentService memory (`replaceConversationMessages`
   * + re-pointing this controller's own subscription) before persistence,
   * instead of only ever reaching AgentService on the first submit in the new
   * branch.
   *
   * `policy` carries every value that depends on settings / the module
   * chat-mode registry / i18n — all resolved by the caller so this method
   * stays free of those imports. Returns `null` when there is nothing to
   * branch (mirrors the original's early-return + Notice, which the caller
   * now shows itself).
   */
  branchFromAssistantGroup = (
    messageIds: string[],
    policy: BranchFromAssistantGroupPolicy,
  ): BranchFromAssistantGroupResult | null => {
    if (messageIds.length === 0) return null
    const sourceMessages = this.snapshot.chatMessages
    const targetIds = new Set(messageIds)
    let branchEndIndex = -1
    for (let i = sourceMessages.length - 1; i >= 0; i -= 1) {
      if (targetIds.has(sourceMessages[i].id)) {
        branchEndIndex = i
        break
      }
    }
    if (branchEndIndex < 0) return null

    const nextMessages = sourceMessages.slice(0, branchEndIndex + 1)
    if (nextMessages.length === 0) return null

    const newConversationId = uuidv4()
    const retainedUserMessageIds = new Set(
      nextMessages
        .filter(
          (message): message is ChatUserMessage => message.role === 'user',
        )
        .map((message) => message.id),
    )
    const nextMessageModelMap = new Map(
      Array.from(this.snapshot.messageModelMap.entries()).filter(
        ([messageId]) => retainedUserMessageIds.has(messageId),
      ),
    )
    const nextMessageReasoningMap = new Map(
      Array.from(this.snapshot.messageReasoningMap.entries()).filter(
        ([messageId]) => retainedUserMessageIds.has(messageId),
      ),
    )
    const nextAssistantGroupBoundaryMessageIds =
      this.normalizeAssistantGroupBoundaryMessageIds(
        nextMessages,
        this.snapshot.assistantGroupBoundaryMessageIds,
      )
    const nextActiveBranchByUserMessageId = new Map(
      Array.from(this.snapshot.activeBranchByUserMessageId.entries()).filter(
        ([messageId]) => retainedUserMessageIds.has(messageId),
      ),
    )
    const branchedCompactionState = this.effectiveCompactionState(nextMessages)

    this.preferencesController.switchConversation(newConversationId, {
      conversationOverrides: policy.nextOverrides,
      chatMode: policy.nextChatMode,
      persistedChatMode: policy.nextPersistedChatMode,
      yoloEnabled: policy.nextYoloEnabled,
      conversationAssistantId: policy.conversationAssistantId,
      conversationModelId: policy.resolvedConversationModelId,
      reasoningLevel: policy.resolvedReasoningLevel,
    })

    this.commit({
      currentConversationId: newConversationId,
      chatMessages: nextMessages,
      compactionState: branchedCompactionState,
      pendingCompactionAnchorMessageId: null,
      messageModelMap: nextMessageModelMap,
      messageReasoningMap: nextMessageReasoningMap,
      assistantGroupBoundaryMessageIds: nextAssistantGroupBoundaryMessageIds,
      activeBranchByUserMessageId: nextActiveBranchByUserMessageId,
    })

    // Fix: register into AgentService memory before anything else observes
    // `newConversationId` — see method doc.
    this.deps
      .getAgentService()
      .replaceConversationMessages(
        newConversationId,
        nextMessages,
        branchedCompactionState,
        {
          persistState: true,
          reason: 'hydrate',
        },
      )
    this.subscribeAgentService(newConversationId)

    const persisted = (async () => {
      try {
        await this.deps.createOrUpdateConversationImmediately(
          newConversationId,
          nextMessages,
          {
            ...(policy.nextOverrides ?? {}),
            chatMode: this.deps.chatModeForSave(policy.nextPersistedChatMode),
            agentYoloEnabled: policy.nextYoloEnabled,
          },
          policy.resolvedConversationModelId,
          this.serializeMessageModelMap(nextMessages, nextMessageModelMap),
          this.serializeActiveBranchByUserMessageId(
            nextMessages,
            nextActiveBranchByUserMessageId,
          ),
          policy.resolvedReasoningLevel,
          branchedCompactionState,
          nextAssistantGroupBoundaryMessageIds,
        )
        await this.deps.updateConversationTitle(
          newConversationId,
          policy.branchTitle,
        )
        return true
      } catch (error) {
        console.error('Failed to create branched conversation', error)
        return false
      }
    })()

    return {
      newConversationId,
      resolvedReasoningLevel: policy.resolvedReasoningLevel,
      persisted,
    }
  }

  // === C2 commands: submit / abort / compact / retry / recover / continue ===

  /**
   * Equivalent to `handleMainInputSubmit` (`useChatInputController.ts`),
   * minus the DOM/editor-state parsing and post-submit input-box rebuild
   * (both stay in the hook — see the type doc on `ChatSessionSubmitResult`).
   * Dispatches to the CLI branch when `runtimeId !== 'yolo'`; otherwise runs
   * the exact yolo gating order the original had: waiting-for-user-input,
   * waiting-for-approval, queueable (enqueue), active, normal submit.
   */
  submit(input: ChatSessionSubmitInput): ChatSessionSubmitResult {
    if (input.runtimeId !== 'yolo') {
      return this.submitCli(input.message)
    }

    const messageForSubmit = stampUserMessageTimeContext(
      input.message,
      input.assistantTimeContextEnabled,
    )
    const runSummary = input.currentConversationRunSummary

    // ask_user_question parks the agent in a paused state that may outlive
    // the run itself — a new message must answer that panel first.
    if (runSummary.isWaitingUserInput) {
      return { kind: 'blocked_waiting_user_input' }
    }
    if (runSummary.isWaitingApproval) {
      return { kind: 'blocked_waiting_approval' }
    }

    if (runSummary.isQueueable) {
      const enqueueResult = this.deps
        .getAgentService()
        .enqueueUserMessage(
          this.snapshot.currentConversationId,
          messageForSubmit,
        )
      if (enqueueResult === 'enqueued') {
        this.setMessageReasoningMap((prev) => {
          const next = new Map(prev)
          next.set(
            messageForSubmit.id,
            this.preferencesController.getSnapshot().reasoningLevel,
          )
          return next
        })
        return { kind: 'enqueued', message: messageForSubmit }
      }
      if (enqueueResult === 'blocked_awaiting_approval') {
        return { kind: 'blocked_enqueue_awaiting_approval' }
      }
      // 'idle' falls through to the normal submit path below, matching the
      // pre-C2 behavior.
    }

    if (runSummary.isActive) {
      return { kind: 'blocked_active_tool' }
    }

    const nextMessageModelMap = new Map(this.snapshot.messageModelMap)
    nextMessageModelMap.set(
      messageForSubmit.id,
      this.preferencesController.getSnapshot().conversationModelId,
    )
    const inputChatMessages = [...this.snapshot.chatMessages, messageForSubmit]
    const requestChatMessages = [
      ...this.computeDisplayedChatMessages(),
      messageForSubmit,
    ]

    this.setMessageModelMap(nextMessageModelMap)
    this.setMessageReasoningMap((prev) => {
      const next = new Map(prev)
      next.set(
        messageForSubmit.id,
        this.preferencesController.getSnapshot().reasoningLevel,
      )
      return next
    })

    void this.runNormalSubmission({
      inputChatMessages,
      requestChatMessages,
      persistedMessageModelMap: nextMessageModelMap,
    })

    return { kind: 'submitted', message: messageForSubmit }
  }

  /** Equivalent to `handleMainInputAbort` (`useChatInputController.ts`).
   * Notice on a failed CLI cancel is the hook's job — it awaits `settled`. */
  abortRun(input: { runtimeId: ChatRuntimeId }): ChatSessionAbortResult {
    if (input.runtimeId !== 'yolo') {
      const cliContext = this.deps.getCliSubmitContext()
      if (!cliContext) return { kind: 'cli_unavailable' }
      const settled = cliContext.coordinator
        .cancelCurrentOperation(cliContext.controller)
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({
            ok: false as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      return { kind: 'cli_cancelling', settled }
    }
    this.deps.abortConversationRun(this.snapshot.currentConversationId)
    return { kind: 'yolo_aborted' }
  }

  /**
   * Equivalent to `handleManualContextCompaction` (`useChatDomainActions.ts`)
   * — yolo-only; the CLI `/compact` slash command still goes through the
   * hook's own `cliOperationCoordinator.transition` (native CLI compaction
   * has no local message-state to own here).
   *
   * Implicit-dependency note (see the plan's C2 design-audit section): this
   * method does not call `this.setCompactionState` directly after a
   * successful compaction. `replaceConversationMessages` below reaches this
   * same controller's own AgentService subscription (`mergeAgentState`,
   * re-pointed per `currentConversationId` since C1), which synchronously
   * folds the new compaction entry into this snapshot. Confirmed still true
   * post-C1: the controller, not `useChatStreamManager`, now owns that
   * subscription.
   */
  async compactContext(input: {
    currentConversationRunSummary: Pick<
      AgentConversationRunSummary,
      'isActive' | 'isWaitingApproval'
    >
  }): Promise<ChatSessionCompactResult> {
    if (input.currentConversationRunSummary.isWaitingApproval) {
      return { kind: 'blocked_waiting_approval' }
    }
    if (input.currentConversationRunSummary.isActive) {
      return { kind: 'blocked_active' }
    }
    const messages = this.snapshot.chatMessages
    if (messages.length === 0) {
      return { kind: 'empty' }
    }

    // Captured once, matching the pre-C2 closure semantics: the awaited
    // compaction below must keep targeting the conversation (and its maps
    // and preferences) it started in — the user may load another
    // conversation while the await is in flight.
    const conversationId = this.snapshot.currentConversationId
    const compactionHistoryAtStart = this.effectiveCompactionState(messages)
    const prefs = this.preferencesController.getSnapshot()
    const messageModelMapAtStart = this.snapshot.messageModelMap
    const activeBranchAtStart = this.snapshot.activeBranchByUserMessageId
    const boundaryIdsAtStart = this.snapshot.assistantGroupBoundaryMessageIds

    try {
      this.setPendingCompactionAnchorMessageId(messages.at(-1)?.id ?? null)
      const nextCompactionState = await this.deps.compactConversation(messages)
      // The pending anchor belongs to the originating conversation's working
      // copy — leave the snapshot alone if the user switched away meanwhile.
      if (this.snapshot.currentConversationId === conversationId) {
        this.setPendingCompactionAnchorMessageId(null)
      }

      if (!nextCompactionState) {
        return { kind: 'empty' }
      }

      const nextCompactionHistory = [
        ...compactionHistoryAtStart,
        nextCompactionState,
      ]

      this.deps
        .getAgentService()
        .replaceConversationMessages(
          conversationId,
          messages,
          nextCompactionHistory,
        )

      // Intentionally mirrors the pre-C2 behavior exactly: raw `chatMode`
      // here, not `chatModeForSave(persistedChatMode)` like `persist()` uses
      // — an existing discrepancy carried over unchanged, not something
      // introduced by this move.
      const effectiveOverrides = {
        ...(prefs.conversationOverrides ?? {}),
        chatMode: prefs.chatMode,
        agentYoloEnabled: prefs.yoloEnabled,
      }
      await this.deps.createOrUpdateConversationImmediately(
        conversationId,
        messages,
        effectiveOverrides,
        prefs.conversationModelId,
        this.serializeMessageModelMap(messages, messageModelMapAtStart),
        this.serializeActiveBranchByUserMessageId(
          messages,
          activeBranchAtStart,
        ),
        this.preferencesController.conversationReasoningLevelRef.current.get(
          conversationId,
        ) ?? prefs.reasoningLevel,
        nextCompactionHistory,
        this.normalizeAssistantGroupBoundaryMessageIds(
          messages,
          boundaryIdsAtStart,
        ),
      )
      return { kind: 'compacted' }
    } catch (error) {
      if (this.snapshot.currentConversationId === conversationId) {
        this.setPendingCompactionAnchorMessageId(null)
      }
      console.error('Failed to compact conversation context', error)
      return { kind: 'failed', error }
    }
  }

  /** Equivalent to `handleAssistantMessageGroupRetry`
   * (`useChatDomainActions.ts`). */
  retryAssistantMessageGroup(messageIds: string[]): ChatSessionRetryResult {
    const groupedChatMessages = groupAssistantAndToolMessages(
      this.snapshot.chatMessages,
      this.snapshot.assistantGroupBoundaryMessageIds,
    )
    const retryPayload = buildRetrySubmissionMessages({
      sourceMessages: this.snapshot.chatMessages,
      groupedChatMessages,
      targetMessageIds: messageIds,
      activeBranchByUserMessageId: this.snapshot.activeBranchByUserMessageId,
    })
    if (!retryPayload) {
      return { kind: 'failed' }
    }

    const {
      sourceUserMessageId,
      inputChatMessages,
      requestChatMessages,
      branchTarget,
    } = retryPayload
    const nextAssistantGroupBoundaryMessageIds =
      this.normalizeAssistantGroupBoundaryMessageIds(
        inputChatMessages,
        this.snapshot.assistantGroupBoundaryMessageIds,
      )
    this.setAssistantGroupBoundaryMessageIds(
      nextAssistantGroupBoundaryMessageIds,
    )

    const nextActiveBranchByUserMessageId = new Map(
      this.snapshot.activeBranchByUserMessageId,
    )
    if (branchTarget) {
      nextActiveBranchByUserMessageId.set(
        sourceUserMessageId,
        branchTarget.branchId,
      )
    } else {
      nextActiveBranchByUserMessageId.delete(sourceUserMessageId)
    }
    this.setActiveBranchByUserMessageId(nextActiveBranchByUserMessageId)

    void this.runNormalSubmission({
      inputChatMessages,
      requestChatMessages,
      retryBranchTarget: branchTarget
        ? { ...branchTarget, sourceUserMessageId }
        : undefined,
    })
    return { kind: 'submitted' }
  }

  /** Equivalent to `handleAssistantErrorContinue`
   * (`useChatDomainActions.ts`). The pending-guard (`assistantContinuationPendingRef`
   * there) is now a plain private field — no React ref needed once this
   * lives outside a component. */
  continueAssistantError(
    assistantMessageId: string,
  ): ChatSessionContinueErrorResult {
    if (this.assistantContinuationPending) {
      return { kind: 'pending' }
    }
    const groupedChatMessages = groupAssistantAndToolMessages(
      this.snapshot.chatMessages,
      this.snapshot.assistantGroupBoundaryMessageIds,
    )
    const payload = buildAssistantErrorContinuation({
      sourceMessages: this.snapshot.chatMessages,
      groupedChatMessages,
      assistantMessageId,
      activeBranchByUserMessageId: this.snapshot.activeBranchByUserMessageId,
    })
    if (!payload) {
      return { kind: 'failed' }
    }

    this.deps.forceScrollToBottom()
    this.assistantContinuationPending = true
    this.deps.runConversation(
      {
        chatMessages: payload.inputChatMessages,
        requestMessages: payload.requestChatMessages,
        conversationId: this.snapshot.currentConversationId,
        reasoningLevel: this.resolveReasoningLevelForMessages(
          payload.requestChatMessages,
        ),
        assistantContinuation: {
          assistantMessageId: payload.assistantMessageId,
          sourceUserMessageId: payload.sourceUserMessageId,
          modelId: payload.modelId,
          branchId: payload.branchId,
          branchLabel: payload.branchLabel,
        },
      },
      {
        onSettled: () => {
          this.assistantContinuationPending = false
        },
      },
    )
    return { kind: 'started' }
  }

  /** Equivalent to `handleContinueResponse` (`useChatDomainActions.ts`). */
  continueResponse(): void {
    const latestMessage = this.snapshot.chatMessages.at(-1)
    this.deps.runConversation({
      chatMessages: this.snapshot.chatMessages,
      conversationId: this.snapshot.currentConversationId,
      reasoningLevel: this.resolveReasoningLevelForMessages(
        this.snapshot.chatMessages,
      ),
      modelIds:
        latestMessage?.role === 'user'
          ? latestMessage.selectedModelIds
          : undefined,
    })
  }

  /** Equivalent to `handleRecoverAnswerUserQuestion`
   * (`useChatDomainActions.ts`) — recovery path for `ask_user_question` when
   * no live run remains to pick the resolved messages back up. */
  recoverAnswerUserQuestion(resolvedMessages: ChatMessage[]): void {
    const conversationId = this.snapshot.currentConversationId
    this.setChatMessages(resolvedMessages)
    this.deps
      .getAgentService()
      .replaceConversationMessages(
        conversationId,
        resolvedMessages,
        this.effectiveCompactionState(resolvedMessages),
        { persistState: true },
      )
    void this.persistImmediately(resolvedMessages)
    this.deps.runConversation({
      chatMessages: resolvedMessages,
      conversationId,
      reasoningLevel: this.resolveReasoningLevelForMessages(resolvedMessages),
      modelIds: this.getLatestUserSelectedModelIds(resolvedMessages),
    })
  }
}
