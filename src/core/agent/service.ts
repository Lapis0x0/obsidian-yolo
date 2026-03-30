import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
  normalizeChatConversationCompactionState,
} from '../../types/chat'
import {
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'

import { NativeAgentRuntime } from './native-runtime'
import { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from './types'

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
  isWaitingApproval: boolean
}

export type AgentConversationRunSummarySubscriber = (
  summaries: Map<string, AgentConversationRunSummary>,
) => void

type AgentRunEntry = {
  runtime: NativeAgentRuntime | null
  state: AgentConversationState
  nextRunId: number
  runToken: symbol | null
  subscribers: Set<AgentConversationStateSubscriber>
  lastRunInput: AgentRuntimeRunInput | null
  lastLoopConfig: AgentRuntimeLoopConfig | null
}

type AgentServiceOptions = {
  persistConversationMessages?: (payload: {
    conversationId: string
    messages: ChatMessage[]
    compaction?: ChatConversationCompactionState
    status: AgentRunStatus
  }) => Promise<void>
}

const reconcileAssistantGenerationState = (
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
): ChatMessage[] => {
  const previousAssistantStateMap = new Map(
    previousMessages
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.id, message.metadata?.generationState]),
  )

  return nextMessages.map((message) => {
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

const mergeVisibleMessages = (
  baseMessages: ChatMessage[],
  anchorMessageId: string | undefined,
  responseMessages: ChatMessage[],
): ChatMessage[] => {
  if (!anchorMessageId) {
    return reconcileAssistantGenerationState(baseMessages, responseMessages)
  }

  const anchorIndex = baseMessages.findIndex(
    (message) => message.id === anchorMessageId,
  )

  if (anchorIndex === -1) {
    return reconcileAssistantGenerationState(baseMessages, responseMessages)
  }

  return reconcileAssistantGenerationState(baseMessages, [
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

export class AgentService {
  private runsByConversation = new Map<string, AgentRunEntry>()
  private summarySubscribers = new Set<AgentConversationRunSummarySubscriber>()
  private stateFeedSubscribers = new Set<AgentConversationStateFeedSubscriber>()
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: AgentServiceOptions = {}) {}

  subscribe(
    conversationId: string,
    callback: AgentConversationStateSubscriber,
    options?: { emitCurrent?: boolean },
  ): () => void {
    const entry = this.getOrCreateEntry(conversationId)
    entry.subscribers.add(callback)

    if (options?.emitCurrent ?? true) {
      callback(this.cloneState(entry.state))
    }

    return () => {
      const currentEntry = this.runsByConversation.get(conversationId)
      currentEntry?.subscribers.delete(callback)
    }
  }

  getState(conversationId: string): AgentConversationState {
    return this.cloneState(this.getOrCreateEntry(conversationId).state)
  }

  getConversationRunSummary(
    conversationId: string,
  ): AgentConversationRunSummary {
    const state = this.getOrCreateEntry(conversationId).state
    return this.buildRunSummary(state)
  }

  getActiveConversationRunSummaries(): Map<
    string,
    AgentConversationRunSummary
  > {
    const summaries = new Map<string, AgentConversationRunSummary>()
    for (const [conversationId, entry] of this.runsByConversation.entries()) {
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
      for (const entry of this.runsByConversation.values()) {
        callback(this.cloneState(entry.state))
      }
    }

    return () => {
      this.stateFeedSubscribers.delete(callback)
    }
  }

  isRunning(conversationId: string): boolean {
    return this.getOrCreateEntry(conversationId).state.status === 'running'
  }

  replaceConversationMessages(
    conversationId: string,
    messages: ChatMessage[],
    compaction?: ChatConversationCompactionLike | null,
  ): void {
    const entry = this.getOrCreateEntry(conversationId)
    entry.state = {
      ...entry.state,
      messages: [...messages],
      compaction: this.normalizeCompaction(
        compaction === undefined ? entry.state.compaction : compaction,
        messages,
      ),
    }
    this.notifySubscribers(entry)
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
    const entry = this.runsByConversation.get(conversationId)
    if (!entry?.lastRunInput || !entry.lastLoopConfig) {
      return false
    }

    const target = this.findToolCall(entry.state.messages, toolCallId)
    if (!target) {
      return false
    }

    const { toolMessage, toolCall } = target
    if (toolCall.response.status !== ToolCallResponseStatus.PendingApproval) {
      return false
    }

    if (allowForConversation) {
      entry.lastRunInput.mcpManager.allowToolForConversation(
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

    const result = await entry.lastRunInput.mcpManager.callTool({
      name: toolCall.request.name,
      args: getToolCallArgumentsObject(toolCall.request.arguments),
      id: toolCall.request.id,
      conversationMessages: entry.state.messages,
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
        [ToolCallResponseStatus.Success, ToolCallResponseStatus.Error].includes(
          currentToolCall.response.status,
        ),
      )
    ) {
      await this.run({
        conversationId,
        loopConfig: entry.lastLoopConfig,
        input: {
          ...entry.lastRunInput,
          messages: nextMessages,
        },
      })
    }

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
    const entry = this.runsByConversation.get(conversationId)
    if (!entry) {
      return false
    }
    entry.lastRunInput?.mcpManager.abortToolCall(toolCallId)
    return Boolean(
      this.updateToolCallResponse({
        conversationId,
        toolCallId,
        response: { status: ToolCallResponseStatus.Aborted },
        status: entry.runtime ? 'aborted' : undefined,
      }),
    )
  }

  async run({
    conversationId,
    input,
    loopConfig,
  }: {
    conversationId: string
    input: AgentRuntimeRunInput
    loopConfig: AgentRuntimeLoopConfig
  }): Promise<void> {
    const entry = this.getOrCreateEntry(conversationId)

    if (entry.state.status === 'running' && entry.runtime) {
      entry.runtime.abort()
    }

    const runtime = new NativeAgentRuntime(loopConfig)
    const runToken = Symbol(`agent-run-${conversationId}`)
    const runId = entry.nextRunId
    entry.nextRunId += 1
    entry.runtime = runtime
    entry.runToken = runToken
    entry.lastRunInput = input
    entry.lastLoopConfig = loopConfig
    entry.state = {
      conversationId,
      status: 'running',
      runId,
      messages: [...input.messages],
      compaction: this.normalizeCompaction(input.compaction, input.messages),
      pendingCompactionAnchorMessageId: null,
      anchorMessageId: input.messages.at(-1)?.id,
    }
    this.notifySubscribers(entry)

    const unsubscribe = runtime.subscribe((snapshot) => {
      const currentEntry = this.runsByConversation.get(conversationId)
      if (!currentEntry || currentEntry.runToken !== runToken) {
        return
      }
      const mergedMessages = mergeVisibleMessages(
        input.messages,
        currentEntry.state.anchorMessageId,
        snapshot.messages,
      )
      currentEntry.state = {
        ...currentEntry.state,
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
      this.notifySubscribers(currentEntry)
    })

    try {
      await runtime.run(input)

      const currentEntry = this.runsByConversation.get(conversationId)
      if (!currentEntry || currentEntry.runToken !== runToken) {
        return
      }

      currentEntry.state = {
        ...currentEntry.state,
        status: input.abortSignal?.aborted ? 'aborted' : 'completed',
        pendingCompactionAnchorMessageId: null,
      }
      this.notifySubscribers(currentEntry)
    } catch (error) {
      const currentEntry = this.runsByConversation.get(conversationId)
      if (!currentEntry || currentEntry.runToken !== runToken) {
        return
      }
      const aborted =
        input.abortSignal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      currentEntry.state = {
        ...currentEntry.state,
        status: aborted ? 'aborted' : 'error',
        pendingCompactionAnchorMessageId: null,
        errorMessage:
          aborted || !(error instanceof Error)
            ? undefined
            : (error.message ?? 'Unknown error'),
      }
      this.notifySubscribers(currentEntry)
      if (!aborted) {
        throw error
      }
    } finally {
      unsubscribe()
      const currentEntry = this.runsByConversation.get(conversationId)
      if (currentEntry && currentEntry.runToken === runToken) {
        currentEntry.runToken = null
        if (currentEntry.runtime === runtime) {
          currentEntry.runtime = null
        }
      }
    }
  }

  abortConversation(conversationId: string): boolean {
    const entry = this.runsByConversation.get(conversationId)
    if (!entry || entry.state.status !== 'running' || !entry.runtime) {
      return false
    }
    entry.runtime.abort()
    entry.state = {
      ...entry.state,
      status: 'aborted',
      pendingCompactionAnchorMessageId: null,
    }
    this.notifySubscribers(entry)
    return true
  }

  abortAll(): void {
    for (const [conversationId] of this.runsByConversation) {
      this.abortConversation(conversationId)
    }
  }

  private getOrCreateEntry(conversationId: string): AgentRunEntry {
    const existing = this.runsByConversation.get(conversationId)
    if (existing) {
      return existing
    }

    const created: AgentRunEntry = {
      runtime: null,
      nextRunId: 1,
      runToken: null,
      subscribers: new Set(),
      lastRunInput: null,
      lastLoopConfig: null,
      state: {
        conversationId,
        status: 'idle',
        messages: [],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      },
    }
    this.runsByConversation.set(conversationId, created)
    return created
  }

  private notifySubscribers(entry: AgentRunEntry): void {
    const state = this.cloneState(entry.state)
    for (const subscriber of entry.subscribers) {
      subscriber(state)
    }
    for (const subscriber of this.stateFeedSubscribers) {
      subscriber(state)
    }
    this.schedulePersistence(state)
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
    const isWaitingApproval = hasPendingApproval(state.messages)
    return {
      conversationId: state.conversationId,
      status: state.status,
      isRunning: state.status === 'running' && !isWaitingApproval,
      isWaitingApproval,
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

  private schedulePersistence(state: AgentConversationState): void {
    if (!this.options.persistConversationMessages) {
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

    const timer = setTimeout(() => {
      this.persistTimers.delete(state.conversationId)
      void this.options
        .persistConversationMessages?.({
          conversationId: state.conversationId,
          messages: state.messages,
          compaction: [...(state.compaction ?? [])],
          status: state.status,
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
    const entry = this.runsByConversation.get(conversationId)
    if (!entry) {
      return null
    }

    let updated = false
    const nextMessages = entry.state.messages.map((message) => {
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

    entry.state = {
      ...entry.state,
      messages: nextMessages,
      status: status ?? entry.state.status,
    }
    this.notifySubscribers(entry)
    return nextMessages
  }

  private findToolCall(
    messages: ChatMessage[],
    toolCallId: string,
  ): {
    toolMessage: Extract<ChatMessage, { role: 'tool' }>
    toolCall: {
      request: ToolCallRequest
      response: ToolCallResponse
    }
  } | null {
    for (const message of messages) {
      if (message.role !== 'tool') {
        continue
      }
      const toolCall = message.toolCalls.find(
        (candidate) => candidate.request.id === toolCallId,
      )
      if (toolCall) {
        return {
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
