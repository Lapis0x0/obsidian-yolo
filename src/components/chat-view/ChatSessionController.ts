import { v4 as uuidv4 } from 'uuid'

import type {
  AgentConversationState,
  AgentService,
} from '../../core/agent/service'
import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatConversationCompactionState,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { ReasoningLevel } from '../../types/reasoning'
import { groupAssistantAndToolMessages } from '../../utils/chat/message-groups'

import type { ChatMode } from './chat-input/ChatModeSelect'
import type { SetStateActionLike } from './ConversationPreferencesController'
import { ConversationPreferencesController } from './ConversationPreferencesController'

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
export type ChatSessionPersistOutcome =
  | { kind: 'deleted' }
  | { kind: 'persisted'; ok: Promise<boolean> }

export type ChatSessionControllerDeps = {
  /**
   * Long-lived object — read the current AgentService through a getter
   * rather than caching it, matching CLAUDE.md's "Runtime Boundaries" rule
   * for every other controller in this directory.
   */
  getAgentService: () => Pick<
    AgentService,
    'subscribe' | 'getState' | 'replaceConversationMessages'
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
  deleteConversation: (id: string) => Promise<void>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  /**
   * `chatModeForSave` is an identity function today (see
   * `chat-input/ChatModeSelect.tsx`) but is kept as an injected seam rather
   * than inlined so every write-back call site stays greppable, matching the
   * intent documented at its definition.
   */
  chatModeForSave: (mode: ChatMode) => ChatMode
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

  private buildAssistantGroupBoundaryMessageIdsAfterUserRemoval(
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

  private persist(
    messages: ChatMessage[],
    assistantGroupBoundaryIdsOverride?: readonly string[],
  ): Promise<boolean> {
    if (messages.length === 0) return Promise.resolve(true)
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

    if (nextMessages.length === 0) {
      void this.deps.deleteConversation(this.snapshot.currentConversationId)
      return { removedMessages, outcome: { kind: 'deleted' } }
    }

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

    if (nextMessages.length === 0) {
      void this.deps.deleteConversation(this.snapshot.currentConversationId)
      return { removedMessages, outcome: { kind: 'deleted' } }
    }

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
}
