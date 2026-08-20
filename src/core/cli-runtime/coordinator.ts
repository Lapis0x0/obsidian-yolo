import { App, FileSystemAdapter, Platform } from 'obsidian'

import type { YoloSettingsLike } from '../paths/yoloManagedData'

import type { ClaudeRuntimeOptions } from './claude/factory'
import { createClaudeRuntimeFactory } from './claude/factory'
import { createCliChatRuntimeActions } from './cli-actions'
import type { CodexRuntimeOptions } from './codex/factory'
import { createCodexRuntimeFactory } from './codex/factory'
import { CliConversationController } from './conversation-controller'
import { createHermesRuntimeFactory } from './hermes/factory'
import { type HermesProfile, discoverHermesProfiles } from './hermes/profiles'
import { loadLoginShellEnvironment } from './login-shell-env'
import {
  CliModelCatalogService,
  type CliModelCatalogSnapshot,
} from './model-catalog'
import { createPiRuntimeFactory } from './pi/factory'
import type {
  CliSessionIndexEntry,
  CliSessionIndexMutator,
  CliSessionIndexStore,
} from './session-index'
import { CliSessionService } from './session-service'
import type {
  CliActiveRunState,
  CliRuntime,
  CliRuntimeFactories,
  CliRuntimeFactoryDeps,
  CliRuntimeId,
  CliRuntimeRunState,
  CliSessionRef,
} from './types'
import { VaultCliSessionIndexStore } from './vault-session-index-store'

export type { CliRuntimeFactories }

/** Deps available to whatever builds the default (or a caller-injected) factory table. */
export type CliRuntimeFactoriesLoaderDeps = CliRuntimeFactoryDeps &
  Readonly<{
    getClaudeRuntimeOptions?: () => ClaudeRuntimeOptions
    getCodexRuntimeOptions?: () => CodexRuntimeOptions
  }>

export type CliRuntimeCoordinatorOptions = Readonly<{
  app: App
  getSettings?: () => YoloSettingsLike | null
  getClaudeRuntimeOptions?: () => ClaudeRuntimeOptions
  getCodexRuntimeOptions?: () => CodexRuntimeOptions
  loadRuntimeFactories?: (
    deps: CliRuntimeFactoriesLoaderDeps,
  ) => CliRuntimeFactories | Promise<CliRuntimeFactories>
  createSessionIndexStore?: (
    app: App,
    getSettings: () => YoloSettingsLike | null,
  ) => CliSessionIndexStore
}>

export type CliRuntimeScope = {
  readonly sessionService: CliSessionService
  readonly chatRuntimeActions: ReturnType<typeof createCliChatRuntimeActions>

  resolveRuntime(runtimeId: CliRuntimeId): CliRuntime
  selectConversationRuntime(runtimeId: CliRuntimeId): CliConversationController
  /**
   * `profileId` picks which Hermes profile (see `CliSessionRef.profileId`)
   * a brand-new conversation launches under; ignored by runtimes without a
   * profile concept. Undefined means that runtime's own default.
   */
  createConversationRuntime(
    runtimeId: CliRuntimeId,
    profileId?: string,
  ): CliConversationController
  selectConversationSession(ref: CliSessionRef): CliConversationController
  getModelCatalogSnapshot(): CliModelCatalogSnapshot
  subscribeToModelCatalog(listener: () => void): () => void
  warmModelCatalog(runtimeId: CliRuntimeId): Promise<void>
  warmConversationRuntime(runtimeId: CliRuntimeId): Promise<void>
  /** Discovers Hermes profiles (`default` plus any under `profiles/`). Empty/single-entry for other runtimes' callers — Hermes-specific, not gated by which runtime is active. */
  listHermesProfiles(): Promise<readonly HermesProfile[]>
  dispose(): Promise<void>
}

/**
 * Process-level view of a CLI conversation that still owns a live provider
 * run. Only conversations bound to a host conversation are reported, so every
 * summary can be located from background monitoring.
 */
export type CliConversationRunSummary = Readonly<{
  conversationId: string
  runtimeId: CliRuntimeId
  runState: CliActiveRunState
}>

export type CliConversationRunSummarySubscriber = (
  summaries: Map<string, CliConversationRunSummary>,
) => void

