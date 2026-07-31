import type { ChatAssistantMessage, ChatUserMessage } from '../../types/chat'

import { CliConversationController } from './conversation-controller'
import type {
  CliApprovalResponse,
  CliQuestionResponse,
  CliRuntime,
  CliRuntimeConfiguration,
  CliRuntimeEvent,
  CliRuntimeEventListener,
  CliRuntimeId,
  CliRuntimeReadyInput,
  CliSessionHydration,
  CliSessionMetadata,
  CliSessionRef,
  CliTurnInput,
} from './types'

const assistant = {
  assistantId: 'assistant-1',
  systemPrompt: 'Be concise.',
  enabledSkillNames: ['review'],
}

const session = (
  nativeSessionId: string,
  runtimeId: CliRuntimeId = 'codex',
): CliSessionRef => ({ runtimeId, nativeSessionId })

const userMessage = (id: string, text = id): ChatUserMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: text,
  mentionables: [],
})

const assistantMessage = (id: string, content = id): ChatAssistantMessage => ({
  role: 'assistant',
  id,
  content,
})

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

class FakeCliRuntime implements CliRuntime {
  readonly listeners = new Set<CliRuntimeEventListener>()
  readonly subscribedListeners: CliRuntimeEventListener[] = []
  readonly readyInputs: CliRuntimeReadyInput[] = []
  readonly turnInputs: CliTurnInput[] = []
  openSessionImpl: (ref: CliSessionRef) => Promise<CliSessionHydration> =
    async (ref) => ({ ref, messages: [] })
  ensureReadyImpl: (input: CliRuntimeReadyInput) => Promise<void> = async (
    input,
  ) => {
    this.emit({
      type: 'session_bound',
      ref: input.sessionRef ?? session(`new-${this.runtimeId}`, this.runtimeId),
    })
  }
  sendTurnImpl: (input: CliTurnInput) => Promise<void> = async () => undefined
  cancelImpl: () => Promise<void> = async () => undefined
  readonly configuration: CliRuntimeConfiguration

  constructor(readonly runtimeId: CliRuntimeId = 'codex') {
    this.configuration = {
      models: [
        {
          id: `${runtimeId}-model`,
          label: `${runtimeId} model`,
          reasoningEfforts: [],
          isDefault: true,
        },
      ],
      modelId: `${runtimeId}-model`,
      reasoningEffort: null,
    }
  }

  async listSessions(): Promise<CliSessionMetadata[]> {
    return []
  }

  openSession(ref: CliSessionRef): Promise<CliSessionHydration> {
    return this.openSessionImpl(ref)
  }

  async ensureReady(input: CliRuntimeReadyInput): Promise<void> {
    this.readyInputs.push(input)
    await this.ensureReadyImpl(input)
  }

  async getConfiguration() {
    return this.configuration
  }

  async updateConfiguration() {
    return this.getConfiguration()
  }

  async sendTurn(input: CliTurnInput): Promise<void> {
    this.turnInputs.push(input)
    await this.sendTurnImpl(input)
  }

  cancel(): Promise<void> {
    return this.cancelImpl()
  }

  async respondApproval(_response: CliApprovalResponse): Promise<boolean> {
    return false
  }

  async respondQuestion(_response: CliQuestionResponse): Promise<boolean> {
    return false
  }

