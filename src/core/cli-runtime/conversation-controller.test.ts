import type { ChatAssistantMessage, ChatUserMessage } from '../../types/chat'

import { CliConversationController } from './conversation-controller'
import type {
  CliApprovalResponse,
  CliQuestionResponse,
  CliRewriteTurnInput,
  CliRuntime,
  CliRuntimeConfiguration,
  CliRuntimeEvent,
  CliRuntimeEventListener,
  CliRuntimeId,
  CliRuntimeMcpServerStatus,
  CliRuntimeReadyInput,
  CliSessionHydration,
  CliSessionRef,
  CliTurnInput,
} from './types'

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
  readonly rewriteInputs: CliRewriteTurnInput[] = []
  readonly configurationUpdates: Array<{
    modelId?: string | null
    reasoningEffort?: string | null
  }> = []
  readonly permissionProfileUpdates: Array<{
    mode: 'agent' | 'plan'
    yoloEnabled: boolean
  }> = []
  openSessionImpl: (ref: CliSessionRef) => Promise<CliSessionHydration> =
    async (ref) => ({ ref, messages: [], compactionBoundaries: [] })
  ensureReadyImpl: (input: CliRuntimeReadyInput) => Promise<void> = async (
    input,
  ) => {
    this.emit({
      type: 'session_bound',
      ref: input.sessionRef ?? session(`new-${this.runtimeId}`, this.runtimeId),
    })
  }
  sendTurnImpl: (input: CliTurnInput) => Promise<void> = async () => undefined
  rewriteTurnImpl: (input: CliRewriteTurnInput) => Promise<void> = async () =>
    undefined
  cancelImpl: () => Promise<void> = async () => undefined
  compactImpl: () => Promise<void> = async () => undefined
  reloadPluginsCalls = 0
  // Assigned as an instance field (not a prototype method) so tests can
  // `delete` it to simulate a runtime that does not implement reloadPlugins.
  reloadPlugins = async (): Promise<void> => {
    this.reloadPluginsCalls += 1
  }
  mcpServerStatusResult: CliRuntimeMcpServerStatus[] = []
  // Same instance-field pattern as reloadPlugins, so tests can `delete` these
  // to simulate a runtime that does not implement the MCP status methods.
  mcpServerStatus = async (): Promise<CliRuntimeMcpServerStatus[]> =>
    this.mcpServerStatusResult
  readonly toggleMcpServerCalls: Array<{ name: string; enabled: boolean }> = []
  toggleMcpServer = async (name: string, enabled: boolean): Promise<void> => {
    this.toggleMcpServerCalls.push({ name, enabled })
  }
  readonly reconnectMcpServerCalls: string[] = []
  reconnectMcpServer = async (name: string): Promise<void> => {
    this.reconnectMcpServerCalls.push(name)
  }
  configuration: CliRuntimeConfiguration

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

  async updateConfiguration(update: {
    modelId?: string | null
    reasoningEffort?: string | null
  }) {
    this.configurationUpdates.push(update)
    this.configuration = { ...this.configuration, ...update }
    return this.getConfiguration()
  }

  async updatePermissionProfile(update: {
    mode: 'agent' | 'plan'
    yoloEnabled: boolean
  }) {
    this.permissionProfileUpdates.push(update)
  }

  async sendTurn(input: CliTurnInput): Promise<void> {
    this.turnInputs.push(input)
    await this.sendTurnImpl(input)
  }

  async rewriteTurn(input: Parameters<CliRuntime['rewriteTurn']>[0]) {
    this.rewriteInputs.push(input)
    await this.rewriteTurnImpl(input)
  }

  cancel(): Promise<void> {
    return this.cancelImpl()
  }

  compact(): Promise<void> {
    return this.compactImpl()
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
  it('exposes native compaction as pending until its boundary arrives', async () => {
    const runtime = new FakeCliRuntime()
    const compactGate = deferred<undefined>()
    runtime.compactImpl = () => compactGate.promise
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()
    runtime.emit({ type: 'run_state', state: 'completed' })

    const compactPromise = controller.compact()
    expect(controller.getSnapshot()).toMatchObject({
      isCompacting: true,
      runState: 'completed',
    })

    runtime.emit({
      type: 'compaction_boundary',
      boundary: {
        id: 'compact-boundary',
        trigger: 'manual',
      },
    })
    expect(controller.getSnapshot().isCompacting).toBe(false)
    expect(controller.getSnapshot().compactionBoundaries).toEqual([
      {
        id: 'compact-boundary',
        afterMessageId: null,
        trigger: 'manual',
      },
    ])

    compactGate.resolve(undefined)
    await compactPromise
  })

  it('keeps the surface identity stable when a fresh native session binds', async () => {
    const runtime = new FakeCliRuntime('codex')
    const controller = new CliConversationController(runtime)
    const initialSurfaceId = controller.getSnapshot().surfaceId

    await controller.ensureReady()

    expect(controller.getSnapshot()).toMatchObject({
      surfaceId: initialSurfaceId,
      sessionRef: session('new-codex'),
    })

    controller.resetSession()
    expect(controller.getSnapshot().surfaceId).not.toBe(initialSurfaceId)
  })

  it('presents a staged turn before provider readiness and scopes rejection', () => {
    const controller = new CliConversationController(
      new FakeCliRuntime('codex'),
    )
    const stagedTurn = controller.stageTurn(
      userMessage('optimistic-user', 'Visible immediately'),
    )

    expect(controller.getSnapshot()).toMatchObject({
      surfaceId: stagedTurn.surfaceId,
      runState: 'running',
      messages: [{ id: 'optimistic-user', role: 'user' }],
    })

    controller.resetSession()
    controller.rejectStagedTurn(stagedTurn, new Error('stale failure'))
    expect(controller.getSnapshot()).toMatchObject({
      runState: 'idle',
      error: null,
      messages: [],
    })
  })

  it('applies a preferred model and effort before publishing ready configuration', async () => {
    const runtime = new FakeCliRuntime()
    runtime.configuration = {
      models: [
        {
          id: 'sol',
          label: 'Sol',
          reasoningEfforts: [{ id: 'medium' }],
          isDefault: true,
        },
        {
          id: 'luna',
          label: 'Luna',
          reasoningEfforts: [{ id: 'medium' }],
        },
      ],
      modelId: 'sol',
      reasoningEffort: null,
    }
    const controller = new CliConversationController(runtime)

    await controller.ensureReady({
      modelId: 'luna',
      reasoningEffort: 'medium',
    })

    expect(runtime.configurationUpdates).toEqual([
      { modelId: 'luna', reasoningEffort: 'medium' },
    ])
    expect(controller.getSnapshot().configuration).toMatchObject({
      modelId: 'luna',
      reasoningEffort: 'medium',
    })
  })

  it('keeps a fresh conversation configurable without starting its runtime', async () => {
    const runtime = new FakeCliRuntime()
    const models = [
      {
        id: 'sol',
        label: 'Sol',
        reasoningEfforts: [{ id: 'medium' }],
        isDefault: true,
      },
      {
        id: 'luna',
        label: 'Luna',
        reasoningEfforts: [{ id: 'medium' }],
      },
    ]
    runtime.configuration = {
      models,
      modelId: 'sol',
      reasoningEffort: null,
    }
    const controller = new CliConversationController(runtime, () => models)

    controller.stageConfiguration({
      modelId: 'luna',
      reasoningEffort: 'medium',
    })
    await expect(
      controller.updateConfiguration({ reasoningEffort: null }),
    ).resolves.toMatchObject({ modelId: 'luna', reasoningEffort: null })

    expect(runtime.readyInputs).toEqual([])
    expect(runtime.configurationUpdates).toEqual([])
    expect(controller.getSnapshot()).toMatchObject({
      sessionRef: null,
      configuration: { modelId: 'luna', reasoningEffort: null },
    })

    await controller.ensureReady()

    expect(runtime.readyInputs).toHaveLength(1)
    expect(runtime.configurationUpdates).toEqual([
      { modelId: 'luna', reasoningEffort: null },
    ])
  })

  it('hydrates messages, upserts by stable id in place, and removes by id', async () => {
    const runtime = new FakeCliRuntime()
    const ref = session('existing')
    runtime.openSessionImpl = async () => ({
      ref: { ...ref, sessionPathHint: '/native/session.jsonl' },
      messages: [userMessage('user-1'), assistantMessage('assistant-1', 'old')],
      compactionBoundaries: [],
    })
    const controller = new CliConversationController(runtime)

    await expect(controller.hydrateSession(ref)).resolves.toMatchObject({
      ref: {
        runtimeId: 'codex',
        nativeSessionId: 'existing',
        sessionPathHint: '/native/session.jsonl',
      },
    })
    await controller.ensureReady()
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

  it('mirrors context_usage into the conversation snapshot', async () => {
    const runtime = new FakeCliRuntime()
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    runtime.emit({
      type: 'context_usage',
      usage: { promptTokens: 4200, maxContextTokens: 200_000 },
    })

    expect(controller.getSnapshot().contextUsage).toEqual({
      promptTokens: 4200,
      maxContextTokens: 200_000,
    })

    controller.resetSession()
    expect(controller.getSnapshot().contextUsage).toBeNull()
  })

  it('attaches turn metrics to the latest top-level assistant message', async () => {
    const runtime = new FakeCliRuntime()
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    controller.stageTurn(userMessage('user-1'))
    runtime.emit({
      type: 'message_upsert',
      message: assistantMessage('assistant-1'),
    })
    runtime.emit({
      type: 'turn_metrics',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cache_read_input_tokens: 40,
      },
      durationMs: 500,
    })

    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      id: 'assistant-1',
      metadata: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          cache_read_input_tokens: 40,
        },
        durationMs: 500,
      },
    })

    runtime.emit({
      type: 'message_upsert',
      message: assistantMessage('assistant-2'),
    })
    expect(controller.getSnapshot().messages).toMatchObject([
      { id: 'user-1' },
      { id: 'assistant-1', metadata: {} },
      { id: 'assistant-2', metadata: { durationMs: 500 } },
    ])
  })

  it('ignores native compaction metrics instead of overwriting the prior turn', async () => {
    const runtime = new FakeCliRuntime()
    const ref = session('metrics-before-compact')
    runtime.openSessionImpl = async () => ({
      ref,
      messages: [
        userMessage('user-1'),
        {
          ...assistantMessage('assistant-1'),
          metadata: {
            usage: {
              prompt_tokens: 8_900,
              completion_tokens: 132,
              total_tokens: 9_032,
            },
            durationMs: 4_400,
          },
        },
      ],
      compactionBoundaries: [],
    })
    const controller = new CliConversationController(runtime)
    await controller.hydrateSession(ref)
    await controller.ensureReady()

    await controller.compact()
    runtime.emit({
      type: 'turn_metrics',
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      durationMs: 7_300,
    })

    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      metadata: {
        usage: {
          prompt_tokens: 8_900,
          completion_tokens: 132,
          total_tokens: 9_032,
        },
        durationMs: 4_400,
      },
    })
  })

  it('merges a restored cache hit rate into fresh provider context usage', async () => {
    const runtime = new FakeCliRuntime('claude-code')
    const ref = session('restored-usage', 'claude-code')
    const controller = new CliConversationController(runtime)
    await controller.hydrateSession(ref, async (messages) => ({
      messages,
      turnConfigurationByUserMessageId: {},
      lastCacheHitRate: 0.6,
    }))
    await controller.ensureReady()

    runtime.emit({
      type: 'context_usage',
      usage: { promptTokens: 4200, maxContextTokens: 200_000 },
    })

    expect(controller.getSnapshot().contextUsage).toEqual({
      promptTokens: 4200,
      maxContextTokens: 200_000,
      cacheHitRate: 0.6,
    })
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
      compactionBoundaries: [],
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

    await controller.ensureReady()
    expect(runtime.readyInputs).toEqual([{ sessionRef: ref }])
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
    await controller.ensureReady()

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
        userMessageId: 'user-optimistic',
        content: 'hello',
      },
    ])
  })

  it('reconciles the provider user echo with the optimistic user turn', async () => {
    const runtime = new FakeCliRuntime('codex')
    runtime.sendTurnImpl = async () => {
      runtime.emit({ type: 'run_state', state: 'running' })
      runtime.emit({
        type: 'message_upsert',
        message: userMessage(
          'codex-user-native-1',
          '<current_time>2026-07-31 14:09 (Friday)</current_time>\n\n在吗',
        ),
      })
      runtime.emit({
        type: 'message_upsert',
        message: userMessage(
          'codex-user-native-1',
          '<current_time>2026-07-31 14:09 (Friday)</current_time>\n\n在吗',
        ),
      })
    }
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    await controller.sendTurn({
      userMessage: userMessage('user-optimistic', '在吗'),
      content: '<current_time>2026-07-31 14:09 (Friday)</current_time>\n\n在吗',
    })

    expect(controller.getSnapshot().messages).toHaveLength(1)
    expect(controller.getSnapshot().messages[0]).toMatchObject({
      role: 'user',
      id: 'codex-user-native-1',
      promptContent: '在吗',
    })
    expect(controller.getSnapshot().turnConfigurationByUserMessageId).toEqual({
      'codex-user-native-1': {
        modelId: 'codex-model',
        reasoningEffort: null,
      },
    })
  })

  it('rewrites the selected user turn in place and accepts a rebound session', async () => {
    const runtime = new FakeCliRuntime('claude-code')
    const originalRef = session('original', 'claude-code')
    const replacementRef = session('replacement', 'claude-code')
    runtime.openSessionImpl = async () => ({
      ref: originalRef,
      messages: [
        userMessage('user-1', 'first'),
        assistantMessage('assistant-1', 'first answer'),
        userMessage('user-2', 'second'),
        assistantMessage('assistant-2', 'second answer'),
      ],
      compactionBoundaries: [],
    })
    runtime.rewriteTurnImpl = async () => {
      runtime.emit({ type: 'session_bound', ref: replacementRef })
      runtime.emit({
        type: 'message_upsert',
        message: assistantMessage('assistant-rewritten', 'new answer'),
      })
    }
    const controller = new CliConversationController(runtime)
    await controller.hydrateSession(originalRef)
    await controller.ensureReady()

    await controller.rewriteTurn({
      sourceUserMessageId: 'user-2',
      userMessage: userMessage('user-2', 'edited second'),
      content: 'edited second',
    })

    expect(controller.getSnapshot()).toMatchObject({
      sessionRef: replacementRef,
      messages: [
        { id: 'user-1' },
        { id: 'assistant-1' },
        { id: 'user-2', promptContent: 'edited second' },
        { id: 'assistant-rewritten' },
      ],
    })
    expect(runtime.rewriteInputs[0]).toMatchObject({
      sessionRef: originalRef,
      sourceUserMessageId: 'user-2',
      userMessageId: 'user-2',
      content: 'edited second',
    })
  })

  it('does not dispatch a turn when an optimistic listener resets the session', async () => {
    const codex = new FakeCliRuntime('codex')
    const controller = new CliConversationController(codex)
    await controller.ensureReady()
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
        : Promise.resolve({
            ref,
            messages: [userMessage('second-user')],
            compactionBoundaries: [],
          })
    const controller = new CliConversationController(runtime)

    const first = controller.hydrateSession(session('first'))
    const staleListener = runtime.subscribedListeners.at(-1)!
    await controller.hydrateSession(session('second'))
    await controller.ensureReady()

    staleListener({
      type: 'message_upsert',
      message: assistantMessage('stale-event'),
    })
    firstHydration.resolve({
      ref: session('first'),
      messages: [userMessage('stale-hydration')],
      compactionBoundaries: [],
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
    await controller.ensureReady()
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
    await controller.ensureReady()
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
    await controller.ensureReady()
    const message = userMessage('failed-user')

    await expect(
      controller.sendTurn({ userMessage: message, content: 'failed' }),
    ).rejects.toThrow('send failed')
    expect(controller.getSnapshot().messages).toContain(message)
    expect(controller.getSnapshot()).toMatchObject({
      runState: 'error',
      error: 'send failed',
    })
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '',
      metadata: {
        generationState: 'error',
        errorMessage: 'send failed',
        sourceUserMessageId: 'failed-user',
      },
    })
  })

  it('exposes cancel errors without losing the current transcript', async () => {
    const runtime = new FakeCliRuntime()
    runtime.cancelImpl = async () => {
      throw new Error('cancel failed')
    }
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()
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

  it('serializes permission profile updates and skips an already applied profile', async () => {
    const runtime = new FakeCliRuntime('codex')
    const controller = new CliConversationController(runtime)

    await controller.updatePermissionProfile({
      mode: 'agent',
      yoloEnabled: true,
    })
    await controller.updatePermissionProfile({
      mode: 'agent',
      yoloEnabled: true,
    })
    await controller.updatePermissionProfile({
      mode: 'plan',
      yoloEnabled: false,
    })

    expect(runtime.permissionProfileUpdates).toEqual([
      { mode: 'agent', yoloEnabled: true },
      { mode: 'plan', yoloEnabled: false },
    ])
  })

  it('reloadPlugins delegates to the runtime when supported', async () => {
    const runtime = new FakeCliRuntime('claude-code')
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    await controller.reloadPlugins()

    expect(runtime.reloadPluginsCalls).toBe(1)
  })

  it('reloadPlugins no-ops when the runtime does not support it', async () => {
    const runtime = new FakeCliRuntime('claude-code')
    delete (runtime as unknown as { reloadPlugins?: () => Promise<void> })
      .reloadPlugins
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    await expect(controller.reloadPlugins()).resolves.toBeUndefined()
  })

  it('mcpServerStatus delegates to the runtime when supported', async () => {
    const runtime = new FakeCliRuntime('claude-code')
    runtime.mcpServerStatusResult = [
      { name: 'github', status: 'connected', readOnly: false },
    ]
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    await expect(controller.mcpServerStatus()).resolves.toEqual([
      { name: 'github', status: 'connected', readOnly: false },
    ])
  })

  it('mcpServerStatus returns an empty list when the runtime does not support it', async () => {
    const runtime = new FakeCliRuntime('codex')
    delete (
      runtime as unknown as {
        mcpServerStatus?: () => Promise<CliRuntimeMcpServerStatus[]>
      }
    ).mcpServerStatus
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    await expect(controller.mcpServerStatus()).resolves.toEqual([])
  })

  it('toggleMcpServer delegates to the runtime when supported', async () => {
    const runtime = new FakeCliRuntime('claude-code')
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    await controller.toggleMcpServer('github', false)

    expect(runtime.toggleMcpServerCalls).toEqual([
      { name: 'github', enabled: false },
    ])
  })

  it('toggleMcpServer throws when the runtime does not support it', async () => {
    const runtime = new FakeCliRuntime('codex')
    delete (
      runtime as unknown as {
        toggleMcpServer?: (name: string, enabled: boolean) => Promise<void>
      }
    ).toggleMcpServer
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    await expect(controller.toggleMcpServer('github', true)).rejects.toThrow(
      'does not support toggling MCP servers',
    )
  })

  it('reconnectMcpServer delegates to the runtime when supported', async () => {
    const runtime = new FakeCliRuntime('claude-code')
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    await controller.reconnectMcpServer('github')

    expect(runtime.reconnectMcpServerCalls).toEqual(['github'])
  })

  it('reconnectMcpServer throws when the runtime does not support it', async () => {
    const runtime = new FakeCliRuntime('codex')
    delete (
      runtime as unknown as {
        reconnectMcpServer?: (name: string) => Promise<void>
      }
    ).reconnectMcpServer
    const controller = new CliConversationController(runtime)
    await controller.ensureReady()

    await expect(controller.reconnectMcpServer('github')).rejects.toThrow(
      'does not support reconnecting MCP servers',
    )
  })
})
