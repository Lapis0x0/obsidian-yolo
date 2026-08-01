import { FileSystemAdapter, Platform } from 'obsidian'

import type { CliRuntimeFactories } from './coordinator'
import { createDesktopCliRuntimeCoordinator } from './coordinator'
import type { CliSessionIndexStore } from './session-index'
import type {
  CliRuntime,
  CliRuntimeEvent,
  CliRuntimeEventListener,
} from './types'

class TestFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }

  getBasePath(): string {
    return this.basePath
  }
}

const createApp = (adapter: object) =>
  ({ vault: { adapter } }) as Parameters<
    typeof createDesktopCliRuntimeCoordinator
  >[0]['app']

const indexStore = (): CliSessionIndexStore => ({
  list: async () => [],
  get: async () => null,
  upsert: async () => undefined,
  update: async (_ref, mutator) => mutator(null),
  remove: async () => false,
})

class TestRuntime implements CliRuntime {
  readonly listeners = new Set<CliRuntimeEventListener>()
  readonly cancel = jest.fn(async () => undefined)
  readonly dispose = jest.fn(async () => undefined)

  constructor(readonly runtimeId: 'claude-code' | 'codex') {}

  async openSession(ref: Parameters<CliRuntime['openSession']>[0]) {
    return { ref, messages: [] }
  }

  async ensureReady(input: Parameters<CliRuntime['ensureReady']>[0]) {
    this.emit({
      type: 'session_bound',
      ref: input.sessionRef ?? {
        runtimeId: this.runtimeId,
        nativeSessionId: `${this.runtimeId}-session`,
      },
    })
  }

  async getConfiguration() {
    return { models: [], modelId: null, reasoningEffort: null }
  }

  async updateConfiguration() {
    return this.getConfiguration()
  }

  async sendTurn() {}

  async rewriteTurn() {}

  async respondApproval() {
    return true
  }

  async respondQuestion() {
    return true
  }

