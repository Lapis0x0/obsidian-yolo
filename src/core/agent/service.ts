import { v4 as uuidv4 } from 'uuid'

import type { YoloSettings } from '../../settings/schema/setting.types'
import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatExternalAgentResultMessage,
  ChatMessage,
  ChatUserMessage,
  normalizeChatConversationCompactionState,
} from '../../types/chat'
import {
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { formatErrorMessageWithCauses } from '../../utils/error-message'
import { captureLLMDebugOperation } from '../llm/debugCapture'

import { DEFAULT_BRANCH_ID } from './branch'
import { CitationRegistry } from './citationRegistry'
import type { AsyncTaskRecord } from './external-cli/async-task-registry'
import type { ExternalCliEvent } from './external-cli/streamBus'
import { NativeAgentRuntime } from './native-runtime'
import {
  AgentRunContext,
  AgentRuntimeLoopConfig,
  AgentRuntimeRunInput,
} from './types'

export type AgentRunStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'aborted'
  | 'error'

export type AgentConversationState = {
  conversationId: string
  status: AgentRunStatus
  runId?: number
  messages: ChatMessage[]
  compaction?: ChatConversationCompactionState
  pendingCompactionAnchorMessageId?: string | null
  anchorMessageId?: string
  errorMessage?: string
}

export type AgentConversationStateSubscriber = (
  state: AgentConversationState,
) => void

export type AgentConversationStateFeedSubscriber = (
  state: AgentConversationState,
) => void

export type AgentConversationRunSummary = {
  conversationId: string
  status: AgentRunStatus
  isRunning: boolean
  /**
   * True when the run is blocked on either a pending tool approval OR an
   * `ask_user_question` awaiting the user's answer. Kept as a single field so
   * existing UI gates (stop-button, queue text, etc.) cover both cases.
   */
  isWaitingApproval: boolean
  /**
   * Narrower flag: only `ask_user_question` is pending. Used by Chat.tsx to
   * intercept submits regardless of whether the run state is still `running`
   * (the run may have already finalized, leaving only the awaiting tool call).
   */
  isWaitingUserInput: boolean
}

export type AgentConversationRunSummarySubscriber = (
  summaries: Map<string, AgentConversationRunSummary>,
) => void

type ConversationEntry = {
  state: AgentConversationState
  subscribers: Set<AgentConversationStateSubscriber>
  baseMessages: ChatMessage[]
  persistState: boolean
}

type AgentRunEntry = {
  conversationId: string
  branchId: string
  sourceUserMessageId?: string
  runtime: NativeAgentRuntime | null
  state: AgentConversationState
  nextRunId: number
  runToken: symbol | null
  lastRunInput: AgentRuntimeRunInput | null
  lastLoopConfig: AgentRuntimeLoopConfig | null
  // Holds the citationRegistry for the run currently associated with this
  // entry, so manual-approval/recovery paths (which call mcpManager.callTool
  // directly, bypassing the loop-worker) can attach citations the same way
  // auto-executed tool calls do.
  lastRunContext: AgentRunContext | null
}

type AgentServiceOptions = {
  getSettings?: () => YoloSettings
  persistConversationMessages?: (payload: {
    conversationId: string
    messages: ChatMessage[]
    compaction?: ChatConversationCompactionState
    status: AgentRunStatus
    touchUpdatedAt?: boolean
  }) => Promise<void>
}

export type AgentReplaceConversationMessagesReason =
  | 'mutation'
  | 'hydrate'
  | 'self-heal'

function buildExternalAgentResultMessage(
  record: AsyncTaskRecord,
): ChatExternalAgentResultMessage {
  const completedAt = record.completedAt ?? Date.now()
  return {
    role: 'external_agent_result',
    id: uuidv4(),
    taskId: record.taskId,
    source: record.source,
    provider: record.provider,
    title: record.title,
    status: record.status === 'running' ? 'completed' : record.status,
    exitCode: record.exitCode,
    stdout: record.stdoutBuffer,
    stderr: record.stderrBuffer,
    durationMs: completedAt - record.createdAt,
    delegateAssistantMessageId:
      record.source.type === 'llm_tool_call'
        ? record.source.assistantMessageId
        : '',
    delegateToolCallId:
      record.source.type === 'llm_tool_call' ? record.source.toolCallId : '',
  }
}

const reconcileAssistantGenerationState = (
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
): ChatMessage[] => {
  const previousToolResponseMap = new Map<string, ToolCallResponse['status']>(
    previousMessages.flatMap((message) => {
      if (message.role !== 'tool') {
        return []
      }

      return message.toolCalls.map((toolCall) => [
        toolCall.request.id,
        toolCall.response.status,
      ])
    }),
  )

  const previousAssistantStateMap = new Map(
    previousMessages
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.id, message.metadata?.generationState]),
  )

  return nextMessages.map((message) => {
    if (message.role === 'tool') {
      let updated = false
      const nextToolCalls = message.toolCalls.map((toolCall) => {
        const previousStatus = previousToolResponseMap.get(toolCall.request.id)
        if (
          previousStatus !== ToolCallResponseStatus.Aborted ||
          toolCall.response.status === ToolCallResponseStatus.Aborted
        ) {
          return toolCall
        }

        updated = true
        return {
          ...toolCall,
          response: { status: ToolCallResponseStatus.Aborted as const },
        }
      })

      return updated
        ? {
            ...message,
            toolCalls: nextToolCalls,
          }
        : message
    }

    if (message.role !== 'assistant') {
      return message
    }

    const previousGenerationState = previousAssistantStateMap.get(message.id)
    if (
      previousGenerationState === 'aborted' &&
      message.metadata?.generationState === 'streaming'
    ) {
      return {
        ...message,
        metadata: {
          ...message.metadata,
          generationState: 'aborted',
        },
      }
    }

    return message
  })
}

const abortVisibleMessages = (messages: ChatMessage[]): ChatMessage[] => {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      if (message.metadata?.generationState !== 'streaming') {
        return message
      }

      return {
        ...message,
        metadata: {
          ...message.metadata,
          generationState: 'aborted',
        },
      }
    }

    if (message.role !== 'tool') {
      return message
    }

    let updated = false
    const nextToolCalls = message.toolCalls.map((toolCall) => {
      if (
        toolCall.response.status !== ToolCallResponseStatus.PendingApproval &&
        toolCall.response.status !== ToolCallResponseStatus.Running &&
        toolCall.response.status !== ToolCallResponseStatus.AwaitingUserInput
      ) {
        return toolCall
      }

      updated = true
      return {
        ...toolCall,
        response: { status: ToolCallResponseStatus.Aborted as const },
      }
    })

    return updated
      ? {
          ...message,
          toolCalls: nextToolCalls,
        }
      : message
  })
}

