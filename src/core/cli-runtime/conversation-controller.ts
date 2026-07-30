import type { ChatMessage, ChatUserMessage } from '../../types/chat'

import type {
  CliAssistantBinding,
  CliRuntime,
  CliRuntimeEvent,
  CliRuntimeRunState,
  CliSessionRef,
  CliTurnInput,
} from './types'

export type CliConversationSnapshot = Readonly<{
  runtimeId: CliRuntime['runtimeId']
  messages: readonly ChatMessage[]
  sessionRef: CliSessionRef | null
  runState: CliRuntimeRunState
  error: string | null
}>

export type CliConversationTurn = Readonly<{
  userMessage: ChatUserMessage
  content: CliTurnInput['content']
}>

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isSameSession = (
  left: CliSessionRef | null | undefined,
  right: CliSessionRef | null | undefined,
): boolean =>
  left?.runtimeId === right?.runtimeId &&
  left?.nativeSessionId === right?.nativeSessionId

const upsertMessage = (
  messages: readonly ChatMessage[],
  message: ChatMessage,
): readonly ChatMessage[] => {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index < 0) return Object.freeze([...messages, message])
  if (messages[index] === message) return messages
  const next = [...messages]
  next[index] = message
  return Object.freeze(next)
}

const normalizeMessages = (
  messages: readonly ChatMessage[],
): readonly ChatMessage[] => {
  const normalized: ChatMessage[] = []
  const indexById = new Map<string, number>()
  for (const message of messages) {
    const index = indexById.get(message.id)
    if (index === undefined) {
      indexById.set(message.id, normalized.length)
      normalized.push(message)
    } else {
      normalized[index] = message
    }
  }
  return Object.freeze(normalized)
}

/**
 * Owns the transient timeline for the currently selected CLI runtime/session.
 * The runtime remains owned by the caller; disposing this controller only
 * detaches its listeners and invalidates outstanding operations.
 */
export class CliConversationController {
  private runtime: CliRuntime
  private snapshot: CliConversationSnapshot
  private readonly listeners = new Set<() => void>()
  private unsubscribeRuntime: (() => void) | null = null
  private runtimeEpoch = 0
  private conversationEpoch = 0
  private acceptingEvents = false
  private bindingTarget: CliSessionRef | null | undefined
  private bindingEpoch: number | null = null
  private readyTail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(runtime: CliRuntime) {
    this.runtime = runtime
    this.snapshot = this.createEmptySnapshot(runtime)
    this.subscribeToRuntime()
  }

  getSnapshot = (): CliConversationSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Switches the selected provider without taking ownership of either runtime. */
  setRuntime(runtime: CliRuntime): void {
    this.assertActive()
    if (runtime === this.runtime) return
    this.invalidateRuntimeSubscription()
    this.runtime = runtime
    this.runtimeEpoch += 1
    this.conversationEpoch += 1
    this.readyTail = Promise.resolve()
    this.resetEventGate()
    this.snapshot = this.createEmptySnapshot(runtime)
    this.subscribeToRuntime()
    this.notify()
  }

  /** Clears the current transcript before starting a provider-native session. */
  resetSession(): void {
    this.assertActive()
    this.beginSessionTransition(null)
  }

  async hydrateSession(ref: CliSessionRef): Promise<void> {
    this.assertActive()
    this.assertRuntimeRef(ref)
    this.beginSessionTransition(ref)
    const operation = this.captureOperation()

    try {
      const hydration = await operation.runtime.openSession(ref)
      if (!this.isCurrent(operation)) return
      this.assertRuntimeRef(hydration.ref)
      if (!isSameSession(ref, hydration.ref)) {
        throw new Error('CLI runtime hydrated a different session.')
      }
      this.publish({
        ...this.snapshot,
        messages: normalizeMessages(hydration.messages),
        sessionRef: hydration.ref,
        runState: 'idle',
        error: null,
      })
    } catch (error) {
      if (this.isCurrent(operation)) this.publishError(error)
      throw error
    }
  }