export type CliRuntimeCoordinator = {
  createScope(): CliRuntimeScope
  /**
   * Feeds live CLI runs to process monitoring. Scoped to the coordinator
   * rather than a scope because a run outlives the view that started it.
   */
  subscribeToRunSummaries(
    callback: CliConversationRunSummarySubscriber,
  ): () => void
  dispose(): Promise<void>
}

const isAbsoluteFileSystemPath = (path: string): boolean =>
  path.startsWith('/') ||
  /^[A-Za-z]:[\\/]/u.test(path) ||
  path.startsWith('\\\\')

const defaultLoadRuntimeFactories = async (
  deps: CliRuntimeFactoriesLoaderDeps,
): Promise<CliRuntimeFactories> => {
  const [claudeFactory, codexFactory, hermesFactory, piFactory] =
    await Promise.all([
      createClaudeRuntimeFactory(deps),
      createCodexRuntimeFactory(deps),
      createHermesRuntimeFactory(deps),
      createPiRuntimeFactory(deps),
    ])
  return {
    'claude-code': claudeFactory,
    codex: codexFactory,
    hermes: hermesFactory,
    pi: piFactory,
  }
}

/**
 * Keeps the session index pointed at the current managed-data directory when
 * the user changes that setting during the plugin lifetime.
 */