const mergeVisibleMessages = (
  previousVisibleMessages: ChatMessage[],
  baseMessages: ChatMessage[],
  anchorMessageId: string | undefined,
  responseMessages: ChatMessage[],
): ChatMessage[] => {
  if (!anchorMessageId) {
    return reconcileAssistantGenerationState(
      previousVisibleMessages,
      responseMessages,
    )
  }

  const anchorIndex = baseMessages.findIndex(
    (message) => message.id === anchorMessageId,
  )

  if (anchorIndex === -1) {
    return reconcileAssistantGenerationState(
      previousVisibleMessages,
      responseMessages,
    )
  }

  return reconcileAssistantGenerationState(previousVisibleMessages, [
    ...baseMessages.slice(0, anchorIndex + 1),
    ...responseMessages,
  ])
}

const hasPendingApproval = (messages: ChatMessage[]): boolean => {
  return messages.some(
    (message) =>
      message.role === 'tool' &&
      message.toolCalls.some(
        (toolCall) =>
          toolCall.response.status === ToolCallResponseStatus.PendingApproval,
      ),
  )
}

const hasAwaitingUserInput = (messages: ChatMessage[]): boolean => {
  return messages.some(
    (message) =>
      message.role === 'tool' &&
      message.toolCalls.some(
        (toolCall) =>
          toolCall.response.status === ToolCallResponseStatus.AwaitingUserInput,
      ),
  )
}

const hasPendingUserInteraction = (messages: ChatMessage[]): boolean => {
  return hasPendingApproval(messages) || hasAwaitingUserInput(messages)
}

const isTrailingResolvedToolMessage = (
  messages: ChatMessage[],
  toolMessageId: string,
): boolean => {
  const last = messages.at(-1)
  if (!last || last.id !== toolMessageId || last.role !== 'tool') {
    return false
  }
  return last.toolCalls.every((toolCall) =>
    TOOL_CALL_TERMINAL_STATUSES.includes(toolCall.response.status),
  )
}

const patchAwaitingUserInputInMessages = (
  messages: ChatMessage[],
  toolCallId: string,
  response: ToolCallResponse,
): {
  toolMessageId: string | null
  updatedMessages: ChatMessage[]
  didPatch: boolean
  wasAwaiting: boolean
} => {
  let toolMessageId: string | null = null
  let didPatch = false
  let wasAwaiting = false
  const updatedMessages = messages.map((message) => {
    if (message.role !== 'tool') return message
    let messageUpdated = false
    const nextToolCalls = message.toolCalls.map((toolCall) => {
      if (toolCall.request.id !== toolCallId) return toolCall
      didPatch = true
      toolMessageId = message.id
      wasAwaiting =
        toolCall.response.status === ToolCallResponseStatus.AwaitingUserInput
      messageUpdated = true
      return { ...toolCall, response }
    })
    return messageUpdated ? { ...message, toolCalls: nextToolCalls } : message
  })
  return { toolMessageId, updatedMessages, didPatch, wasAwaiting }
}

const getRunKey = (conversationId: string, branchId?: string): string => {
  return `${conversationId}::${branchId ?? DEFAULT_BRANCH_ID}`
}

const isAssistantOrToolMessage = (
  message: ChatMessage,
): message is Extract<ChatMessage, { role: 'assistant' | 'tool' }> => {
  return message.role === 'assistant' || message.role === 'tool'
}

// Mirrors NativeAgentRuntime.shouldUseSingleTurnFastPath. A fast-path run does
// not call drainPendingUserMessages (no llm_request boundary), so queued
// messages can never be consumed inside that run. Treat fast-path runs as
// "not enqueueable" and skip after-run continuation that would otherwise loop
// forever re-launching fast-path runs that ignore the queue.
const isFastPathLoopConfig = (config: AgentRuntimeLoopConfig): boolean => {
  return !config.enableTools && config.maxAutoIterations <= 1
}

const matchesBranchMessage = (
  message: ChatMessage,
  sourceUserMessageId: string,
  branchId: string,
): boolean => {
  return (
    isAssistantOrToolMessage(message) &&
    message.metadata?.sourceUserMessageId === sourceUserMessageId &&
    message.metadata?.branchId === branchId
  )
}

const buildBranchAggregateMessages = ({
  baseMessages,
  branchState,
  branchId,
  sourceUserMessageId,
}: {
  baseMessages: ChatMessage[]
  branchState: AgentConversationState
  branchId: string
  sourceUserMessageId?: string
}): ChatMessage[] => {
  if (!sourceUserMessageId) {
    return branchState.messages
  }

  const anchorIndex = branchState.messages.findIndex(
    (message) => message.id === sourceUserMessageId,
  )
  const responseMessages =
    anchorIndex >= 0
      ? branchState.messages.slice(anchorIndex + 1)
      : branchState.messages
  const userIndex = baseMessages.findIndex(
    (message) => message.id === sourceUserMessageId,
  )
  if (userIndex === -1) {
    return [...baseMessages, ...responseMessages]
  }

  let groupEndIndex = userIndex + 1
  while (groupEndIndex < baseMessages.length) {
    const currentMessage = baseMessages[groupEndIndex]
    if (currentMessage.role === 'user') {
      break
    }
    const currentSourceUserMessageId =
      currentMessage.role === 'external_agent_result'
        ? undefined
        : currentMessage.metadata?.sourceUserMessageId
    if (currentSourceUserMessageId !== sourceUserMessageId) {
      break
    }
    groupEndIndex += 1
  }

  if (branchId === DEFAULT_BRANCH_ID) {
    return [
      ...baseMessages.slice(0, groupEndIndex),
      ...responseMessages,
      ...baseMessages.slice(groupEndIndex),
    ]
  }

  const existingGroupMessages = baseMessages.slice(userIndex + 1, groupEndIndex)
  const targetBranchStartIndex = existingGroupMessages.findIndex((message) =>
    matchesBranchMessage(message, sourceUserMessageId, branchId),
  )

  if (responseMessages.length === 0) {
    const branchWaitingApproval = hasPendingUserInteraction(
      branchState.messages,
    )
    return [
      ...baseMessages.slice(0, userIndex + 1),
      ...existingGroupMessages.map((message) => {
        if (
          !isAssistantOrToolMessage(message) ||
          !matchesBranchMessage(message, sourceUserMessageId, branchId)
        ) {
          return message
        }

        return {
          ...message,
          metadata: {
            ...message.metadata,
            branchRunStatus: branchState.status,
            branchWaitingApproval,
          },
        }
      }),
      ...baseMessages.slice(groupEndIndex),
    ]
  }

  const preservedGroupMessages = existingGroupMessages.filter(
    (message) => !matchesBranchMessage(message, sourceUserMessageId, branchId),
  )
  const insertionIndex =
    targetBranchStartIndex >= 0
      ? Math.min(targetBranchStartIndex, preservedGroupMessages.length)
      : preservedGroupMessages.length

  return [
    ...baseMessages.slice(0, userIndex + 1),
    ...preservedGroupMessages.slice(0, insertionIndex),
    ...responseMessages,
    ...preservedGroupMessages.slice(insertionIndex),
    ...baseMessages.slice(groupEndIndex),
  ]
}