  subscribe(listener: CliRuntimeEventListener): () => void {
    this.listeners.add(listener)
    this.subscribedListeners.push(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {}

  emit(event: CliRuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

describe('CliConversationController', () => {
  it('hydrates messages, upserts by stable id in place, and removes by id', async () => {
    const runtime = new FakeCliRuntime()
    const ref = session('existing')
    runtime.openSessionImpl = async () => ({
      ref: { ...ref, sessionPathHint: '/native/session.jsonl' },
      messages: [userMessage('user-1'), assistantMessage('assistant-1', 'old')],
    })
    const controller = new CliConversationController(runtime)

    await expect(controller.hydrateSession(ref)).resolves.toMatchObject({
      ref: {
        runtimeId: 'codex',
        nativeSessionId: 'existing',
        sessionPathHint: '/native/session.jsonl',
      },
    })
    await controller.ensureReady(assistant)
    expect(controller.getSnapshot()).toMatchObject({
      sessionRef: {
        runtimeId: 'codex',
        nativeSessionId: 'existing',
        sessionPathHint: '/native/session.jsonl',
      },
      runState: 'idle',
    })
    expect(
      controller.getSnapshot().messages.map((message) => message.id),
    ).toEqual(['user-1', 'assistant-1'])

    runtime.emit({
      type: 'message_upsert',
      message: assistantMessage('assistant-2', 'streaming'),
    })
    runtime.emit({
      type: 'message_upsert',
      message: assistantMessage('assistant-1', 'updated'),
    })
    expect(controller.getSnapshot().messages).toMatchObject([
      { id: 'user-1' },
      { id: 'assistant-1', content: 'updated' },
      { id: 'assistant-2', content: 'streaming' },
    ])

    runtime.emit({ type: 'message_remove', messageId: 'assistant-1' })
    expect(
      controller.getSnapshot().messages.map((message) => message.id),
    ).toEqual(['user-1', 'assistant-2'])
  })

  it('deduplicates hydrated message ids in linear order with the last content', async () => {
    const runtime = new FakeCliRuntime()
    const ref = session('duplicate-transcript')
    runtime.openSessionImpl = async () => ({
      ref,
      messages: [
        assistantMessage('duplicate', 'first'),
        userMessage('between'),
        assistantMessage('duplicate', 'last'),
      ],
    })
    const controller = new CliConversationController(runtime)

    await controller.hydrateSession(ref)

    expect(controller.getSnapshot().messages).toMatchObject([
      { id: 'duplicate', content: 'last' },
      { id: 'between' },
    ])
  })

  it('binds the hydrated session and reflects every runtime run state', async () => {
    const runtime = new FakeCliRuntime()
    const ref = session('resume-me')
    const controller = new CliConversationController(runtime)
    await controller.hydrateSession(ref)

    await controller.ensureReady(assistant)
    expect(runtime.readyInputs).toEqual([{ sessionRef: ref, assistant }])
    expect(controller.getSnapshot().sessionRef).toEqual(ref)

    const states = [
      'running',
      'waiting_for_approval',
      'waiting_for_user',
      'completed',
      'aborted',
      'error',
    ] as const
    for (const state of states) {
      runtime.emit({
        type: 'run_state',
        state,
        ...(state === 'error' ? { error: 'native failure' } : {}),
      })
      expect(controller.getSnapshot().runState).toBe(state)
    }
    expect(controller.getSnapshot().error).toBe('native failure')
  })

  it('preserves events delivered before sendTurn resolves', async () => {
    const runtime = new FakeCliRuntime()
    const send = deferred<undefined>()
    runtime.sendTurnImpl = () => {
      runtime.emit({
        type: 'message_upsert',
        message: assistantMessage('assistant-stream', 'done early'),
      })
      runtime.emit({ type: 'run_state', state: 'completed' })
      return send.promise
    }
    const controller = new CliConversationController(runtime)
    await controller.ensureReady(assistant)

    const message = userMessage('user-optimistic', 'hello')
    const sending = controller.sendTurn({
      userMessage: message,
      content: 'hello',
    })
    expect(controller.getSnapshot().messages[0]).toBe(message)
    expect(controller.getSnapshot()).toMatchObject({ runState: 'completed' })
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      id: 'assistant-stream',
      content: 'done early',
    })

    send.resolve(undefined)
    await sending
    expect(controller.getSnapshot().runState).toBe('completed')
    expect(runtime.turnInputs).toEqual([
      {
        sessionRef: session('new-codex'),
        content: 'hello',
      },
    ])
  })

  it('does not dispatch a turn when an optimistic listener resets the session', async () => {
    const codex = new FakeCliRuntime('codex')
    const controller = new CliConversationController(codex)
    await controller.ensureReady(assistant)
    let reset = false
    controller.subscribe(() => {
      if (reset) return
      reset = true
      controller.resetSession()
    })

    await controller.sendTurn({
      userMessage: userMessage('reentrant-user'),
      content: 'must not dispatch',
    })

    expect(codex.turnInputs).toEqual([])
    expect(controller.getSnapshot()).toMatchObject({
      runtimeId: 'codex',
      sessionRef: null,
      messages: [],
      runState: 'idle',
    })
  })

  it('ignores stale hydration and event callbacks after a session switch', async () => {
    const runtime = new FakeCliRuntime()
    const firstHydration = deferred<CliSessionHydration>()
    runtime.openSessionImpl = (ref) =>
      ref.nativeSessionId === 'first'
        ? firstHydration.promise
        : Promise.resolve({ ref, messages: [userMessage('second-user')] })
    const controller = new CliConversationController(runtime)

    const first = controller.hydrateSession(session('first'))
    const staleListener = runtime.subscribedListeners.at(-1)!
    await controller.hydrateSession(session('second'))
    await controller.ensureReady(assistant)

    staleListener({
      type: 'message_upsert',
      message: assistantMessage('stale-event'),
    })
    firstHydration.resolve({
      ref: session('first'),
      messages: [userMessage('stale-hydration')],
    })
    await first

    expect(controller.getSnapshot().sessionRef).toEqual(session('second'))
    expect(
      controller.getSnapshot().messages.map((message) => message.id),
    ).toEqual(['second-user'])
  })

  it('isolates old runtime callbacks after resetting the session', async () => {
    const runtime = new FakeCliRuntime('codex')
    const controller = new CliConversationController(runtime)
    const staleListener = runtime.subscribedListeners[0]

    controller.resetSession()
    await controller.ensureReady(assistant)
    runtime.emit({
      type: 'message_upsert',
      message: assistantMessage('current-message'),
    })
    staleListener({
      type: 'message_upsert',
      message: assistantMessage('stale-message'),
    })

    expect(controller.getSnapshot().runtimeId).toBe('codex')
    expect(
      controller.getSnapshot().messages.map((message) => message.id),
    ).toEqual(['current-message'])
  })

  it('unsubscribes and ignores outstanding callbacks when disposed', async () => {
    const runtime = new FakeCliRuntime()
    const controller = new CliConversationController(runtime)
    await controller.ensureReady(assistant)
    const staleListener = runtime.subscribedListeners[0]
    const beforeDispose = controller.getSnapshot()

    controller.dispose()
    staleListener({
      type: 'message_upsert',
      message: assistantMessage('after-dispose'),
    })

    expect(runtime.listeners.size).toBe(0)
    expect(controller.getSnapshot()).toBe(beforeDispose)
    expect(() => controller.resetSession()).toThrow('disposed')
  })

  it('keeps the optimistic user message and exposes a send error', async () => {
    const runtime = new FakeCliRuntime()
    runtime.sendTurnImpl = async () => {
      throw new Error('send failed')
    }
    const controller = new CliConversationController(runtime)
    await controller.ensureReady(assistant)
    const message = userMessage('failed-user')

    await expect(
      controller.sendTurn({ userMessage: message, content: 'failed' }),
    ).rejects.toThrow('send failed')
    expect(controller.getSnapshot().messages).toContain(message)
    expect(controller.getSnapshot()).toMatchObject({
      runState: 'error',
      error: 'send failed',
    })
  })

  it('exposes cancel errors without losing the current transcript', async () => {
    const runtime = new FakeCliRuntime()
    runtime.cancelImpl = async () => {
      throw new Error('cancel failed')
    }
    const controller = new CliConversationController(runtime)
    await controller.ensureReady(assistant)
    runtime.emit({
      type: 'message_upsert',
      message: assistantMessage('keep-me'),
    })

    await expect(controller.cancel()).rejects.toThrow('cancel failed')
    expect(controller.getSnapshot()).toMatchObject({
      runState: 'error',
      error: 'cancel failed',
      messages: [{ id: 'keep-me' }],
    })
  })
})
