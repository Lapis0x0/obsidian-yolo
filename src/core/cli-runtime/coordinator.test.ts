import { FileSystemAdapter, Platform } from 'obsidian'

import type { CliRuntimeFactories } from './coordinator'
import { createDesktopCliRuntimeCoordinator } from './coordinator'
import { discoverHermesProfiles } from './hermes/profiles'
import { loadLoginShellEnvironment } from './login-shell-env'
import type { CliSessionIndexStore } from './session-index'
import type {
  CliRuntime,
  CliRuntimeEvent,
  CliRuntimeEventListener,
  CliRuntimeId,
} from './types'

jest.mock('./hermes/profiles', () => ({
  HERMES_DEFAULT_PROFILE_ID: 'default',
  discoverHermesProfiles: jest.fn(async () => [
    { id: 'default', displayName: 'default' },
  ]),
}))
jest.mock('./login-shell-env', () => ({
  loadLoginShellEnvironment: jest.fn(async () => ({
    PATH: '/login-shell/bin',
    HERMES_HOME: '/login-shell/.hermes',
  })),
}))

const mockedDiscoverHermesProfiles = jest.mocked(discoverHermesProfiles)
const mockedLoadLoginShellEnvironment = jest.mocked(loadLoginShellEnvironment)

class TestFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }

  getBasePath(): string {
    return this.basePath
  }
}