export type PendingExternalAgentResultsSubscriber = (
  conversationId: string,
) => void

export type EnqueueUserMessageResult =
  | 'enqueued'
  | 'idle'
  | 'blocked_awaiting_approval'

/**
 * Terminal tool-call statuses. The agent run loop and `approveToolCall` /
 * `answerUserQuestion` use this set to decide whether the trailing tool
 * message is fully resolved (so a fresh LLM turn can be triggered). All four
 * are emitted as valid `tool_result` payloads by `requestContextBuilder`.
 */
const TOOL_CALL_TERMINAL_STATUSES: ToolCallResponse['status'][] = [
  ToolCallResponseStatus.Success,
  ToolCallResponseStatus.Error,
  ToolCallResponseStatus.Rejected,
  ToolCallResponseStatus.Aborted,
]

export type AnswerUserQuestionAnswer = {
  id: string
  question: string
  inputType: 'free_text' | 'single_select' | 'multi_select'
  value: string | string[]
  /**
   * Free-text content the user typed into the auto-appended "Other" escape
   * hatch. Present only when `value` is (or contains) the reserved
   * `__other__` id; absent otherwise. The model should read this alongside
   * `value` to recover what the user actually meant.
   */
  otherText?: string
}

export type AnswerUserQuestionPayload = {
  type: 'user_answers'
  answers: AnswerUserQuestionAnswer[]
}

export type AnswerUserQuestionOutcome =
  | { kind: 'continued' }
  | { kind: 'recorded' }
  | { kind: 'needs_recovery'; resolvedMessages: ChatMessage[] }
  | { kind: 'not_found' }
  | { kind: 'not_awaiting' }

export type AbortedQueuedMessagesSubscriber = (
  conversationId: string,
  messages: ChatUserMessage[],
) => void

export class AgentService {
  private conversationEntries = new Map<string, ConversationEntry>()
  private runEntriesByKey = new Map<string, AgentRunEntry>()
  private summarySubscribers = new Set<AgentConversationRunSummarySubscriber>()
  private stateFeedSubscribers = new Set<AgentConversationStateFeedSubscriber>()
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** pending external agent results per conversation (queued while streaming) */
  private pendingExternalAgentResults = new Map<string, AsyncTaskRecord[]>()
  private pendingResultsSubscribers =
    new Set<PendingExternalAgentResultsSubscriber>()
  private unsubscribeTaskCompleted: (() => void) | null = null
  // Generation token: incremented on each start/stop so a late-resolving lazy
  // import can detect that it was superseded and bail out.
  private listenerStartId = 0
  // Conversations that have notified subscribers about an auto-run trigger but
  // whose run hasn't yet flipped `isRunning` to true. Prevents duplicate
  // auto-runs when multiple task-completed events arrive in the gap between
  // `submitChatMutation.mutate` and `agentService.run` actually starting.
  private autoRunScheduled = new Set<string>()
  /**
   * Mid-run user messages queued per run key (conversationId+branchId), waiting
   * to be injected at the next `llm_request` boundary by the runtime, or used
   * to drive an after-run continuation when the current run finishes.
   */
  private pendingUserMessagesByKey = new Map<string, ChatUserMessage[]>()
  /**
   * Latch preventing duplicate after-run continuations for the same run key
   * while the microtask spawning the next `run()` is still pending.
   */
  private continuationScheduledByKey = new Set<string>()
  private abortedQueuedMessagesSubscribers =
    new Set<AbortedQueuedMessagesSubscriber>()

  constructor(private readonly options: AgentServiceOptions = {}) {}

  /**
   * Enqueue a user message to be injected mid-run at the next safe LLM
   * boundary. v1 only supports the default branch; calls for non-default
   * branches return 'idle' so the caller falls through to the normal run path.
   */
  enqueueUserMessage(
    conversationId: string,
    message: ChatUserMessage,
    branchId?: string,
  ): EnqueueUserMessageResult {
    const effectiveBranchId = branchId ?? DEFAULT_BRANCH_ID
    if (effectiveBranchId !== DEFAULT_BRANCH_ID) {
      return 'idle'
    }
    const runKey = getRunKey(conversationId, effectiveBranchId)
    const runEntry = this.runEntriesByKey.get(runKey)
    if (!runEntry || runEntry.state.status !== 'running') {
      return 'idle'
    }
    if (
      runEntry.lastLoopConfig &&
      isFastPathLoopConfig(runEntry.lastLoopConfig)
    ) {
      // Fast-path runs have no llm_request boundary to drain at. Fall through
      // to the normal submit path so the caller starts a fresh run instead.
      return 'idle'
    }
    if (hasPendingUserInteraction(runEntry.state.messages)) {
      return 'blocked_awaiting_approval'
    }

    const queue = this.pendingUserMessagesByKey.get(runKey) ?? []
    queue.push(message)
    this.pendingUserMessagesByKey.set(runKey, queue)
    this.notifyConversationSubscribers(conversationId)
    return 'enqueued'
  }

  /**
   * Peek at currently queued mid-run user messages for the conversation's
   * default branch run. Returns an empty array if nothing is queued.
   */
  peekPendingUserMessages(
    conversationId: string,
    branchId?: string,
  ): ChatUserMessage[] {
    const runKey = getRunKey(conversationId, branchId ?? DEFAULT_BRANCH_ID)
    return [...(this.pendingUserMessagesByKey.get(runKey) ?? [])]
  }

  /**
   * Subscribe to abort events that carry the queued user messages dropped at
   * abort time, so the UI can restore them into the input box.
   */
  subscribeToAbortedQueuedMessages(
    fn: AbortedQueuedMessagesSubscriber,
  ): () => void {
    this.abortedQueuedMessagesSubscribers.add(fn)
    return () => {
      this.abortedQueuedMessagesSubscribers.delete(fn)
    }
  }

  /** Subscribe to be notified when pending external agent results are ready to drain */
  subscribeToPendingExternalAgentResults(
    fn: PendingExternalAgentResultsSubscriber,
  ): () => void {
    this.pendingResultsSubscribers.add(fn)
    return () => {
      this.pendingResultsSubscribers.delete(fn)
    }
  }

  /**
   * Start listening for task-completed events from the external CLI stream bus.
   * Call once after construction (desktop-only, called lazily).
   */
  startExternalAgentResultListener(): void {
    if (this.unsubscribeTaskCompleted) return
    const myStartId = ++this.listenerStartId
    // Lazy import to avoid importing desktop-only module on mobile
    void import('./external-cli/streamBus').then(({ externalCliStreamBus }) => {
      // Bail out if stop was called (or another start invalidated us) before
      // the dynamic import resolved.
      if (myStartId !== this.listenerStartId) return
      this.unsubscribeTaskCompleted =
        externalCliStreamBus.subscribeTaskCompleted(
          (event: Extract<ExternalCliEvent, { type: 'task-completed' }>) => {
            this.handleTaskCompleted(event.record)
          },
        )
    })
  }