  subscribe(listener: CliRuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: CliRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

const runtimeHarness = () => {
  const claudeRuntimes: TestRuntime[] = []
  const codexRuntimes: TestRuntime[] = []
  const createClaudeRuntime = jest.fn(() => {
    const runtime = new TestRuntime('claude-code')
    claudeRuntimes.push(runtime)
    return runtime
  })
  const createCodexRuntime = jest.fn(() => {
    const runtime = new TestRuntime('codex')
    codexRuntimes.push(runtime)
    return runtime
  })
  const factories: CliRuntimeFactories = {
    createClaudeRuntime,
    createCodexRuntime,
  }
  return {
    claudeRuntimes,
    codexRuntimes,
    createClaudeRuntime,
    createCodexRuntime,
    factories,
  }
}

const createCoordinator = async (
  harness = runtimeHarness(),
  basePath = '/vault/root',
) => ({
  harness,
  coordinator: await createDesktopCliRuntimeCoordinator({
    app: createApp(new TestFileSystemAdapter(basePath)),
    loadRuntimeFactories: () => harness.factories,
    createSessionIndexStore: indexStore,
  }),
})

describe('CLI runtime coordinator', () => {
  const originalIsDesktop = Platform.isDesktop

  beforeEach(() => {
    Platform.isDesktop = true
  })

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  it('refuses mobile before loading or invoking provider factories', async () => {
    Platform.isDesktop = false
    const harness = runtimeHarness()
    const loadRuntimeFactories = jest.fn(() => harness.factories)

    await expect(
      createDesktopCliRuntimeCoordinator({
        app: createApp(new TestFileSystemAdapter('/vault')),
        loadRuntimeFactories,
      }),
    ).rejects.toThrow(/only available on desktop/)
    expect(loadRuntimeFactories).not.toHaveBeenCalled()
    expect(harness.createClaudeRuntime).not.toHaveBeenCalled()
    expect(harness.createCodexRuntime).not.toHaveBeenCalled()
  })

  it('refuses non-file-system vaults before loading factories', async () => {
    const loadRuntimeFactories = jest.fn(() => runtimeHarness().factories)

    await expect(
      createDesktopCliRuntimeCoordinator({
        app: createApp({}),
        loadRuntimeFactories,
      }),
    ).rejects.toThrow(/file-system-backed vault/)
    expect(loadRuntimeFactories).not.toHaveBeenCalled()
  })

  it('creates each provider lazily once per scope with current absolute cwd and options', async () => {
    const harness = runtimeHarness()
    const getClaudeRuntimeOptions = jest.fn(() => ({
      configuredCliPath: '/bin/claude',
    }))
    const getCodexRuntimeOptions = jest.fn(() => ({ command: '/bin/codex' }))
    const coordinator = await createDesktopCliRuntimeCoordinator({
      app: createApp(new TestFileSystemAdapter('/vault/current')),
      getClaudeRuntimeOptions,
      getCodexRuntimeOptions,
      loadRuntimeFactories: () => harness.factories,
      createSessionIndexStore: indexStore,
    })
    const scope = coordinator.createScope()

    expect(harness.createClaudeRuntime).not.toHaveBeenCalled()
    expect(harness.createCodexRuntime).not.toHaveBeenCalled()
    expect(scope.resolveRuntime('claude-code')).toBe(
      scope.resolveRuntime('claude-code'),
    )
    expect(harness.createClaudeRuntime).toHaveBeenCalledTimes(1)
    expect(harness.createClaudeRuntime).toHaveBeenCalledWith({
      configuredCliPath: '/bin/claude',
      vaultPath: '/vault/current',
    })
    expect(scope.resolveRuntime('codex')).toBe(scope.resolveRuntime('codex'))
    expect(harness.createCodexRuntime).toHaveBeenCalledTimes(1)
    expect(harness.createCodexRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/bin/codex',
        cwd: '/vault/current',
        resolveHost: expect.any(Function),
      }),
    )
    expect(getClaudeRuntimeOptions).toHaveBeenCalledTimes(1)
    expect(getCodexRuntimeOptions).toHaveBeenCalledTimes(1)
  })

  it('rejects a relative vault cwd without invoking a provider factory', async () => {
    const { coordinator, harness } = await createCoordinator(
      runtimeHarness(),
      'relative/vault',
    )

    expect(() =>
      coordinator.createScope().resolveRuntime('claude-code'),
    ).toThrow(/absolute vault path/)
    expect(harness.createClaudeRuntime).not.toHaveBeenCalled()
  })

  it('shares service and action routing inside a scope', async () => {
    const { coordinator, harness } = await createCoordinator()
    const scope = coordinator.createScope()

    expect(scope.sessionService).toBe(scope.sessionService)
    expect(scope.chatRuntimeActions).toBe(scope.chatRuntimeActions)
    const controller = scope.createConversationRuntime('codex')
    await controller.ensureReady()
    await scope.chatRuntimeActions.cancelRun({
      runtimeId: 'codex',
      nativeSessionId: 'codex-session',
    })

    expect(harness.createClaudeRuntime).not.toHaveBeenCalled()
    expect(harness.createCodexRuntime).toHaveBeenCalledTimes(1)
    expect(harness.codexRuntimes[0].cancel).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate a runtime when actions first access it concurrently', async () => {
    const { coordinator, harness } = await createCoordinator()
    const scope = coordinator.createScope()
    const conversation = {
      runtimeId: 'codex' as const,
      nativeSessionId: 'codex-session',
    }
    const controller = scope.createConversationRuntime('codex')
    await controller.ensureReady()

    await Promise.all([
      scope.chatRuntimeActions.cancelRun(conversation),
      scope.chatRuntimeActions.cancelRun(conversation),
    ])

    expect(harness.createCodexRuntime).toHaveBeenCalledTimes(1)
    expect(harness.codexRuntimes[0].cancel).toHaveBeenCalledTimes(2)
  })

  it('keeps one controller per provider and isolates their timelines', async () => {
    const { coordinator, harness } = await createCoordinator()
    const scope = coordinator.createScope()
    const claudeController = scope.selectConversationRuntime('claude-code')
    const codexController = scope.selectConversationRuntime('codex')

    expect(codexController).not.toBe(claudeController)
    expect(scope.selectConversationRuntime('claude-code')).toBe(
      claudeController,
    )
    expect(scope.selectConversationRuntime('codex')).toBe(codexController)

    await claudeController.ensureReady()
    await codexController.ensureReady()
    harness.claudeRuntimes[0].emit({
      type: 'run_state',
      state: 'running',
    })
    harness.codexRuntimes[0].emit({
      type: 'run_state',
      state: 'error',
      error: 'codex error',
    })

    expect(claudeController.getSnapshot().runState).toBe('running')
    expect(codexController.getSnapshot()).toMatchObject({
      runtimeId: 'codex',
      runState: 'error',
      error: 'codex error',
    })
  })

  it('gives concurrent views shared plugin-lifetime services and isolated selections', async () => {
    const { coordinator, harness } = await createCoordinator()
    const first = coordinator.createScope()
    const second = coordinator.createScope()

    expect(first.resolveRuntime('claude-code')).toBe(
      second.resolveRuntime('claude-code'),
    )
    expect(first.sessionService).toBe(second.sessionService)
    expect(first.selectConversationRuntime('claude-code')).not.toBe(
      second.selectConversationRuntime('claude-code'),
    )

    await first.dispose()
    expect(harness.claudeRuntimes[0].dispose).not.toHaveBeenCalled()
    expect(second.resolveRuntime('claude-code')).toBe(harness.claudeRuntimes[0])

    const coordinatorDispose = coordinator.dispose()
    expect(coordinator.dispose()).toBe(coordinatorDispose)
    await coordinatorDispose
    expect(harness.claudeRuntimes[0].dispose).toHaveBeenCalledTimes(1)
    expect(() => coordinator.createScope()).toThrow(/coordinator is disposed/)
  })

  it('keeps controllers alive after view disposal and disposes them with the plugin', async () => {
    const { coordinator, harness } = await createCoordinator()
    const scope = coordinator.createScope()
    const claudeController = scope.selectConversationRuntime('claude-code')
    const codexController = scope.selectConversationRuntime('codex')
    const disposeClaudeController = jest.spyOn(claudeController, 'dispose')
    const disposeCodexController = jest.spyOn(codexController, 'dispose')

    await scope.dispose()
    expect(disposeClaudeController).not.toHaveBeenCalled()
    expect(disposeCodexController).not.toHaveBeenCalled()
    await coordinator.dispose()
    expect(disposeClaudeController).toHaveBeenCalledTimes(1)
    expect(disposeCodexController).toHaveBeenCalledTimes(1)
    expect(harness.claudeRuntimes[0].dispose).toHaveBeenCalledTimes(1)
    expect(harness.codexRuntimes[0].dispose).toHaveBeenCalledTimes(1)
    expect(disposeClaudeController.mock.invocationCallOrder[0]).toBeLessThan(
      harness.claudeRuntimes[0].dispose.mock.invocationCallOrder[0],
    )
  })

  it('disposes partial creation and settles all runtimes when one disposal fails', async () => {
    const harness = runtimeHarness()
    harness.createCodexRuntime.mockImplementation(() => {
      throw new Error('codex factory failed')
    })
    const { coordinator } = await createCoordinator(harness)
    const partialScope = coordinator.createScope()
    partialScope.resolveRuntime('claude-code')
    expect(() => partialScope.resolveRuntime('codex')).toThrow(
      'codex factory failed',
    )
    await partialScope.dispose()
    await coordinator.dispose()
    expect(harness.claudeRuntimes[0].dispose).toHaveBeenCalledTimes(1)

    const completeHarness = runtimeHarness()
    const complete = await createCoordinator(completeHarness)
    const scope = complete.coordinator.createScope()
    expect(scope.sessionService).toBeDefined()
    expect(completeHarness.createClaudeRuntime).not.toHaveBeenCalled()
    expect(completeHarness.createCodexRuntime).not.toHaveBeenCalled()
    scope.resolveRuntime('claude-code')
    scope.resolveRuntime('codex')
    completeHarness.claudeRuntimes[0].dispose.mockRejectedValueOnce(
      new Error('claude dispose failed'),
    )
    await scope.dispose()
    const dispose = complete.coordinator.dispose()
    await expect(dispose).rejects.toThrow('claude dispose failed')
    expect(completeHarness.codexRuntimes[0].dispose).toHaveBeenCalledTimes(1)
    expect(complete.coordinator.dispose()).toBe(dispose)
  })
})