const createApp = (adapter: object) =>
  ({
    vault: { adapter },
    loadLocalStorage: () => null,
    saveLocalStorage: () => undefined,
  }) as unknown as Parameters<
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

  constructor(readonly runtimeId: CliRuntimeId) {}

  async openSession(ref: Parameters<CliRuntime['openSession']>[0]) {
    return { ref, messages: [], compactionBoundaries: [] }
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
  const hermesRuntimes: TestRuntime[] = []
  const piRuntimes: TestRuntime[] = []
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
  const createHermesRuntime = jest.fn(() => {
    const runtime = new TestRuntime('hermes')
    hermesRuntimes.push(runtime)
    return runtime
  })
  const createPiRuntime = jest.fn(() => {
    const runtime = new TestRuntime('pi')
    piRuntimes.push(runtime)
    return runtime
  })
  const factories: CliRuntimeFactories = {
    'claude-code': { create: createClaudeRuntime },
    codex: { create: createCodexRuntime },
    hermes: { create: createHermesRuntime },
    pi: { create: createPiRuntime },
  }
  return {
    claudeRuntimes,
    codexRuntimes,
    hermesRuntimes,
    piRuntimes,
    createClaudeRuntime,
    createCodexRuntime,
    createHermesRuntime,
    createPiRuntime,
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
    mockedDiscoverHermesProfiles.mockClear()
    mockedLoadLoginShellEnvironment.mockClear()
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

  it('passes the vault path and configured option getters to the runtime factories loader', async () => {
    const harness = runtimeHarness()
    const app = createApp(new TestFileSystemAdapter('/vault/loader'))
    const getClaudeRuntimeOptions = () => ({})
    const getCodexRuntimeOptions = () => ({})
    const loadRuntimeFactories = jest.fn(() => harness.factories)

    await createDesktopCliRuntimeCoordinator({
      app,
      getClaudeRuntimeOptions,
      getCodexRuntimeOptions,
      loadRuntimeFactories,
      createSessionIndexStore: indexStore,
    })

    expect(loadRuntimeFactories).toHaveBeenCalledWith({
      app,
      vaultPath: '/vault/loader',
      getClaudeRuntimeOptions,
      getCodexRuntimeOptions,
    })
  })

  it('creates each provider lazily once per scope with the current absolute vault path', async () => {
    const harness = runtimeHarness()
    const app = createApp(new TestFileSystemAdapter('/vault/current'))
    const coordinator = await createDesktopCliRuntimeCoordinator({
      app,
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
      app,
      vaultPath: '/vault/current',
    })
    expect(scope.resolveRuntime('codex')).toBe(scope.resolveRuntime('codex'))
    expect(harness.createCodexRuntime).toHaveBeenCalledTimes(1)
    expect(harness.createCodexRuntime).toHaveBeenCalledWith({
      app,
      vaultPath: '/vault/current',
    })
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

  it('delegates warmConversationRuntime to the factory warm hook when present', async () => {
    const warm = jest.fn(async () => undefined)
    const harness = runtimeHarness()
    const factories: CliRuntimeFactories = {
      ...harness.factories,
      codex: { ...harness.factories.codex, warm },
    }
    const { coordinator } = await createCoordinator({ ...harness, factories })
    const scope = coordinator.createScope()

    await scope.warmConversationRuntime('codex')
    expect(warm).toHaveBeenCalledTimes(1)

    // claude-code declares no warm hook — this must resolve as a no-op.
    await expect(
      scope.warmConversationRuntime('claude-code'),
    ).resolves.toBeUndefined()
  })

  it('disposes factory-owned infrastructure when the coordinator disposes', async () => {
    const dispose = jest.fn(async () => undefined)
    const harness = runtimeHarness()
    const factories: CliRuntimeFactories = {
      ...harness.factories,
      codex: { ...harness.factories.codex, dispose },
    }
    const { coordinator } = await createCoordinator({ ...harness, factories })

    await coordinator.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
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

  it('releases inactive conversation runtimes when their view scope closes', async () => {
    const { coordinator, harness } = await createCoordinator()
    const scope = coordinator.createScope()
    const claudeController = scope.selectConversationRuntime('claude-code')
    const codexController = scope.selectConversationRuntime('codex')
    const disposeClaudeController = jest.spyOn(claudeController, 'dispose')
    const disposeCodexController = jest.spyOn(codexController, 'dispose')

    await scope.dispose()
    expect(disposeClaudeController).toHaveBeenCalledTimes(1)
    expect(disposeCodexController).toHaveBeenCalledTimes(1)
    expect(harness.claudeRuntimes[0].dispose).toHaveBeenCalledTimes(1)
    expect(harness.codexRuntimes[0].dispose).toHaveBeenCalledTimes(1)
    await coordinator.dispose()
    expect(disposeClaudeController).toHaveBeenCalledTimes(1)
    expect(disposeCodexController).toHaveBeenCalledTimes(1)
    expect(harness.claudeRuntimes[0].dispose).toHaveBeenCalledTimes(1)
    expect(harness.codexRuntimes[0].dispose).toHaveBeenCalledTimes(1)
    expect(disposeClaudeController.mock.invocationCallOrder[0]).toBeLessThan(
      harness.claudeRuntimes[0].dispose.mock.invocationCallOrder[0],
    )
  })

  it('keeps an unobserved active conversation alive until it reaches a terminal state', async () => {
    const { coordinator, harness } = await createCoordinator()
    const scope = coordinator.createScope()
    const controller = scope.selectConversationRuntime('claude-code')
    const runtime = harness.claudeRuntimes[0]

    await controller.ensureReady()
    runtime.emit({ type: 'run_state', state: 'running' })
    await scope.dispose()
    expect(runtime.dispose).not.toHaveBeenCalled()

    runtime.emit({ type: 'run_state', state: 'completed' })
    await Promise.resolve()
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().runState).toBe('completed')

    await coordinator.dispose()
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports live runs to monitoring until they leave an active state', async () => {
    const { coordinator, harness } = await createCoordinator()
    const scope = coordinator.createScope()
    const controller = scope.selectConversationRuntime('claude-code')
    const runtime = harness.claudeRuntimes[0]
    controller.bindConversation('conversation-a')
    const summaries: Map<string, unknown>[] = []
    const unsubscribe = coordinator.subscribeToRunSummaries((next) => {
      summaries.push(next)
    })

    expect(summaries).toHaveLength(1)
    expect([...summaries[0].keys()]).toEqual([])

    await controller.ensureReady()
    runtime.emit({ type: 'run_state', state: 'running' })
    expect(summaries[summaries.length - 1].get('conversation-a')).toEqual({
      conversationId: 'conversation-a',
      runtimeId: 'claude-code',
      runState: 'running',
    })

    runtime.emit({ type: 'run_state', state: 'waiting_for_approval' })
    expect(summaries[summaries.length - 1].get('conversation-a')).toEqual({
      conversationId: 'conversation-a',
      runtimeId: 'claude-code',
      runState: 'waiting_for_approval',
    })

    // The view can close while the run continues; monitoring must not drop it.
    await scope.dispose()
    expect(summaries[summaries.length - 1].has('conversation-a')).toBe(true)

    runtime.emit({ type: 'run_state', state: 'completed' })
    expect(summaries[summaries.length - 1].has('conversation-a')).toBe(false)

    const settled = summaries.length
    runtime.emit({ type: 'run_state', state: 'completed' })
    expect(summaries).toHaveLength(settled)

    unsubscribe()
    await coordinator.dispose()
  })

  it('diffs against what a late subscriber was given, not the last broadcast', async () => {
    const { coordinator, harness } = await createCoordinator()
    const scope = coordinator.createScope()
    const controller = scope.selectConversationRuntime('claude-code')
    const runtime = harness.claudeRuntimes[0]
    controller.bindConversation('conversation-c')

    await controller.ensureReady()
    runtime.emit({ type: 'run_state', state: 'running' })
    runtime.emit({ type: 'run_state', state: 'completed' })

    const summaries: Map<string, unknown>[] = []
    coordinator.subscribeToRunSummaries((next) => {
      summaries.push(next)
    })
    expect(summaries[0].size).toBe(0)

    runtime.emit({ type: 'run_state', state: 'running' })
    expect(summaries).toHaveLength(2)
    expect([...summaries[1].keys()]).toEqual(['conversation-c'])

    await scope.dispose()
    await coordinator.dispose()
  })

  it('omits a conversation that no view has bound yet', async () => {
    const { coordinator, harness } = await createCoordinator()
    const scope = coordinator.createScope()
    const controller = scope.selectConversationRuntime('claude-code')
    const summaries: Map<string, unknown>[] = []
    coordinator.subscribeToRunSummaries((next) => {
      summaries.push(next)
    })

    await controller.ensureReady()
    harness.claudeRuntimes[0].emit({ type: 'run_state', state: 'running' })
    expect(summaries[summaries.length - 1].size).toBe(0)

    controller.bindConversation('conversation-b')
    expect([...summaries[summaries.length - 1].keys()]).toEqual([
      'conversation-b',
    ])

    await scope.dispose()
    await coordinator.dispose()
  })

  it('releases a shared session after the final view scope closes', async () => {
    const { coordinator, harness } = await createCoordinator()
    const first = coordinator.createScope()
    const second = coordinator.createScope()
    const controller = first.selectConversationRuntime('claude-code')
    await controller.ensureReady()
    const shared = second.selectConversationSession({
      runtimeId: 'claude-code',
      nativeSessionId: 'claude-code-session',
    })

    expect(shared).toBe(controller)
    await first.dispose()
    expect(harness.claudeRuntimes[0].dispose).not.toHaveBeenCalled()
    await second.dispose()
    expect(harness.claudeRuntimes[0].dispose).toHaveBeenCalledTimes(1)

    await coordinator.dispose()
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

  it('listHermesProfiles() discovers profiles through the login-shell environment, not bare process.env', async () => {
    // macOS GUI apps (Obsidian included) don't inherit shell-rc exports like
    // a custom `HERMES_HOME` — command resolution and process launch already
    // go through `loadLoginShellEnvironment()` (see `hermes/factory.ts`).
    // Profile discovery used to read `process.env` directly instead, so a
    // user with `HERMES_HOME` set only in their shell rc would see the
    // wrong (or missing) profiles in the picker even though the actual
    // Hermes process launches against the right root.
    const originalHermesHome = process.env.HERMES_HOME
    process.env.HERMES_HOME = '/process-env/.hermes'
    try {
      const { coordinator } = await createCoordinator()
      const scope = coordinator.createScope()

      const profiles = await scope.listHermesProfiles()

      expect(mockedLoadLoginShellEnvironment).toHaveBeenCalledTimes(1)
      expect(mockedDiscoverHermesProfiles).toHaveBeenCalledWith(
        expect.objectContaining({ HERMES_HOME: '/login-shell/.hermes' }),
      )
      // Never the raw process.env value, proving the login-shell snapshot
      // (not process.env) is what actually gets used.
      expect(mockedDiscoverHermesProfiles).not.toHaveBeenCalledWith(
        expect.objectContaining({ HERMES_HOME: '/process-env/.hermes' }),
      )
      expect(profiles).toEqual([{ id: 'default', displayName: 'default' }])

      await scope.dispose()
      await coordinator.dispose()
    } finally {
      if (originalHermesHome === undefined) {
        delete process.env.HERMES_HOME
      } else {
        process.env.HERMES_HOME = originalHermesHome
      }
    }
  })

  it('listHermesProfiles() memoizes the login-shell environment resolution but always rescans the profile directory', async () => {
    // `loadLoginShellEnvironment()` synchronously spawns `zsh -ilc`, which
    // blocks Obsidian's render thread — `HermesProfileSelector` calls this
    // on every mount and every popover open, so resolving it fresh each time
    // caused a visible stall. The fix must still rescan the profile
    // directory (`discoverHermesProfiles`) on every call so a profile
    // created/deleted after the first call shows up immediately — only the
    // environment resolution itself is cached.
    const { coordinator } = await createCoordinator()
    const scope = coordinator.createScope()

    mockedDiscoverHermesProfiles.mockResolvedValueOnce([
      { id: 'default', displayName: 'default' },
    ])
    const first = await scope.listHermesProfiles()
    expect(first).toEqual([{ id: 'default', displayName: 'default' }])

    mockedDiscoverHermesProfiles.mockResolvedValueOnce([
      { id: 'default', displayName: 'default' },
      { id: 'work', displayName: 'Work' },
    ])
    const second = await scope.listHermesProfiles()
    expect(second).toEqual([
      { id: 'default', displayName: 'default' },
      { id: 'work', displayName: 'Work' },
    ])

    // The memoization must live on the coordinator's shared workspace, not
    // on one scope — a second scope (a second Chat view, for instance) must
    // still reuse the cached environment instead of resolving its own.
    const otherScope = coordinator.createScope()
    await otherScope.listHermesProfiles()

    expect(mockedDiscoverHermesProfiles).toHaveBeenCalledTimes(3)
    expect(mockedLoadLoginShellEnvironment).toHaveBeenCalledTimes(1)

    await otherScope.dispose()
    await scope.dispose()
    await coordinator.dispose()
  })
})