  stopExternalAgentResultListener(): void {
    // Bump generation to invalidate any in-flight lazy import.
    this.listenerStartId++
    this.unsubscribeTaskCompleted?.()
    this.unsubscribeTaskCompleted = null
  }

  private handleTaskCompleted(record: AsyncTaskRecord): void {
    const { conversationId } = record
    const isRunning = this.isRunning(conversationId)
    const autoRunPending = this.autoRunScheduled.has(conversationId)

    if (isRunning || autoRunPending) {
      // Queue: the next finalize will drain it and emit a single auto-run.
      const queue = this.pendingExternalAgentResults.get(conversationId) ?? []
      queue.push(record)
      this.pendingExternalAgentResults.set(conversationId, queue)
    } else {
      // Idle and no auto-run scheduled: append immediately and notify.
      this.autoRunScheduled.add(conversationId)
      this.appendExternalAgentResultRecord(conversationId, record)
      this.notifyPendingResultsSubscribers(conversationId)
    }
  }

  private appendExternalAgentResultRecord(
    conversationId: string,
    record: AsyncTaskRecord,
  ): void {
    const msg = buildExternalAgentResultMessage(record)
    const entry = this.getOrCreateConversationEntry(conversationId)
    const nextMessages = [...entry.state.messages, msg]
    entry.baseMessages = nextMessages
    entry.state = { ...entry.state, messages: nextMessages }
    this.notifyConversationSubscribers(conversationId)
  }

  /**
   * Drain any pending external agent results for the conversation.
   * Returns the appended messages (empty if nothing was queued).
   * Call this after a run completes (idle transition).
   */
  drainPendingExternalAgentResults(
    conversationId: string,
  ): ChatExternalAgentResultMessage[] {
    const queue = this.pendingExternalAgentResults.get(conversationId)
    if (!queue || queue.length === 0) return []

    // Sort by completedAt ascending
    queue.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
    this.pendingExternalAgentResults.delete(conversationId)

    const appended: ChatExternalAgentResultMessage[] = []
    for (const record of queue) {
      const msg = buildExternalAgentResultMessage(record)
      appended.push(msg)
    }

    const entry = this.getOrCreateConversationEntry(conversationId)
    const nextMessages = [...entry.state.messages, ...appended]
    entry.baseMessages = nextMessages
    entry.state = { ...entry.state, messages: nextMessages }
    this.notifyConversationSubscribers(conversationId)

    return appended
  }

  hasPendingExternalAgentResults(conversationId: string): boolean {
    return (
      (this.pendingExternalAgentResults.get(conversationId)?.length ?? 0) > 0
    )
  }

  private notifyPendingResultsSubscribers(conversationId: string): void {
    for (const fn of this.pendingResultsSubscribers) {
      fn(conversationId)
    }
  }

  subscribe(
    conversationId: string,
    callback: AgentConversationStateSubscriber,
    options?: { emitCurrent?: boolean },
  ): () => void {
    const entry = this.getOrCreateConversationEntry(conversationId)
    entry.subscribers.add(callback)

    if (options?.emitCurrent ?? true) {
      callback(this.cloneState(entry.state))
    }

    return () => {
      this.conversationEntries.get(conversationId)?.subscribers.delete(callback)
    }
  }

  getState(conversationId: string): AgentConversationState {
    return this.cloneState(
      this.getOrCreateConversationEntry(conversationId).state,
    )
  }

  getConversationRunSummary(
    conversationId: string,
  ): AgentConversationRunSummary {
    const state = this.getOrCreateConversationEntry(conversationId).state
    return this.buildRunSummary(state)
  }

  getActiveConversationRunSummaries(): Map<
    string,
    AgentConversationRunSummary
  > {
    const summaries = new Map<string, AgentConversationRunSummary>()
    for (const [conversationId, entry] of this.conversationEntries.entries()) {
      const summary = this.buildRunSummary(entry.state)
      if (summary.isRunning || summary.isWaitingApproval) {
        summaries.set(conversationId, summary)
      }
    }
    return summaries
  }

  subscribeToRunSummaries(
    callback: AgentConversationRunSummarySubscriber,
  ): () => void {
    this.summarySubscribers.add(callback)
    callback(this.getActiveConversationRunSummaries())

    return () => {
      this.summarySubscribers.delete(callback)
    }
  }

  subscribeToConversationStates(
    callback: AgentConversationStateFeedSubscriber,
    options?: { emitCurrent?: boolean },
  ): () => void {
    this.stateFeedSubscribers.add(callback)

    if (options?.emitCurrent ?? true) {
      for (const entry of this.conversationEntries.values()) {
        callback(this.cloneState(entry.state))
      }
    }

    return () => {
      this.stateFeedSubscribers.delete(callback)
    }
  }

  isRunning(conversationId: string): boolean {
    return (
      this.getOrCreateConversationEntry(conversationId).state.status ===
      'running'
    )
  }

  replaceConversationMessages(
    conversationId: string,
    messages: ChatMessage[],
    compaction?: ChatConversationCompactionLike | null,
    options?: {
      persistState?: boolean
      reason?: AgentReplaceConversationMessagesReason
    },
  ): void {
    const entry = this.getOrCreateConversationEntry(conversationId)
    if (typeof options?.persistState === 'boolean') {
      entry.persistState = options.persistState
    }
    entry.baseMessages = [...messages]
    entry.state = {
      ...entry.state,
      messages: [...messages],
      compaction: this.normalizeCompaction(
        compaction === undefined ? entry.state.compaction : compaction,
        messages,
      ),
      status: this.runEntriesForConversation(conversationId).some(
        (runEntry) => runEntry.state.status === 'running',
      )
        ? 'running'
        : entry.state.status,
    }
    this.notifyConversationSubscribers(conversationId, options?.reason)
  }

