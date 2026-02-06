import { ChatMessage } from '../../types/chat'

import { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from './types'
import { NativeAgentRuntime } from './native-runtime'

export type AgentRunStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'aborted'
  | 'error'

export type AgentConversationState = {
  conversationId: string
  status: AgentRunStatus
  messages: ChatMessage[]
  errorMessage?: string
}

export type AgentConversationStateSubscriber = (
  state: AgentConversationState,
) => void

type AgentRunEntry = {
  runtime: NativeAgentRuntime | null
  state: AgentConversationState
  runToken: symbol | null
  subscribers: Set<AgentConversationStateSubscriber>
}

export class AgentService {
  private runsByConversation = new Map<string, AgentRunEntry>()

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

  isRunning(conversationId: string): boolean {
    return this.getOrCreateEntry(conversationId).state.status === 'running'
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
    entry.runtime = runtime
    entry.runToken = runToken
    entry.state = {
      conversationId,
      status: 'running',
      messages: [],
    }
    this.notifySubscribers(entry)

    const unsubscribe = runtime.subscribe((messages) => {
      const currentEntry = this.runsByConversation.get(conversationId)
      if (!currentEntry || currentEntry.runToken !== runToken) {
        return
      }
      currentEntry.state = {
        ...currentEntry.state,
        messages: [...messages],
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
      if (!currentEntry || currentEntry.runToken !== runToken) {
        return
      }
      currentEntry.runToken = null
      if (currentEntry.runtime === runtime) {
        currentEntry.runtime = null
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
      runToken: null,
      subscribers: new Set(),
      state: {
        conversationId,
        status: 'idle',
        messages: [],
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
  }

  private cloneState(state: AgentConversationState): AgentConversationState {
    return {
      conversationId: state.conversationId,
      status: state.status,
      messages: [...state.messages],
      errorMessage: state.errorMessage,
    }
  }
}