  ensureReady(assistant: CliAssistantBinding): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    const task = this.readyTail
      .catch(() => undefined)
      .then(async () => {
        if (!this.isCurrent(operation)) return
        await this.ensureReadyNow(operation, assistant)
      })
    this.readyTail = task.catch(() => undefined)
    return task
  }

  async sendTurn({ userMessage, content }: CliConversationTurn): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    if (!this.acceptingEvents) {
      throw new Error('CLI runtime is not ready for the selected session.')
    }
    const sessionRef = this.snapshot.sessionRef

    this.publish({
      ...this.snapshot,
      messages: upsertMessage(this.snapshot.messages, userMessage),
      runState: 'running',
      error: null,
    })
    if (!this.isCurrent(operation) || !this.acceptingEvents) return

    try {
      await operation.runtime.sendTurn({
        ...(sessionRef ? { sessionRef } : {}),
        content,
      })
      // Runtime notifications may arrive before sendTurn resolves. Do not
      // overwrite messages or a newer run state after the await.
    } catch (error) {
      if (this.isCurrent(operation)) this.publishError(error)
      throw error
    }
  }

  async cancel(): Promise<void> {
    this.assertActive()
    const operation = this.captureOperation()
    try {
      await operation.runtime.cancel()
      // Completion/abort may be notified before cancel resolves; the event is
      // the authoritative run state, so success does not publish another one.
    } catch (error) {
      if (this.isCurrent(operation)) this.publishError(error)
      throw error
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.runtimeEpoch += 1
    this.conversationEpoch += 1
    this.invalidateRuntimeSubscription()
    this.resetEventGate()
    this.listeners.clear()
  }

  private async ensureReadyNow(
    operation: ReturnType<CliConversationController['captureOperation']>,
    assistant: CliAssistantBinding,
  ): Promise<void> {
    const target = this.snapshot.sessionRef
    this.acceptingEvents = false
    this.bindingTarget = target
    this.bindingEpoch = operation.conversationEpoch
    this.publish({ ...this.snapshot, error: null })

    try {
      await operation.runtime.ensureReady({
        ...(target ? { sessionRef: target } : {}),
        assistant,
      })
      if (!this.isCurrent(operation)) return
      if (!target && !this.snapshot.sessionRef) {
        throw new Error('CLI runtime did not bind a session.')
      }
      this.acceptingEvents = true
      this.bindingTarget = undefined
      this.bindingEpoch = null
    } catch (error) {
      if (this.isCurrent(operation)) {
        this.resetEventGate()
        this.publishError(error)
      }
      throw error
    }
  }

  private beginSessionTransition(ref: CliSessionRef | null): void {
    this.conversationEpoch += 1
    this.resetEventGate()
    this.replaceRuntimeSubscription()
    this.publish({
      runtimeId: this.runtime.runtimeId,
      messages: Object.freeze([]),
      sessionRef: ref,
      runState: 'idle',
      error: null,
    })
  }

  private handleRuntimeEvent(
    event: CliRuntimeEvent,
    runtimeEpoch: number,
    conversationEpoch: number,
  ): void {
    if (
      this.disposed ||
      runtimeEpoch !== this.runtimeEpoch ||
      conversationEpoch !== this.conversationEpoch
    ) {
      return
    }

    if (event.type === 'session_bound') {
      if (event.ref.runtimeId !== this.runtime.runtimeId) return
      if (this.bindingEpoch === conversationEpoch) {
        if (
          this.bindingTarget &&
          !isSameSession(this.bindingTarget, event.ref)
        ) {
          return
        }
        this.acceptingEvents = true
        this.publish({ ...this.snapshot, sessionRef: event.ref, error: null })
        return
      }
      if (
        this.acceptingEvents &&
        isSameSession(this.snapshot.sessionRef, event.ref)
      ) {
        this.publish({ ...this.snapshot, sessionRef: event.ref })
      }
      return
    }

    if (!this.acceptingEvents) return
    if (event.type === 'message_upsert') {
      this.publish({
        ...this.snapshot,
        messages: upsertMessage(this.snapshot.messages, event.message),
      })
      return
    }
    if (event.type === 'message_remove') {
      const messages = this.snapshot.messages.filter(
        (message) => message.id !== event.messageId,
      )
      if (messages.length !== this.snapshot.messages.length) {
        this.publish({ ...this.snapshot, messages: Object.freeze(messages) })
      }
      return
    }
    this.publish({
      ...this.snapshot,
      runState: event.state,
      error: event.error ?? null,
    })
  }

  private subscribeToRuntime(): void {
    const runtimeEpoch = this.runtimeEpoch
    const conversationEpoch = this.conversationEpoch
    this.unsubscribeRuntime = this.runtime.subscribe((event) =>
      this.handleRuntimeEvent(event, runtimeEpoch, conversationEpoch),
    )
  }

  private replaceRuntimeSubscription(): void {
    this.invalidateRuntimeSubscription()
    this.subscribeToRuntime()
  }

  private invalidateRuntimeSubscription(): void {
    this.unsubscribeRuntime?.()
    this.unsubscribeRuntime = null
  }

  private resetEventGate(): void {
    this.acceptingEvents = false
    this.bindingTarget = undefined
    this.bindingEpoch = null
  }

  private captureOperation(): {
    runtime: CliRuntime
    runtimeEpoch: number
    conversationEpoch: number
  } {
    return {
      runtime: this.runtime,
      runtimeEpoch: this.runtimeEpoch,
      conversationEpoch: this.conversationEpoch,
    }
  }

  private isCurrent(operation: {
    runtime: CliRuntime
    runtimeEpoch: number
    conversationEpoch: number
  }): boolean {
    return (
      !this.disposed &&
      operation.runtime === this.runtime &&
      operation.runtimeEpoch === this.runtimeEpoch &&
      operation.conversationEpoch === this.conversationEpoch
    )
  }

  private assertRuntimeRef(ref: CliSessionRef): void {
    if (ref.runtimeId !== this.runtime.runtimeId) {
      throw new Error(
        `Cannot use ${ref.runtimeId} session with ${this.runtime.runtimeId} runtime.`,
      )
    }
  }

  private assertActive(): void {
    if (this.disposed)
      throw new Error('CLI conversation controller is disposed.')
  }

  private publishError(error: unknown): void {
    this.publish({
      ...this.snapshot,
      runState: 'error',
      error: getErrorMessage(error),
    })
  }

  private createEmptySnapshot(runtime: CliRuntime): CliConversationSnapshot {
    return Object.freeze({
      runtimeId: runtime.runtimeId,
      messages: Object.freeze([]),
      sessionRef: null,
      runState: 'idle',
      error: null,
    })
  }

  private publish(snapshot: CliConversationSnapshot): void {
    if (this.disposed) return
    this.snapshot = Object.freeze(snapshot)
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