  async approveToolCall({
    conversationId,
    toolCallId,
    allowForConversation = false,
  }: {
    conversationId: string
    toolCallId: string
    allowForConversation?: boolean
  }): Promise<boolean> {
    const located = this.findToolCall(conversationId, toolCallId)
    if (!located?.runEntry.lastRunInput || !located.runEntry.lastLoopConfig) {
      return false
    }

    const { runEntry, toolMessage, toolCall } = located
    const lastRunInput = runEntry.lastRunInput
    const lastLoopConfig = runEntry.lastLoopConfig
    if (
      !lastRunInput ||
      !lastLoopConfig ||
      toolCall.response.status !== ToolCallResponseStatus.PendingApproval
    ) {
      return false
    }

    if (allowForConversation) {
      lastRunInput.mcpManager.allowToolForConversation(
        toolCall.request.name,
        conversationId,
        getToolCallArgumentsObject(toolCall.request.arguments),
      )
    }

    this.updateToolCallResponse({
      conversationId,
      toolCallId,
      response: { status: ToolCallResponseStatus.Running },
      status: 'running',
    })

    const toolArgs = getToolCallArgumentsObject(toolCall.request.arguments)
    const debugTraceId = this.findDebugTraceIdForToolCall(
      runEntry.state.messages,
      toolCall.request.id,
    )
    const result = await captureLLMDebugOperation({
      traceId: debugTraceId,
      signal: lastRunInput.abortSignal,
      transportMode: 'mcp',
      url: `mcp://${toolCall.request.name}`,
      method: 'callTool',
      requestBody: {
        name: toolCall.request.name,
        args: toolArgs,
        id: toolCall.request.id,
        conversationId,
        roundId: toolMessage.id,
        chatModelId: lastRunInput.model.id,
      },
      responseContentType: 'application/json',
      run: () =>
        lastRunInput.mcpManager.callTool({
          name: toolCall.request.name,
          args: toolArgs,
          id: toolCall.request.id,
          conversationId,
          conversationMessages: runEntry.state.messages,
          roundId: toolMessage.id,
          chatModelId: lastRunInput.model.id,
          workspaceScope: lastRunInput.workspaceScope,
          // Reuse the same registry the auto-execution path uses so citations
          // emitted by the approved tool are attached to the assistant message.
          runContext: runEntry.lastRunContext ?? undefined,
        }),
      getResponseBody: (response) => response,
    })

    const nextMessages = this.updateToolCallResponse({
      conversationId,
      toolCallId,
      response: result,
    })
    if (!nextMessages) {
      return false
    }

    const latestToolMessage = nextMessages.find(
      (message) => message.id === toolMessage.id,
    )
    if (
      latestToolMessage?.role === 'tool' &&
      nextMessages.at(-1)?.id === latestToolMessage.id &&
      latestToolMessage.toolCalls.every((currentToolCall) =>
        TOOL_CALL_TERMINAL_STATUSES.includes(currentToolCall.response.status),
      )
    ) {
      await this.run({
        conversationId,
        loopConfig: lastLoopConfig,
        input: {
          ...lastRunInput,
          messages: nextMessages,
        },
      })
    }

    return true
  }

  /**
   * Submit user-provided answers to an in-flight `ask_user_question` tool
   * call. Mirrors `approveToolCall` but skips the MCP execution path: the
   * answers themselves are the tool's "result". When the current run still
   * has a live `runEntry` (active run path), we continue the loop directly.
   * When the run has already finalized (recovery path), we hand control back
   * to the UI via the same callback used by `handleRecoverPendingToolCall`.
   */
  async answerUserQuestion({
    conversationId,
    toolCallId,
    payload,
  }: {
    conversationId: string
    toolCallId: string
    payload: AnswerUserQuestionPayload
  }): Promise<AnswerUserQuestionOutcome> {
    const successResponse: ToolCallResponse = {
      status: ToolCallResponseStatus.Success,
      data: {
        type: 'text',
        text: JSON.stringify(payload),
      },
    }

    // Active-run path: the awaiting tool call still lives inside an
    // AgentRunEntry. Commit through updateToolCallResponse so subscribers
    // see the status change and we can drive the loop forward.
    const located = this.findToolCall(conversationId, toolCallId)
    if (located) {
      if (
        located.toolCall.response.status !==
        ToolCallResponseStatus.AwaitingUserInput
      ) {
        return { kind: 'not_awaiting' }
      }

      const nextMessages = this.updateToolCallResponse({
        conversationId,
        toolCallId,
        response: successResponse,
      })
      if (!nextMessages) {
        return { kind: 'not_found' }
      }

      const isLastMessage = isTrailingResolvedToolMessage(
        nextMessages,
        located.toolMessage.id,
      )
      if (!isLastMessage) {
        return { kind: 'recorded' }
      }

      const { runEntry } = located
      if (runEntry.lastRunInput && runEntry.lastLoopConfig) {
        await this.run({
          conversationId,
          loopConfig: runEntry.lastLoopConfig,
          input: {
            ...runEntry.lastRunInput,
            messages: nextMessages,
          },
        })
        return { kind: 'continued' }
      }

      return { kind: 'needs_recovery', resolvedMessages: nextMessages }
    }

    // Recovery path: the run finalized before the user answered, so the
    // run entry has been cleaned up. The awaiting message lives only in the
    // conversation-level baseMessages. Patch it there, broadcast, and ask
    // the UI to drive the resume via submitChatMutation.
    const conversationEntry =
      this.conversationEntries.get(conversationId) ?? null
    if (!conversationEntry) {
      return { kind: 'not_found' }
    }

    const { toolMessageId, updatedMessages, didPatch, wasAwaiting } =
      patchAwaitingUserInputInMessages(
        conversationEntry.state.messages,
        toolCallId,
        successResponse,
      )

    if (!didPatch) {
      return { kind: 'not_found' }
    }
    if (!wasAwaiting) {
      return { kind: 'not_awaiting' }
    }

    conversationEntry.baseMessages = updatedMessages
    conversationEntry.state = {
      ...conversationEntry.state,
      messages: updatedMessages,
    }
    this.notifyConversationSubscribers(conversationId)

    const isLastMessage =
      toolMessageId !== null &&
      isTrailingResolvedToolMessage(updatedMessages, toolMessageId)

    if (!isLastMessage) {
      return { kind: 'recorded' }
    }
    return { kind: 'needs_recovery', resolvedMessages: updatedMessages }
  }

  /**
   * Cancel a pending ask_user_question prompt: flip the awaiting tool call
   * to Aborted and terminate the surrounding run. Handles both the active
   * run case (runtime still alive while the user is being prompted) and the
   * recovery case where the run already finalized while the panel was open.
   */
  cancelAskUserQuestion({
    conversationId,
    toolCallId,
  }: {
    conversationId: string
    toolCallId: string
  }): boolean {
    // Active-run path: the awaiting tool call still lives inside a runEntry.
    // Delegate to abortConversation so the runtime is aborted, run status
    // flipped to 'aborted', and queued user messages restored — mirroring
    // the global Stop button.
    const located = this.findToolCall(conversationId, toolCallId)
    if (located) {
      if (
        located.toolCall.response.status !==
        ToolCallResponseStatus.AwaitingUserInput
      ) {
        return false
      }
      return this.abortConversation(conversationId)
    }

    // Recovery path: the run finalized before the user answered. Patch the
    // awaiting tool call in conversation-level state to Aborted and notify.
    const conversationEntry = this.conversationEntries.get(conversationId)
    if (!conversationEntry) {
      return false
    }
    const { updatedMessages, didPatch, wasAwaiting } =
      patchAwaitingUserInputInMessages(
        conversationEntry.state.messages,
        toolCallId,
        { status: ToolCallResponseStatus.Aborted },
      )
    if (!didPatch || !wasAwaiting) {
      return false
    }
    conversationEntry.baseMessages = updatedMessages
    conversationEntry.state = {
      ...conversationEntry.state,
      messages: updatedMessages,
    }
    this.notifyConversationSubscribers(conversationId)
    return true
  }

  rejectToolCall({
    conversationId,
    toolCallId,
  }: {
    conversationId: string
    toolCallId: string
  }): boolean {
    return Boolean(
      this.updateToolCallResponse({
        conversationId,
        toolCallId,
        response: { status: ToolCallResponseStatus.Rejected },
      }),
    )
  }

