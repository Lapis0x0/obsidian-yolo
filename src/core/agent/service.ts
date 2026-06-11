import { v4 as uuidv4 } from 'uuid'

import type { YoloSettings } from '../../settings/schema/setting.types'
import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
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
import {
  TERMINAL_COMMAND_TOOL_NAME,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { parseToolName } from '../mcp/tool-name-utils'

import {
  type BackgroundTaskEvent,
  backgroundTaskCompletionBus,
} from './background-task/completion-bus'
import {
  DEFAULT_BLOCKED_PREFIXES,
  isBlockedByCommandPrefix,
} from './bash/command-classifier'
import type { BashTaskRecord } from './bash/types'
import { DEFAULT_BRANCH_ID } from './branch'
import { CitationRegistry } from './citationRegistry'
import { NativeAgentRuntime } from './native-runtime'
import { PromptSourceWatcher } from './promptSourceWatcher'
import {
  type SubagentParentContext,
  buildSubagentParentContext,
} from './subagent/parent-context'
import type { SubagentTaskRecord } from './subagent/types'
import { SystemPromptSnapshotStore } from './systemPromptSnapshotStore'
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
   * True while the main agent activity is still user-visible: live runtime,
   * foreground tool execution, pending approval, or awaiting user input.
   * Background terminal/subagent result messages are intentionally excluded.
   */
  isActive: boolean
  /**
   * True when the global input-box Stop control should be available.
   */
  isAbortable: boolean
  /**
   * True when a new user message can be queued into the running loop.
   */
  isQueueable: boolean
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

type PendingApprovalRecoveryContext = {
  lastRunInput: AgentRuntimeRunInput
  lastLoopConfig: AgentRuntimeLoopConfig
  lastRunContext: AgentRunContext | null
}

type ConversationEntry = {
  state: AgentConversationState
  subscribers: Set<AgentConversationStateSubscriber>
  baseMessages: ChatMessage[]
  persistState: boolean
  /**
   * Captured when a run finalizes while tool calls still await approval.
   * Needed because `runEntries` are removed on settle but the UI approves later.
   */
  pendingApprovalRecoveryContext?: PendingApprovalRecoveryContext
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

function buildSubagentResultMessage(
  record: SubagentTaskRecord,
): ChatSubagentResultMessage {
  const completedAt = record.completedAt ?? Date.now()
  const result = record.result
  return {
    role: 'subagent_result',
    id: uuidv4(),
    taskId: record.taskId,
    source: record.source,
    title: record.title,
    status:
      result?.status ??
      (record.status === 'running' ? 'completed' : record.status),
    content: result?.content ?? record.error ?? '',
    activityLog: result?.activityLog ?? record.activityLog,
    durationMs: result?.durationMs ?? completedAt - record.createdAt,
    toolUseCount: result?.toolUseCount ?? 0,
    usage: result?.usage,
    prompt: result?.prompt ?? record.prompt,
    modelName: result?.modelName,
    transcript: result?.transcript,
    delegateAssistantMessageId:
      record.source.type === 'llm_tool_call'
        ? record.source.assistantMessageId
        : '',
    delegateToolCallId:
      record.source.type === 'llm_tool_call' ? record.source.toolCallId : '',
  }
}

function buildTerminalCommandResultMessage(
  record: BashTaskRecord,
): ChatTerminalCommandResultMessage {
  const completedAt = record.completedAt ?? Date.now()
  return {
    role: 'terminal_command_result',
    id: uuidv4(),
    taskId: record.taskId,
    source: record.source,
    title: record.title,
    status: record.status,
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

const getBackgroundTaskEventTime = (event: BackgroundTaskEvent): number => {
  if (event.kind === 'terminal_command_waiting') {
    return event.occurredAt
  }
  return event.record.completedAt ?? 0
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

const isBlockedTerminalCommandRequest = (
  request: ToolCallRequest,
  blockedCommandPrefixes?: string[],
): boolean => {
  try {
    const parsed = parseToolName(request.name)
    if (
      parsed.serverName !== getLocalFileToolServerName() ||
      parsed.toolName !== TERMINAL_COMMAND_TOOL_NAME
    ) {
      return false
    }
  } catch {
    return false
  }

  const args = getToolCallArgumentsObject(request.arguments)
  if (typeof args?.command !== 'string') {
    return false
  }

  return isBlockedByCommandPrefix(
    args.command,
    blockedCommandPrefixes ?? DEFAULT_BLOCKED_PREFIXES,
  )
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

const hasRunningMainToolCall = (messages: ChatMessage[]): boolean => {
  return messages.some(
    (message) =>
      message.role === 'tool' &&
      message.toolCalls.some(
        (toolCall) =>
          toolCall.response.status === ToolCallResponseStatus.Running,
      ),
  )
}

const hasPendingUserInteraction = (messages: ChatMessage[]): boolean => {
  return hasPendingApproval(messages) || hasAwaitingUserInput(messages)
}

export const buildAgentConversationRunSummary = (
  state: AgentConversationState,
): AgentConversationRunSummary => {
  const isWaitingUserInput = hasAwaitingUserInput(state.messages)
  const isWaitingApproval =
    hasPendingApproval(state.messages) || isWaitingUserInput
  const hasRunningToolCall = hasRunningMainToolCall(state.messages)
  const isRuntimeRunning = state.status === 'running'
  const isActive = isRuntimeRunning || isWaitingApproval || hasRunningToolCall

  return {
    conversationId: state.conversationId,
    status: state.status,
    isRunning: isRuntimeRunning && !isWaitingApproval,
    isActive,
    isAbortable: isActive,
    isQueueable: isRuntimeRunning && !isWaitingApproval,
    isWaitingApproval,
    isWaitingUserInput,
  }
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

const patchToolCallResponseInMessages = (
  messages: ChatMessage[],
  toolCallId: string,
  response: ToolCallResponse,
): {
  toolMessageId: string | null
  updatedMessages: ChatMessage[]
  didPatch: boolean
} => {
  let toolMessageId: string | null = null
  let didPatch = false
  const updatedMessages = messages.map((message) => {
    if (message.role !== 'tool') {
      return message
    }
    let messageUpdated = false
    const nextToolCalls = message.toolCalls.map((toolCall) => {
      if (toolCall.request.id !== toolCallId) {
        return toolCall
      }
      didPatch = true
      toolMessageId = message.id
      messageUpdated = true
      return { ...toolCall, response }
    })
    return messageUpdated ? { ...message, toolCalls: nextToolCalls } : message
  })
  return { toolMessageId, updatedMessages, didPatch }
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
      currentMessage.role === 'external_agent_result' ||
      currentMessage.role === 'subagent_result' ||
      currentMessage.role === 'terminal_command_result'
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

export type PendingBackgroundTaskResultsSubscriber = (
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

type ForegroundToolAborter = () => void

export class AgentService {
  private conversationEntries = new Map<string, ConversationEntry>()
  private runEntriesByKey = new Map<string, AgentRunEntry>()
  private foregroundToolAbortersByConversation = new Map<
    string,
    Map<string, ForegroundToolAborter>
  >()
  private summarySubscribers = new Set<AgentConversationRunSummarySubscriber>()
  private stateFeedSubscribers = new Set<AgentConversationStateFeedSubscriber>()
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** pending background task results per conversation (queued while streaming) */
  private pendingBackgroundTaskResults = new Map<
    string,
    BackgroundTaskEvent[]
  >()
  private pendingResultsSubscribers =
    new Set<PendingBackgroundTaskResultsSubscriber>()
  private unsubscribeBackgroundTaskCompleted: (() => void) | null = null
  // Conversations that have notified subscribers about an auto-run trigger but
  // whose run hasn't yet flipped `isRunning` to true. Prevents duplicate
  // auto-runs when multiple background completion events arrive in the gap between
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
  /**
   * Per-conversation frozen system prompt. Lives on this singleton so it
   * survives `RequestContextBuilder` rebuilds caused by unrelated settings
   * churn (reasoning level, chat mode, etc.).
   */
  private readonly systemPromptSnapshotStore = new SystemPromptSnapshotStore()
  private readonly promptSourceWatcher = new PromptSourceWatcher()

  constructor(private readonly options: AgentServiceOptions = {}) {}

  /** Shared system-prompt snapshot store, injected into RCB at construction. */
  getSystemPromptSnapshotStore(): SystemPromptSnapshotStore {
    return this.systemPromptSnapshotStore
  }

  getPromptSourceWatcher(): PromptSourceWatcher {
    return this.promptSourceWatcher
  }

  /**
   * Drop the frozen system prompt for a conversation. Call when the
   * conversation is deleted or restarted as a new topic so the next request
   * re-snapshots against the current memory / configuration.
   */
  evictSystemPromptSnapshot(conversationId: string): void {
    this.systemPromptSnapshotStore.evict(conversationId)
  }

  /**
   * Drop every frozen system prompt. Call when all conversations are wiped
   * (e.g. "clear chat history" in settings) so no stale snapshot survives.
   */
  clearSystemPromptSnapshots(): void {
    this.systemPromptSnapshotStore.clear()
  }

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

  /** Subscribe to be notified when pending background task results are ready to drain */
  subscribeToPendingBackgroundTaskResults(
    fn: PendingBackgroundTaskResultsSubscriber,
  ): () => void {
    this.pendingResultsSubscribers.add(fn)
    return () => {
      this.pendingResultsSubscribers.delete(fn)
    }
  }

  startBackgroundTaskResultListener(): void {
    if (this.unsubscribeBackgroundTaskCompleted) return
    this.unsubscribeBackgroundTaskCompleted =
      backgroundTaskCompletionBus.subscribe((event) => {
        this.handleBackgroundTaskCompleted(event)
      })
  }

  stopBackgroundTaskResultListener(): void {
    this.unsubscribeBackgroundTaskCompleted?.()
    this.unsubscribeBackgroundTaskCompleted = null
  }

  private handleBackgroundTaskCompleted(event: BackgroundTaskEvent): void {
    const { conversationId } = event
    const isRunning = this.isRunning(conversationId)
    const autoRunPending = this.autoRunScheduled.has(conversationId)

    if (isRunning || autoRunPending) {
      const queue = this.pendingBackgroundTaskResults.get(conversationId) ?? []
      queue.push(event)
      this.pendingBackgroundTaskResults.set(conversationId, queue)
    } else {
      this.autoRunScheduled.add(conversationId)
      this.appendBackgroundTaskResultEvent(conversationId, event)
      this.notifyPendingResultsSubscribers(conversationId)
    }
  }

  private appendBackgroundTaskResultEvent(
    conversationId: string,
    event: BackgroundTaskEvent,
  ): void {
    const msg = this.buildBackgroundTaskResultMessage(event)
    const entry = this.getOrCreateConversationEntry(conversationId)
    const nextMessages = [...entry.state.messages, msg]
    entry.baseMessages = nextMessages
    entry.state = { ...entry.state, messages: nextMessages }
    this.notifyConversationSubscribers(conversationId)
  }

  private buildBackgroundTaskResultMessage(
    event: BackgroundTaskEvent,
  ): ChatMessage {
    switch (event.kind) {
      case 'subagent':
        return buildSubagentResultMessage(event.record)
      case 'terminal_command':
      case 'terminal_command_waiting':
        return buildTerminalCommandResultMessage(event.record)
    }
  }

  drainPendingBackgroundTaskResults(conversationId: string): ChatMessage[] {
    const queue = this.pendingBackgroundTaskResults.get(conversationId)
    if (!queue || queue.length === 0) return []

    queue.sort(
      (a, b) => getBackgroundTaskEventTime(a) - getBackgroundTaskEventTime(b),
    )
    this.pendingBackgroundTaskResults.delete(conversationId)

    const appended: ChatMessage[] = []
    for (const event of queue) {
      appended.push(this.buildBackgroundTaskResultMessage(event))
    }

    const entry = this.getOrCreateConversationEntry(conversationId)
    const nextMessages = [...entry.state.messages, ...appended]
    entry.baseMessages = nextMessages
    entry.state = { ...entry.state, messages: nextMessages }
    this.notifyConversationSubscribers(conversationId)

    return appended
  }

  hasPendingBackgroundTaskResults(conversationId: string): boolean {
    return (
      (this.pendingBackgroundTaskResults.get(conversationId)?.length ?? 0) > 0
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
    return buildAgentConversationRunSummary(state)
  }

  getActiveConversationRunSummaries(): Map<
    string,
    AgentConversationRunSummary
  > {
    const summaries = new Map<string, AgentConversationRunSummary>()
    for (const [conversationId, entry] of this.conversationEntries.entries()) {
      const summary = buildAgentConversationRunSummary(entry.state)
      if (summary.isActive) {
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

  registerForegroundToolAborter({
    conversationId,
    toolCallId,
    abort,
  }: {
    conversationId: string
    toolCallId: string
    abort: ForegroundToolAborter
  }): () => void {
    const aborters =
      this.foregroundToolAbortersByConversation.get(conversationId) ?? new Map()
    aborters.set(toolCallId, abort)
    this.foregroundToolAbortersByConversation.set(conversationId, aborters)

    return () => {
      const current =
        this.foregroundToolAbortersByConversation.get(conversationId)
      if (!current) return
      if (current.get(toolCallId) !== abort) return
      current.delete(toolCallId)
      if (current.size === 0) {
        this.foregroundToolAbortersByConversation.delete(conversationId)
      }
    }
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

  getPendingApprovalSubagentParentContext(
    conversationId: string,
  ): SubagentParentContext | undefined {
    const recovery =
      this.getOrCreateConversationEntry(
        conversationId,
      ).pendingApprovalRecoveryContext
    if (!recovery) {
      return undefined
    }
    return buildSubagentParentContext(
      recovery.lastRunInput,
      recovery.lastLoopConfig,
    )
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
    if (!located) {
      return false
    }

    const { toolMessage, toolCall } = located
    if (toolCall.response.status !== ToolCallResponseStatus.PendingApproval) {
      return false
    }

    const conversationEntry = this.getOrCreateConversationEntry(conversationId)
    const recoveryContext = conversationEntry.pendingApprovalRecoveryContext
    const activeRunInput = located.runEntry?.lastRunInput ?? null
    const activeLoopConfig = located.runEntry?.lastLoopConfig ?? null
    const lastRunInput = activeRunInput ?? recoveryContext?.lastRunInput ?? null
    const lastLoopConfig =
      activeLoopConfig ?? recoveryContext?.lastLoopConfig ?? null
    const lastRunContext =
      located.runEntry?.lastRunContext ??
      recoveryContext?.lastRunContext ??
      null

    if (!lastRunInput || !lastLoopConfig) {
      return false
    }

    if (
      isBlockedTerminalCommandRequest(
        toolCall.request,
        lastRunInput.blockedCommandPrefixes,
      )
    ) {
      const nextMessages = this.updateToolCallResponse({
        conversationId,
        toolCallId,
        response: {
          status: ToolCallResponseStatus.Error,
          error:
            'Terminal command rejected because it matches a blocked command prefix.',
        },
      })
      if (!nextMessages) {
        return false
      }

      if (isTrailingResolvedToolMessage(nextMessages, toolMessage.id)) {
        await this.run({
          conversationId,
          loopConfig: lastLoopConfig,
          input: this.buildContinuationInput(lastRunInput, nextMessages),
        })
      }

      return true
    }

    if (allowForConversation) {
      lastRunInput.mcpManager.allowToolForConversation(
        toolCall.request.name,
        conversationId,
        getToolCallArgumentsObject(toolCall.request.arguments),
      )
    }

    const messagesBeforeApproval =
      located.runEntry?.state.messages ?? conversationEntry.state.messages

    const runningMessages = this.updateToolCallResponse({
      conversationId,
      toolCallId,
      response: { status: ToolCallResponseStatus.Running },
      status: 'running',
    })
    if (!runningMessages) {
      return false
    }

    const toolArgs = getToolCallArgumentsObject(toolCall.request.arguments)
    const debugTraceId = this.findDebugTraceIdForToolCall(
      messagesBeforeApproval,
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
          conversationMessages: runningMessages,
          roundId: toolMessage.id,
          chatModelId: lastRunInput.model.id,
          workspaceScope: lastRunInput.workspaceScope,
          runContext: lastRunContext ?? undefined,
          subagentParentContext: buildSubagentParentContext(
            lastRunInput,
            lastLoopConfig,
          ),
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

    if (isTrailingResolvedToolMessage(nextMessages, toolMessage.id)) {
      await this.run({
        conversationId,
        loopConfig: lastLoopConfig,
        input: this.buildContinuationInput(lastRunInput, nextMessages),
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
      if (runEntry?.lastRunInput && runEntry.lastLoopConfig) {
        await this.run({
          conversationId,
          loopConfig: runEntry.lastLoopConfig,
          input: this.buildContinuationInput(
            runEntry.lastRunInput,
            nextMessages,
          ),
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
    const abortedForegroundTool = this.abortRegisteredForegroundToolCall(
      conversationId,
      toolCallId,
    )
    const located = this.findToolCall(conversationId, toolCallId)
    if (!located) {
      return abortedForegroundTool
    }
    located.runEntry?.lastRunInput?.mcpManager.abortToolCall(toolCallId)
    return (
      Boolean(
        this.updateToolCallResponse({
          conversationId,
          toolCallId,
          response: { status: ToolCallResponseStatus.Aborted },
        }),
      ) || abortedForegroundTool
    )
  }

  private abortRegisteredForegroundToolCall(
    conversationId: string,
    toolCallId: string,
  ): boolean {
    const aborters =
      this.foregroundToolAbortersByConversation.get(conversationId)
    const abort = aborters?.get(toolCallId)
    if (!abort || !aborters) {
      return false
    }

    aborters.delete(toolCallId)
    if (aborters.size === 0) {
      this.foregroundToolAbortersByConversation.delete(conversationId)
    }

    try {
      abort()
    } catch (error) {
      console.warn('[YOLO] Failed to abort foreground tool call', {
        conversationId,
        toolCallId,
        error,
      })
    }
    return true
  }

  private abortRegisteredForegroundToolCalls(
    conversationId: string,
    messages: ChatMessage[],
  ): boolean {
    let aborted = false
    for (const message of messages) {
      if (message.role !== 'tool') continue
      for (const toolCall of message.toolCalls) {
        if (toolCall.response.status !== ToolCallResponseStatus.Running) {
          continue
        }
        aborted =
          this.abortRegisteredForegroundToolCall(
            conversationId,
            toolCall.request.id,
          ) || aborted
      }
    }
    return aborted
  }

  private abortRuntimeToolCalls(runEntry: AgentRunEntry): void {
    const mcpManager = runEntry.lastRunInput?.mcpManager
    if (!mcpManager) {
      return
    }
    for (const message of runEntry.state.messages) {
      if (message.role !== 'tool') continue
      for (const toolCall of message.toolCalls) {
        if (toolCall.response.status === ToolCallResponseStatus.Running) {
          mcpManager.abortToolCall(toolCall.request.id)
        }
      }
    }
  }

  private buildContinuationInput(
    input: AgentRuntimeRunInput,
    messages: ChatMessage[],
  ): AgentRuntimeRunInput {
    return {
      ...input,
      messages,
      requestMessages: undefined,
    }
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
    return this.abortConversationMainActivity(conversationId)
  }

  abortConversationMainActivity(conversationId: string): boolean {
    const runEntries = this.runEntriesForConversation(conversationId)
    const droppedQueuedByConversation: ChatUserMessage[] = []
    let didAbort = false

    const conversationEntry = this.conversationEntries.get(conversationId)
    didAbort =
      this.abortRegisteredForegroundToolCalls(
        conversationId,
        conversationEntry?.state.messages ?? [],
      ) || didAbort

    runEntries.forEach((runEntry) => {
      didAbort = true
      const runKey = getRunKey(conversationId, runEntry.branchId)
      const queued = this.pendingUserMessagesByKey.get(runKey)
      if (queued && queued.length > 0) {
        droppedQueuedByConversation.push(...queued)
      }
      this.pendingUserMessagesByKey.delete(runKey)
      this.continuationScheduledByKey.delete(runKey)

      this.abortRuntimeToolCalls(runEntry)
      runEntry.runtime?.abort()
      runEntry.state = {
        ...runEntry.state,
        messages: abortVisibleMessages(runEntry.state.messages),
        status: 'aborted',
        pendingCompactionAnchorMessageId: null,
      }
    })
    if (runEntries.length > 0) {
      this.recomputeConversationState(conversationId)
    } else if (conversationEntry) {
      const nextMessages = abortVisibleMessages(
        conversationEntry.state.messages,
      )
      const didPatchMessages = nextMessages.some(
        (message, index) => message !== conversationEntry.state.messages[index],
      )
      if (didPatchMessages) {
        didAbort = true
        conversationEntry.baseMessages = nextMessages
        conversationEntry.state = {
          ...conversationEntry.state,
          messages: nextMessages,
          status: 'aborted',
          pendingCompactionAnchorMessageId: null,
        }
        this.syncPendingApprovalRecoveryContext(conversationId, nextMessages)
        this.notifyConversationSubscribers(conversationId)
      }
    }

    if (droppedQueuedByConversation.length > 0) {
      for (const subscriber of this.abortedQueuedMessagesSubscribers) {
        subscriber(conversationId, droppedQueuedByConversation)
      }
    }
    return didAbort
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
      const defaultBranchEntry =
        runEntries.find((entry) => entry.branchId === DEFAULT_BRANCH_ID) ??
        runEntries[0]
      if (
        defaultBranchEntry &&
        hasPendingApproval(defaultBranchEntry.state.messages) &&
        defaultBranchEntry.lastRunInput &&
        defaultBranchEntry.lastLoopConfig
      ) {
        conversationEntry.pendingApprovalRecoveryContext = {
          lastRunInput: defaultBranchEntry.lastRunInput,
          lastLoopConfig: defaultBranchEntry.lastLoopConfig,
          lastRunContext: defaultBranchEntry.lastRunContext,
        }
      }
      runEntries.forEach((entry) => {
        this.runEntriesByKey.delete(getRunKey(conversationId, entry.branchId))
      })
    }
    this.notifyConversationSubscribers(conversationId)

    // Run has finalized — release the auto-run latch so a fresh idle event
    // (or drained queue) can schedule the next auto-run.
    this.autoRunScheduled.delete(conversationId)

    // Drain pending background task results after run completes
    const drainedBackground =
      this.drainPendingBackgroundTaskResults(conversationId)
    if (drainedBackground.length > 0) {
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

  private syncPendingApprovalRecoveryContext(
    conversationId: string,
    messages: ChatMessage[],
  ): void {
    if (hasPendingApproval(messages)) {
      return
    }
    const entry = this.conversationEntries.get(conversationId)
    if (entry) {
      entry.pendingApprovalRecoveryContext = undefined
    }
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

    const sourceMessages =
      located.runEntry?.state.messages ??
      this.getOrCreateConversationEntry(conversationId).state.messages
    const { updatedMessages, didPatch } = patchToolCallResponseInMessages(
      sourceMessages,
      toolCallId,
      response,
    )
    if (!didPatch) {
      return null
    }

    if (located.runEntry) {
      located.runEntry.state = {
        ...located.runEntry.state,
        messages: updatedMessages,
        status: status ?? located.runEntry.state.status,
      }
    } else {
      const conversationEntry =
        this.getOrCreateConversationEntry(conversationId)
      conversationEntry.baseMessages = updatedMessages
      conversationEntry.state = {
        ...conversationEntry.state,
        messages: updatedMessages,
        status: status ?? conversationEntry.state.status,
      }
      this.syncPendingApprovalRecoveryContext(conversationId, updatedMessages)
    }

    this.recomputeConversationState(conversationId)
    return updatedMessages
  }

  private findToolCall(
    conversationId: string,
    toolCallId: string,
  ): {
    runEntry: AgentRunEntry | null
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

    const conversationEntry = this.conversationEntries.get(conversationId)
    if (!conversationEntry) {
      return null
    }

    for (const message of conversationEntry.state.messages) {
      if (message.role !== 'tool') {
        continue
      }
      const toolCall = message.toolCalls.find(
        (candidate) => candidate.request.id === toolCallId,
      )
      if (toolCall) {
        return {
          runEntry: null,
          toolMessage: message,
          toolCall,
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