class SettingsAwareSessionIndexStore implements CliSessionIndexStore {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly app: App,
    private readonly getSettings: () => YoloSettingsLike | null,
  ) {}

  list(): Promise<CliSessionIndexEntry[]> {
    return this.currentStore().list()
  }

  get(ref: CliSessionRef): Promise<CliSessionIndexEntry | null> {
    return this.currentStore().get(ref)
  }

  upsert(entry: CliSessionIndexEntry): Promise<void> {
    return this.enqueueWrite(() => this.currentStore().upsert(entry))
  }

  update(
    ref: CliSessionRef,
    mutator: CliSessionIndexMutator,
  ): Promise<CliSessionIndexEntry> {
    return this.enqueueWrite(() => this.currentStore().update(ref, mutator))
  }

  remove(ref: CliSessionRef): Promise<boolean> {
    return this.enqueueWrite(() => this.currentStore().remove(ref))
  }

  private currentStore(): VaultCliSessionIndexStore {
    return new VaultCliSessionIndexStore(this.app, this.getSettings())
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeTail.then(operation, operation)
    this.writeTail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

type ConversationRuntimeRecord = {
  runtime: CliRuntime
  controller: CliConversationController
  scopeReferences: number
  unsubscribe: () => void
  disposePromise: Promise<void> | null
}

const ACTIVE_CONVERSATION_STATES: ReadonlySet<CliRuntimeRunState> =
  new Set<CliActiveRunState>([
    'running',
    'waiting_for_approval',
    'waiting_for_user',
  ])

const isActiveRunState = (
  state: CliRuntimeRunState,
): state is CliActiveRunState => ACTIVE_CONVERSATION_STATES.has(state)

const fingerprintRunSummaries = (
  summaries: ReadonlyMap<string, CliConversationRunSummary>,
): string =>
  [...summaries.values()]
    .map((summary) => `${summary.conversationId}:${summary.runState}`)
    .sort()
    .join('|')

const isSameSession = (left: CliSessionRef, right: CliSessionRef): boolean =>
  left.runtimeId === right.runtimeId &&
  left.nativeSessionId === right.nativeSessionId

class DesktopCliRuntimeWorkspace {
  private readonly runtimes = new Map<CliRuntimeId, CliRuntime>()
  private readonly ownedRuntimes = new Set<CliRuntime>()
  private readonly conversations = new Set<ConversationRuntimeRecord>()
  private readonly conversationByController = new Map<
    CliConversationController,
    ConversationRuntimeRecord
  >()
  private readonly conversationDisposals = new Set<Promise<void>>()
  private readonly runSummarySubscribers =
    new Set<CliConversationRunSummarySubscriber>()
  private lastRunSummaryFingerprint = ''
  private readonly modelCatalog: CliModelCatalogService
  private sessionServiceInstance: CliSessionService | null = null
  private disposePromise: Promise<void> | null = null
  private disposing = false
  /**
   * Memoizes `loadLoginShellEnvironment()` for Hermes profile discovery only
   * — that call synchronously spawns a login shell (`zsh -ilc`), so without
   * this every profile-selector mount and popover open would block Obsidian's
   * render thread again. Scoped to this workspace instance (one per
   * coordinator) rather than made a module-level/global cache: it must never
   * touch `hermes/factory.ts`'s own `loadLoginShellEnvironment()` call, which
   * intentionally re-runs on every host respawn so an install or path
   * override picked up after startup still takes effect without restarting
   * Obsidian. `discoverHermesProfiles()` itself is still invoked fresh on
   * every call below, so newly created/deleted profile directories are
   * always reflected immediately.
   */
  private hermesLoginShellEnvironmentPromise: Promise<NodeJS.ProcessEnv> | null =
    null

  readonly chatRuntimeActions = createCliChatRuntimeActions((ref) =>
    this.resolveConversationRuntime(ref),
  )

  constructor(
    private readonly adapter: FileSystemAdapter,
    private readonly options: CliRuntimeCoordinatorOptions,
    private readonly factories: CliRuntimeFactories,
    private readonly indexStore: CliSessionIndexStore,
  ) {
    this.modelCatalog = CliModelCatalogService.create(
      options.app,
      options.getSettings ?? (() => null),
    )
  }

  get sessionService(): CliSessionService {
    this.assertActive()
    this.sessionServiceInstance ??= new CliSessionService({
      app: this.options.app,
      indexStore: this.indexStore,
    })
    return this.sessionServiceInstance
  }

  resolveRuntime(runtimeId: CliRuntimeId): CliRuntime {
    this.assertActive()
    const existing = this.runtimes.get(runtimeId)
    if (existing) return existing

    const runtime = this.instantiateRuntime(runtimeId)
    this.runtimes.set(runtimeId, runtime)
    return runtime
  }

  selectConversationRuntime(
    runtimeId: CliRuntimeId,
    profileId?: string,
  ): CliConversationController {
    this.assertActive()
    const runtime = this.instantiateRuntime(runtimeId, profileId)
    const controller = new CliConversationController(
      runtime,
      () => this.modelCatalog.getSnapshot().get(runtimeId) ?? [],
      (ref, sourceUserMessageId, summary) =>
        this.sessionService.recordTurnEditSummary(
          ref,
          sourceUserMessageId,
          summary,
        ),
      (ref, usage) => this.sessionService.rememberContextUsage(ref, usage),
    )
    const record: ConversationRuntimeRecord = {
      runtime,
      controller,
      scopeReferences: 0,
      unsubscribe: () => undefined,
      disposePromise: null,
    }
    this.conversations.add(record)
    this.conversationByController.set(controller, record)
    record.unsubscribe = controller.subscribe(() => {
      const models = controller.getSnapshot().configuration?.models
      if (models && models.length > 0) {
        void this.modelCatalog.record(runtimeId, models)
      }
      this.emitRunSummaries()
      if (record.scopeReferences === 0) {
        void this.disposeConversationIfInactive(record).catch((error) => {
          console.error('[YOLO] Failed to release inactive CLI runtime', error)
        })
      }
    })
    return controller
  }

  getActiveRunSummaries(): Map<string, CliConversationRunSummary> {
    const summaries = new Map<string, CliConversationRunSummary>()
    for (const record of this.conversations) {
      if (record.disposePromise) continue
      const conversationId = record.controller.getConversationId()
      if (!conversationId) continue
      const { runState, runtimeId } = record.controller.getSnapshot()
      if (!isActiveRunState(runState)) continue
      summaries.set(conversationId, { conversationId, runtimeId, runState })
    }
    return summaries
  }

  subscribeToRunSummaries(
    callback: CliConversationRunSummarySubscriber,
  ): () => void {
    this.runSummarySubscribers.add(callback)
    const summaries = this.getActiveRunSummaries()
    // The subscriber now knows this state, so later diffs must compare
    // against it rather than against whatever was last broadcast.
    this.lastRunSummaryFingerprint = fingerprintRunSummaries(summaries)
    callback(summaries)
    return () => {
      this.runSummarySubscribers.delete(callback)
    }
  }

  /**
   * Controllers publish on every streamed chunk, so only a change in the set of
   * live runs is forwarded to monitoring.
   */
  private emitRunSummaries(): void {
    if (this.runSummarySubscribers.size === 0) return
    const summaries = this.getActiveRunSummaries()
    const fingerprint = fingerprintRunSummaries(summaries)
    if (fingerprint === this.lastRunSummaryFingerprint) return
    this.lastRunSummaryFingerprint = fingerprint
    for (const subscriber of this.runSummarySubscribers) {
      try {
        subscriber(new Map(summaries))
      } catch (error) {
        console.error('[YOLO] CLI run summary subscriber failed', error)
      }
    }
  }

  retainConversation(controller: CliConversationController): void {
    this.assertActive()
    const record = this.conversationByController.get(controller)
    if (!record || record.disposePromise) {
      throw new Error('CLI conversation controller is no longer available.')
    }
    record.scopeReferences += 1
  }

  releaseConversation(controller: CliConversationController): Promise<void> {
    const record = this.conversationByController.get(controller)
    if (!record) return Promise.resolve()
    if (record.scopeReferences === 0) {
      throw new Error('CLI conversation controller was released twice.')
    }
    record.scopeReferences -= 1
    return this.disposeConversationIfInactive(record)
  }

  getModelCatalogSnapshot(): CliModelCatalogSnapshot {
    return this.modelCatalog.getSnapshot()
  }

  subscribeToModelCatalog(listener: () => void): () => void {
    return this.modelCatalog.subscribe(listener)
  }

  async warmModelCatalog(runtimeId: CliRuntimeId): Promise<void> {
    await this.modelCatalog.load()
    const runtime = this.resolveRuntime(runtimeId)
    if (!runtime.listModels) return
    await this.modelCatalog.refresh(runtimeId, () => runtime.listModels!())
  }

  async warmConversationRuntime(runtimeId: CliRuntimeId): Promise<void> {
    await this.factories[runtimeId].warm?.()
  }

  async listHermesProfiles(): Promise<readonly HermesProfile[]> {
    this.assertActive()
    // Must read the same environment snapshot command resolution and process
    // launch use (`hermes/factory.ts`'s `resolveProcessOptionsForProfile`) —
    // `process.env` alone omits shell-rc exports (e.g. a custom
    // `HERMES_HOME`) that macOS GUI apps don't inherit, which would otherwise
    // make this list a different set of profiles than what actually launches.
    // The environment resolution itself is memoized (see the field's doc
    // comment); the directory scan below is not, so newly added/removed
    // profiles are always picked up.
    this.hermesLoginShellEnvironmentPromise ??=
      loadLoginShellEnvironment() as Promise<NodeJS.ProcessEnv>
    const env = await this.hermesLoginShellEnvironmentPromise
    return discoverHermesProfiles(env)
  }

  selectConversationSession(ref: CliSessionRef): CliConversationController {
    this.assertActive()
    return (
      [...this.conversations].find((record) => {
        const selectedRef = record.controller.getSnapshot().sessionRef
        return selectedRef !== null && isSameSession(selectedRef, ref)
      })?.controller ??
      this.selectConversationRuntime(ref.runtimeId, ref.profileId)
    )
  }

  private resolveConversationRuntime(
    ref: CliSessionRef,
  ): CliRuntime | undefined {
    return [...this.conversations].find((record) => {
      const selectedRef = record.controller.getSnapshot().sessionRef
      return selectedRef !== null && isSameSession(selectedRef, ref)
    })?.runtime
  }

  dispose(): Promise<void> {
    this.disposing = true
    this.disposePromise ??= this.disposeOwnedResources()
    return this.disposePromise
  }

  private async disposeOwnedResources(): Promise<void> {
    try {
      for (const record of this.conversations) {
        void this.disposeConversationRecord(record)
      }
      const results = await Promise.allSettled([
        ...this.conversationDisposals,
        ...[...this.ownedRuntimes].map((runtime) => runtime.dispose()),
      ])
      const factoryDisposeResults = await Promise.allSettled(
        Object.values(this.factories).map(
          (factory) => factory.dispose?.() ?? Promise.resolve(),
        ),
      )
      const failure = [...results, ...factoryDisposeResults].find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      if (failure) throw failure.reason
    } finally {
      this.conversations.clear()
      this.conversationByController.clear()
    }
  }

  private disposeConversationIfInactive(
    record: ConversationRuntimeRecord,
  ): Promise<void> {
    const snapshot = record.controller.getSnapshot()
    if (
      record.scopeReferences > 0 ||
      snapshot.isCompacting === true ||
      ACTIVE_CONVERSATION_STATES.has(snapshot.runState)
    ) {
      return Promise.resolve()
    }
    return this.disposeConversationRecord(record)
  }

  private disposeConversationRecord(
    record: ConversationRuntimeRecord,
  ): Promise<void> {
    if (record.disposePromise) return record.disposePromise
    this.conversations.delete(record)
    this.conversationByController.delete(record.controller)
    this.ownedRuntimes.delete(record.runtime)
    record.unsubscribe()
    record.controller.dispose()
    const disposePromise = record.runtime.dispose()
    record.disposePromise = disposePromise
    this.conversationDisposals.add(disposePromise)
    void disposePromise.then(
      () => this.conversationDisposals.delete(disposePromise),
      () => this.conversationDisposals.delete(disposePromise),
    )
    this.emitRunSummaries()
    return disposePromise
  }

  private getVaultPath(): string {
    const path = this.adapter.getBasePath()
    if (!isAbsoluteFileSystemPath(path)) {
      throw new Error('CLI runtime requires an absolute vault path.')
    }
    return path
  }

  private assertActive(): void {
    if (this.disposing) throw new Error('CLI runtime scope is disposed.')
  }

  private instantiateRuntime(
    runtimeId: CliRuntimeId,
    profileId?: string,
  ): CliRuntime {
    const runtime = this.factories[runtimeId].create({
      app: this.options.app,
      vaultPath: this.getVaultPath(),
      ...(profileId ? { profileId } : {}),
    })
    this.ownedRuntimes.add(runtime)
    if (runtime.runtimeId !== runtimeId) {
      throw new Error(
        `CLI runtime factory returned ${runtime.runtimeId} for ${runtimeId}.`,
      )
    }
    return runtime
  }
}

class DesktopCliRuntimeScope implements CliRuntimeScope {
  private readonly selectedControllers = new Map<
    CliRuntimeId,
    CliConversationController
  >()
  private disposed = false
  private disposePromise: Promise<void> | null = null

  constructor(
    private readonly workspace: DesktopCliRuntimeWorkspace,
    private readonly onDisposed: (scope: DesktopCliRuntimeScope) => void,
  ) {}

  get sessionService(): CliSessionService {
    this.assertActive()
    return this.workspace.sessionService
  }

  get chatRuntimeActions(): ReturnType<typeof createCliChatRuntimeActions> {
    this.assertActive()
    return this.workspace.chatRuntimeActions
  }

  resolveRuntime(runtimeId: CliRuntimeId): CliRuntime {
    this.assertActive()
    return this.workspace.resolveRuntime(runtimeId)
  }

  selectConversationRuntime(
    runtimeId: CliRuntimeId,
  ): CliConversationController {
    this.assertActive()
    return (
      this.selectedControllers.get(runtimeId) ??
      this.createConversationRuntime(runtimeId)
    )
  }

  createConversationRuntime(
    runtimeId: CliRuntimeId,
    profileId?: string,
  ): CliConversationController {
    this.assertActive()
    const controller = this.workspace.selectConversationRuntime(
      runtimeId,
      profileId,
    )
    this.selectController(runtimeId, controller)
    return controller
  }

  selectConversationSession(ref: CliSessionRef): CliConversationController {
    this.assertActive()
    const controller = this.workspace.selectConversationSession(ref)
    this.selectController(ref.runtimeId, controller)
    return controller
  }

  getModelCatalogSnapshot(): CliModelCatalogSnapshot {
    this.assertActive()
    return this.workspace.getModelCatalogSnapshot()
  }

  subscribeToModelCatalog(listener: () => void): () => void {
    this.assertActive()
    return this.workspace.subscribeToModelCatalog(listener)
  }

  warmModelCatalog(runtimeId: CliRuntimeId): Promise<void> {
    this.assertActive()
    return this.workspace.warmModelCatalog(runtimeId)
  }

  warmConversationRuntime(runtimeId: CliRuntimeId): Promise<void> {
    this.assertActive()
    return this.workspace.warmConversationRuntime(runtimeId)
  }

  listHermesProfiles(): Promise<readonly HermesProfile[]> {
    this.assertActive()
    return this.workspace.listHermesProfiles()
  }

  dispose(): Promise<void> {
    this.disposePromise ??= Promise.resolve().then(async () => {
      this.disposed = true
      const controllers = [...this.selectedControllers.values()]
      this.selectedControllers.clear()
      this.onDisposed(this)
      const results = await Promise.allSettled(
        controllers.map((controller) =>
          this.workspace.releaseConversation(controller),
        ),
      )
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      if (failure) throw failure.reason
    })
    return this.disposePromise
  }

  private selectController(
    runtimeId: CliRuntimeId,
    controller: CliConversationController,
  ): void {
    const previous = this.selectedControllers.get(runtimeId)
    if (previous === controller) return
    this.workspace.retainConversation(controller)
    this.selectedControllers.set(runtimeId, controller)
    if (previous) {
      void this.workspace.releaseConversation(previous).catch((error) => {
        console.error('[YOLO] Failed to release replaced CLI runtime', error)
      })
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('CLI runtime scope is disposed.')
  }
}

class DesktopCliRuntimeCoordinator implements CliRuntimeCoordinator {
  private readonly scopes = new Set<DesktopCliRuntimeScope>()
  private readonly indexStore: CliSessionIndexStore
  private readonly workspace: DesktopCliRuntimeWorkspace
  private disposePromise: Promise<void> | null = null
  private disposing = false

  constructor(
    private readonly adapter: FileSystemAdapter,
    private readonly options: CliRuntimeCoordinatorOptions,
    private readonly factories: CliRuntimeFactories,
  ) {
    const getSettings = options.getSettings ?? (() => null)
    this.indexStore = options.createSessionIndexStore
      ? options.createSessionIndexStore(options.app, getSettings)
      : new SettingsAwareSessionIndexStore(options.app, getSettings)
    this.workspace = new DesktopCliRuntimeWorkspace(
      adapter,
      options,
      factories,
      this.indexStore,
    )
  }

  createScope(): CliRuntimeScope {
    if (this.disposing) throw new Error('CLI runtime coordinator is disposed.')
    const scope = new DesktopCliRuntimeScope(this.workspace, (disposedScope) =>
      this.scopes.delete(disposedScope),
    )
    this.scopes.add(scope)
    return scope
  }

  subscribeToRunSummaries(
    callback: CliConversationRunSummarySubscriber,
  ): () => void {
    return this.workspace.subscribeToRunSummaries(callback)
  }

  dispose(): Promise<void> {
    this.disposing = true
    this.disposePromise ??= this.disposeScopes()
    return this.disposePromise
  }

  private async disposeScopes(): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.scopes].map((scope) => scope.dispose()),
      this.workspace.dispose(),
    ])
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failure) throw failure.reason
  }
}

/**
 * Enters the desktop boundary before loading provider implementations or
 * invoking any injected runtime factory.
 */
export const createDesktopCliRuntimeCoordinator = async (
  options: CliRuntimeCoordinatorOptions,
): Promise<CliRuntimeCoordinator> => {
  if (!Platform.isDesktop) {
    throw new Error('CLI runtimes are only available on desktop.')
  }
  const adapter = options.app.vault.adapter
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error('CLI runtimes require a file-system-backed vault.')
  }
  const vaultPath = adapter.getBasePath()
  const factories = await (
    options.loadRuntimeFactories ?? defaultLoadRuntimeFactories
  )({
    app: options.app,
    vaultPath,
    getClaudeRuntimeOptions: options.getClaudeRuntimeOptions,
    getCodexRuntimeOptions: options.getCodexRuntimeOptions,
  })
  return new DesktopCliRuntimeCoordinator(adapter, options, factories)
}