  abortToolCall({
    conversationId,
    toolCallId,
  }: {
    conversationId: string
    toolCallId: string
  }): boolean {
    const located = this.findToolCall(conversationId, toolCallId)
    if (!located) {
      return false
    }
    located.runEntry.lastRunInput?.mcpManager.abortToolCall(toolCallId)
    return Boolean(
      this.updateToolCallResponse({
        conversationId,
        toolCallId,
        response: { status: ToolCallResponseStatus.Aborted },
      }),
    )
  }

  private attachSourcesToLatestAssistant(
    messages: ChatMessage[],
    registry: CitationRegistry,
  ): ChatMessage[] {
    if (registry.size === 0) {
      return messages
    }
    const sources = registry.toArray()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'assistant') {
        continue
      }
      const next = [...messages]
      next[index] = {
        ...message,
        metadata: {
          ...message.metadata,
          sources,
        },
      }
      return next
    }
    return messages
  }

  private findDebugTraceIdForToolCall(
    messages: ChatMessage[],
    toolCallId: string | undefined,
  ): string | undefined {
    if (!toolCallId) {
      return undefined
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'assistant') {
        continue
      }
      const matches = message.toolCallRequests?.some(
        (request) => request.id === toolCallId,
      )
      if (matches) {
        return message.metadata?.llmDebugTraceId
      }
    }

    return undefined
  }

  async run({
    conversationId,
    input,
    loopConfig,
    persistState,
  }: {
    conversationId: string
    input: AgentRuntimeRunInput
    loopConfig: AgentRuntimeLoopConfig
    persistState?: boolean
  }): Promise<void> {
    const conversationEntry = this.getOrCreateConversationEntry(conversationId)
    if (typeof persistState === 'boolean') {
      conversationEntry.persistState = persistState
    }

    const branchId = input.branchId ?? DEFAULT_BRANCH_ID
    const runKey = getRunKey(conversationId, branchId)
    const existingRunEntry = this.runEntriesByKey.get(runKey)
    if (
      existingRunEntry?.state.status === 'running' &&
      existingRunEntry.runtime
    ) {
      existingRunEntry.runtime.abort()
    }

    const runEntry = this.getOrCreateRunEntry({
      conversationId,
      branchId,
      sourceUserMessageId: input.sourceUserMessageId,
    })

    if (branchId === DEFAULT_BRANCH_ID) {
      conversationEntry.baseMessages = [...input.messages]
    }

    const runtime = new NativeAgentRuntime(loopConfig)
    const runToken = Symbol(`agent-run-${conversationId}-${branchId}`)
    const runId = runEntry.nextRunId
    runEntry.nextRunId += 1
    runEntry.runtime = runtime
    runEntry.runToken = runToken
    runEntry.lastRunInput = input
    runEntry.lastLoopConfig = loopConfig

    const citationRegistry = new CitationRegistry()
    const runContext: AgentRunContext = { citationRegistry }
    runEntry.lastRunContext = runContext

    const runtimeInput: AgentRuntimeRunInput = {
      ...input,
      runContext,
      drainPendingUserMessages: () => {
        const queue = this.pendingUserMessagesByKey.get(runKey)
        if (!queue || queue.length === 0) {
          return []
        }
        this.pendingUserMessagesByKey.delete(runKey)
        // Notify so the UI removes the "queued" bubble immediately; the
        // injected messages will materialize in the runtime snapshot next.
        this.notifyConversationSubscribers(conversationId)
        return queue
      },
    }
    // Clear the continuation latch now that the new run is actually starting.
    this.continuationScheduledByKey.delete(runKey)
    runEntry.sourceUserMessageId = input.sourceUserMessageId
    runEntry.state = {
      conversationId,
      status: 'running',
      runId,
      messages: [...input.messages],
      compaction: this.normalizeCompaction(input.compaction, input.messages),
      pendingCompactionAnchorMessageId: null,
      anchorMessageId: input.sourceUserMessageId ?? input.messages.at(-1)?.id,
    }
    this.recomputeConversationState(conversationId)

    const unsubscribe = runtime.subscribe((snapshot) => {
      const currentRunEntry = this.runEntriesByKey.get(runKey)
      if (!currentRunEntry || currentRunEntry.runToken !== runToken) {
        return
      }
      const mergedMessages = mergeVisibleMessages(
        currentRunEntry.state.messages,
        input.messages,
        currentRunEntry.state.anchorMessageId,
        snapshot.messages,
      )
      currentRunEntry.state = {
        ...currentRunEntry.state,
        messages: mergedMessages,
        compaction: this.normalizeCompaction(
          snapshot.compaction,
          mergedMessages,
        ),
        pendingCompactionAnchorMessageId:
          this.normalizePendingCompactionAnchorMessageId(
            snapshot.pendingCompactionAnchorMessageId,
            mergedMessages,
          ),
      }
      this.recomputeConversationState(conversationId)
    })

    try {
      await runtime.run(runtimeInput)

      const currentRunEntry = this.runEntriesByKey.get(runKey)
      if (!currentRunEntry || currentRunEntry.runToken !== runToken) {
        return
      }

      const nextMessages = this.attachSourcesToLatestAssistant(
        currentRunEntry.state.messages,
        citationRegistry,
      )

      currentRunEntry.state = {
        ...currentRunEntry.state,
        messages: nextMessages,
        status: input.abortSignal?.aborted ? 'aborted' : 'completed',
        pendingCompactionAnchorMessageId: null,
      }
      this.recomputeConversationState(conversationId)
    } catch (error) {
      const currentRunEntry = this.runEntriesByKey.get(runKey)
      if (!currentRunEntry || currentRunEntry.runToken !== runToken) {
        return
      }
      const aborted =
        input.abortSignal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      currentRunEntry.state = {
        ...currentRunEntry.state,
        status: aborted ? 'aborted' : 'error',
        pendingCompactionAnchorMessageId: null,
        errorMessage: aborted ? undefined : formatErrorMessageWithCauses(error),
      }
      this.recomputeConversationState(conversationId)
      if (!aborted) {
        throw error
      }
    } finally {
      unsubscribe()
      const currentRunEntry = this.runEntriesByKey.get(runKey)
      if (currentRunEntry && currentRunEntry.runToken === runToken) {
        currentRunEntry.runToken = null
        if (currentRunEntry.runtime === runtime) {
          currentRunEntry.runtime = null
        }
      }
      this.finalizeSettledConversationRuns(conversationId)
      this.maybeScheduleAfterRunContinuation({
        conversationId,
        branchId,
        runKey,
        lastRunInput: input,
        lastLoopConfig: loopConfig,
      })
    }
  }

  private maybeScheduleAfterRunContinuation({
    conversationId,
    branchId,
    runKey,
    lastRunInput,
    lastLoopConfig,
  }: {
    conversationId: string
    branchId: string
    runKey: string
    lastRunInput: AgentRuntimeRunInput
    lastLoopConfig: AgentRuntimeLoopConfig
  }): void {
    const queue = this.pendingUserMessagesByKey.get(runKey)
    if (!queue || queue.length === 0) {
      return
    }
    if (this.continuationScheduledByKey.has(runKey)) {
      return
    }
    if (lastRunInput.abortSignal?.aborted) {
      // Abort path is responsible for clearing the queue; do not continue.
      return
    }
    if (isFastPathLoopConfig(lastLoopConfig)) {
      // Defensive: enqueueUserMessage already rejects fast-path runs, but a
      // queued message could in principle reach here through other paths.
      // Skip continuation to avoid an infinite loop of fast-path runs that
      // never drain the queue.
      return
    }
    this.continuationScheduledByKey.add(runKey)

    queueMicrotask(() => {
      const pending = this.pendingUserMessagesByKey.get(runKey)
      if (!pending || pending.length === 0) {
        this.continuationScheduledByKey.delete(runKey)
        return
      }
      const conversationEntry = this.conversationEntries.get(conversationId)
      if (!conversationEntry) {
        this.continuationScheduledByKey.delete(runKey)
        return
      }
      const existingRunEntry = this.runEntriesByKey.get(runKey)
      if (existingRunEntry?.state.status === 'running') {
        // Another run already picked up; let it drain the queue at the next
        // llm_request boundary.
        this.continuationScheduledByKey.delete(runKey)
        return
      }

      const baselineMessages: ChatMessage[] = [
        ...conversationEntry.state.messages,
      ]
      // Keep the queue intact: the new run's drain callback (bound inside
      // run()) will pull the queue at its first llm_request boundary and merge
      // through the same snapshot → persist path used for mid-run injection.
      void this.run({
        conversationId,
        loopConfig: lastLoopConfig,
        input: {
          ...lastRunInput,
          messages: baselineMessages,
          requestMessages: baselineMessages,
          // The injected user messages become the new "anchor" of this run;
          // drop the prior sourceUserMessageId so the runtime treats this as a
          // fresh top-level turn rather than a branch continuation.
          sourceUserMessageId: undefined,
          branchId,
          abortSignal: undefined,
        },
      }).catch((error: unknown) => {
        console.error(
          '[YOLO] after-run continuation for queued user messages failed',
          error,
        )
      })
    })
  }

  abortConversation(conversationId: string): boolean {
    const runEntries = this.runEntriesForConversation(conversationId)
    if (runEntries.length === 0) {
      return false
    }

    const droppedQueuedByConversation: ChatUserMessage[] = []
    runEntries.forEach((runEntry) => {
      const runKey = getRunKey(conversationId, runEntry.branchId)
      const queued = this.pendingUserMessagesByKey.get(runKey)
      if (queued && queued.length > 0) {
        droppedQueuedByConversation.push(...queued)
      }
      this.pendingUserMessagesByKey.delete(runKey)
      this.continuationScheduledByKey.delete(runKey)

      runEntry.runtime?.abort()
      runEntry.state = {
        ...runEntry.state,
        messages: abortVisibleMessages(runEntry.state.messages),
        status: 'aborted',
        pendingCompactionAnchorMessageId: null,
      }
    })
    this.recomputeConversationState(conversationId)

    if (droppedQueuedByConversation.length > 0) {
      for (const subscriber of this.abortedQueuedMessagesSubscribers) {
        subscriber(conversationId, droppedQueuedByConversation)
      }
    }
    return true
  }

  abortAll(): void {
    for (const [conversationId] of this.conversationEntries) {
      this.abortConversation(conversationId)
    }
  }

  private getOrCreateConversationEntry(
    conversationId: string,
  ): ConversationEntry {
    const existing = this.conversationEntries.get(conversationId)
    if (existing) {
      return existing
    }

    const created: ConversationEntry = {
      subscribers: new Set(),
      baseMessages: [],
      persistState: true,
      state: {
        conversationId,
        status: 'idle',
        messages: [],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      },
    }
    this.conversationEntries.set(conversationId, created)
    return created
  }

  private getOrCreateRunEntry({
    conversationId,
    branchId,
    sourceUserMessageId,
  }: {
    conversationId: string
    branchId: string
    sourceUserMessageId?: string
  }): AgentRunEntry {
    const runKey = getRunKey(conversationId, branchId)
    const existing = this.runEntriesByKey.get(runKey)
    if (existing) {
      existing.sourceUserMessageId = sourceUserMessageId
      return existing
    }

    const created: AgentRunEntry = {
      conversationId,
      branchId,
      sourceUserMessageId,
      runtime: null,
      nextRunId: 1,
      runToken: null,
      lastRunInput: null,
      lastLoopConfig: null,
      lastRunContext: null,
      state: {
        conversationId,
        status: 'idle',
        messages: [],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      },
    }
    this.runEntriesByKey.set(runKey, created)
    return created
  }

  private runEntriesForConversation(conversationId: string): AgentRunEntry[] {
    return [...this.runEntriesByKey.values()].filter(
      (entry) => entry.conversationId === conversationId,
    )
  }

  private recomputeConversationState(conversationId: string): void {
    const conversationEntry = this.getOrCreateConversationEntry(conversationId)
    const runEntries = this.runEntriesForConversation(conversationId)
    const hasActiveRuns = runEntries.length > 0

    if (!hasActiveRuns) {
      this.notifyConversationSubscribers(conversationId)
      return
    }

    const aggregateMessages = runEntries.reduce<ChatMessage[]>(
      (messages, runEntry) => {
        if (runEntry.branchId === DEFAULT_BRANCH_ID) {
          return runEntry.state.messages
        }
        return buildBranchAggregateMessages({
          baseMessages: messages,
          branchState: runEntry.state,
          branchId: runEntry.branchId,
          sourceUserMessageId: runEntry.sourceUserMessageId,
        })
      },
      conversationEntry.baseMessages,
    )

    const isRunning = runEntries.some(
      (entry) => entry.state.status === 'running',
    )
    const hasError = runEntries.some((entry) => entry.state.status === 'error')
    const hasAborted = runEntries.some(
      (entry) => entry.state.status === 'aborted',
    )
    const latestCompaction = runEntries
      .flatMap((entry) => entry.state.compaction ?? [])
      .at(-1)
    const pendingCompactionAnchorMessageId =
      runEntries.find((entry) => entry.state.pendingCompactionAnchorMessageId)
        ?.state.pendingCompactionAnchorMessageId ?? null

    conversationEntry.state = {
      conversationId,
      status: isRunning
        ? 'running'
        : hasError
          ? 'error'
          : hasAborted
            ? 'aborted'
            : 'completed',
      runId: runEntries.at(-1)?.state.runId,
      messages: aggregateMessages,
      compaction: this.normalizeCompaction(
        latestCompaction
          ? [latestCompaction]
          : conversationEntry.state.compaction,
        aggregateMessages,
      ),
      pendingCompactionAnchorMessageId,
      anchorMessageId: runEntries.at(-1)?.state.anchorMessageId,
      errorMessage: runEntries.find((entry) => entry.state.errorMessage)?.state
        .errorMessage,
    }
    this.notifyConversationSubscribers(conversationId)
  }

  private finalizeSettledConversationRuns(conversationId: string): void {
    const runEntries = this.runEntriesForConversation(conversationId)
    if (runEntries.some((entry) => entry.state.status === 'running')) {
      this.recomputeConversationState(conversationId)
      return
    }

    const conversationEntry = this.getOrCreateConversationEntry(conversationId)
    if (runEntries.length > 0) {
      conversationEntry.baseMessages = [...conversationEntry.state.messages]
      runEntries.forEach((entry) => {
        this.runEntriesByKey.delete(getRunKey(conversationId, entry.branchId))
      })
    }
    this.notifyConversationSubscribers(conversationId)

    // Run has finalized — release the auto-run latch so a fresh idle event
    // (or drained queue) can schedule the next auto-run.
    this.autoRunScheduled.delete(conversationId)

    // Drain pending external agent results after run completes
    const drained = this.drainPendingExternalAgentResults(conversationId)
    if (drained.length > 0) {
      this.autoRunScheduled.add(conversationId)
      this.notifyPendingResultsSubscribers(conversationId)
    }
  }

  private notifyConversationSubscribers(
    conversationId: string,
    persistReason: AgentReplaceConversationMessagesReason = 'mutation',
  ): void {
    const entry = this.getOrCreateConversationEntry(conversationId)
    const state = this.cloneState(entry.state)
    for (const subscriber of entry.subscribers) {
      subscriber(state)
    }
    for (const subscriber of this.stateFeedSubscribers) {
      subscriber(state)
    }
    this.schedulePersistence(state, persistReason)
    this.notifyRunSummarySubscribers()
  }

  private cloneState(state: AgentConversationState): AgentConversationState {
    return {
      conversationId: state.conversationId,
      status: state.status,
      runId: state.runId,
      messages: [...state.messages],
      compaction: [...(state.compaction ?? [])],
      pendingCompactionAnchorMessageId:
        state.pendingCompactionAnchorMessageId ?? null,
      errorMessage: state.errorMessage,
      anchorMessageId: state.anchorMessageId,
    }
  }

  private buildRunSummary(
    state: AgentConversationState,
  ): AgentConversationRunSummary {
    const isWaitingUserInput = hasAwaitingUserInput(state.messages)
    const isWaitingApproval =
      hasPendingApproval(state.messages) || isWaitingUserInput
    return {
      conversationId: state.conversationId,
      status: state.status,
      isRunning: state.status === 'running' && !isWaitingApproval,
      isWaitingApproval,
      isWaitingUserInput,
    }
  }

  private notifyRunSummarySubscribers(): void {
    if (this.summarySubscribers.size === 0) {
      return
    }
    const summaries = this.getActiveConversationRunSummaries()
    for (const subscriber of this.summarySubscribers) {
      subscriber(summaries)
    }
  }

  private schedulePersistence(
    state: AgentConversationState,
    reason: AgentReplaceConversationMessagesReason = 'mutation',
  ): void {
    if (!this.options.persistConversationMessages) {
      return
    }
    const entry = this.conversationEntries.get(state.conversationId)
    if (entry && !entry.persistState) {
      return
    }

    // Hydration only loads existing messages into in-memory state; the disk
    // copy is already authoritative. Skip persistence entirely so it does not
    // touch updatedAt and re-rank the conversation in the history list.
    if (reason === 'hydrate') {
      return
    }

    const existingTimer = this.persistTimers.get(state.conversationId)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.persistTimers.delete(state.conversationId)
    }

    const delayMs =
      state.status === 'completed' ||
      state.status === 'aborted' ||
      state.status === 'error'
        ? 0
        : 250

    // Self-heal writes (e.g. normalizing aborted streaming residue) must
    // persist the repaired payload but should not be treated as user activity
    // for ordering purposes.
    const touchUpdatedAt = reason === 'self-heal' ? false : undefined

    const timer = setTimeout(() => {
      this.persistTimers.delete(state.conversationId)
      void this.options
        .persistConversationMessages?.({
          conversationId: state.conversationId,
          messages: state.messages,
          compaction: [...(state.compaction ?? [])],
          status: state.status,
          touchUpdatedAt,
        })
        .catch((error) => {
          console.error('[YOLO] Failed to persist agent conversation state', {
            conversationId: state.conversationId,
            status: state.status,
            error,
          })
        })
    }, delayMs)

    this.persistTimers.set(state.conversationId, timer)
  }

  private updateToolCallResponse({
    conversationId,
    toolCallId,
    response,
    status,
  }: {
    conversationId: string
    toolCallId: string
    response: ToolCallResponse
    status?: AgentRunStatus
  }): ChatMessage[] | null {
    const located = this.findToolCall(conversationId, toolCallId)
    if (!located) {
      return null
    }

    let updated = false
    const nextMessages = located.runEntry.state.messages.map((message) => {
      if (message.role !== 'tool') {
        return message
      }

      const nextToolCalls = message.toolCalls.map((toolCall) => {
        if (toolCall.request.id !== toolCallId) {
          return toolCall
        }
        updated = true
        return {
          ...toolCall,
          response,
        }
      })

      return updated
        ? {
            ...message,
            toolCalls: nextToolCalls,
          }
        : message
    })

    if (!updated) {
      return null
    }

    located.runEntry.state = {
      ...located.runEntry.state,
      messages: nextMessages,
      status: status ?? located.runEntry.state.status,
    }
    this.recomputeConversationState(conversationId)
    return nextMessages
  }

  private findToolCall(
    conversationId: string,
    toolCallId: string,
  ): {
    runEntry: AgentRunEntry
    toolMessage: Extract<ChatMessage, { role: 'tool' }>
    toolCall: {
      request: ToolCallRequest
      response: ToolCallResponse
    }
  } | null {
    for (const runEntry of this.runEntriesForConversation(conversationId)) {
      for (const message of runEntry.state.messages) {
        if (message.role !== 'tool') {
          continue
        }
        const toolCall = message.toolCalls.find(
          (candidate) => candidate.request.id === toolCallId,
        )
        if (toolCall) {
          return {
            runEntry,
            toolMessage: message,
            toolCall,
          }
        }
      }
    }

    return null
  }

  private normalizeCompaction(
    compaction: ChatConversationCompactionLike | null | undefined,
    messages: ChatMessage[],
  ): ChatConversationCompactionState {
    return normalizeChatConversationCompactionState(compaction).filter(
      (entry) =>
        messages.some((message) => message.id === entry.anchorMessageId),
    )
  }

  private normalizePendingCompactionAnchorMessageId(
    anchorMessageId: string | null | undefined,
    messages: ChatMessage[],
  ): string | null {
    if (!anchorMessageId) {
      return null
    }

    return messages.some((message) => message.id === anchorMessageId)
      ? anchorMessageId
      : null
  }
}
