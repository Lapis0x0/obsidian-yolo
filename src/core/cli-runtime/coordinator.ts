import { App, FileSystemAdapter, Platform } from 'obsidian'

import type { YoloSettingsLike } from '../paths/yoloManagedData'

import type { ClaudeCliRuntimeOptions } from './claude'
import { createCliChatRuntimeActions } from './cli-actions'
import type { CodexCliRuntimeOptions } from './codex'
import { CodexAppServerHostPool } from './codex/host'
import { CliConversationController } from './conversation-controller'
import {
  CliModelCatalogService,
  type CliModelCatalogSnapshot,
} from './model-catalog'
import type {
  CliSessionIndexEntry,
  CliSessionIndexMutator,
  CliSessionIndexStore,
} from './session-index'
import { getCliSessionIndexKey } from './session-index'
import { CliSessionService } from './session-service'
import type {
  CliRuntime,
  CliRuntimeId,
  CliRuntimeRunState,
  CliSessionRef,
} from './types'
import { VaultCliSessionIndexStore } from './vault-session-index-store'

type ClaudeRuntimeOptions = Omit<ClaudeCliRuntimeOptions, 'vaultPath'>
type CodexRuntimeOptions = Omit<CodexCliRuntimeOptions, 'cwd' | 'resolveHost'>

export type CliRuntimeFactories = Readonly<{
  createClaudeRuntime(options: ClaudeCliRuntimeOptions): CliRuntime
  createCodexRuntime(options: CodexCliRuntimeOptions): CliRuntime
}>

export type CliRuntimeCoordinatorOptions = Readonly<{
  app: App
  getSettings?: () => YoloSettingsLike | null
  getClaudeRuntimeOptions?: () => ClaudeRuntimeOptions
  getCodexRuntimeOptions?: () => CodexRuntimeOptions
  loadRuntimeFactories?: () =>
    | CliRuntimeFactories
    | Promise<CliRuntimeFactories>
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
  createConversationRuntime(runtimeId: CliRuntimeId): CliConversationController
  selectConversationSession(ref: CliSessionRef): CliConversationController
  getSessionRunStates(): ReadonlyMap<string, CliRuntimeRunState>
  subscribeToSessionRunStates(listener: () => void): () => void
  getModelCatalogSnapshot(): CliModelCatalogSnapshot
  subscribeToModelCatalog(listener: () => void): () => void
  warmModelCatalog(runtimeId: CliRuntimeId): Promise<void>
  warmConversationRuntime(runtimeId: CliRuntimeId): Promise<void>
  dispose(): Promise<void>
}

export type CliRuntimeCoordinator = {
  createScope(): CliRuntimeScope
  dispose(): Promise<void>
}

const isAbsoluteFileSystemPath = (path: string): boolean =>
  path.startsWith('/') ||
  /^[A-Za-z]:[\\/]/u.test(path) ||
  path.startsWith('\\\\')

const defaultLoadRuntimeFactories = async (): Promise<CliRuntimeFactories> => {
  const [{ ClaudeCliRuntime }, { CodexCliRuntime }] = await Promise.all([
    import('./claude/ClaudeCliRuntime'),
    import('./codex/runtime'),
  ])
  return {
    createClaudeRuntime: (options) => new ClaudeCliRuntime(options),
    createCodexRuntime: (options) => new CodexCliRuntime(options),
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

type ConversationRuntimeRecord = Readonly<{
  runtime: CliRuntime
  controller: CliConversationController
}>

const isSameSession = (left: CliSessionRef, right: CliSessionRef): boolean =>
  left.runtimeId === right.runtimeId &&
  left.nativeSessionId === right.nativeSessionId

class DesktopCliRuntimeWorkspace {
  private readonly runtimes = new Map<CliRuntimeId, CliRuntime>()
  private readonly ownedRuntimes = new Set<CliRuntime>()
  private readonly conversations = new Set<ConversationRuntimeRecord>()
  private readonly runStateListeners = new Set<() => void>()
  private readonly modelCatalog: CliModelCatalogService
  private readonly codexHostPool: CodexAppServerHostPool
  private readonly codexRuntimeOptions: CodexRuntimeOptions
  private sessionServiceInstance: CliSessionService | null = null
  private disposePromise: Promise<void> | null = null
  private disposing = false

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
    this.codexRuntimeOptions = this.options.getCodexRuntimeOptions?.() ?? {}
    this.codexHostPool = new CodexAppServerHostPool({
      ...this.codexRuntimeOptions,
      cwd: this.adapter.getBasePath(),
    })
  }

  get sessionService(): CliSessionService {
    this.assertActive()
    this.sessionServiceInstance ??= new CliSessionService({
      app: this.options.app,
      runtimes: [
        this.resolveRuntime('claude-code'),
        this.resolveRuntime('codex'),
      ],
      indexStore: this.indexStore,
    })
    return this.sessionServiceInstance
  }

  resolveRuntime(runtimeId: CliRuntimeId): CliRuntime {
    this.assertActive()
    const existing = this.runtimes.get(runtimeId)
    if (existing) return existing

    const vaultPath = this.getVaultPath()
    const runtime =
      runtimeId === 'claude-code'
        ? this.factories.createClaudeRuntime({
            ...this.options.getClaudeRuntimeOptions?.(),
            vaultPath,
          })
        : this.factories.createCodexRuntime({
            ...this.codexRuntimeOptions,
            cwd: vaultPath,
            resolveHost: this.codexHostPool.acquire,
          })
    this.ownedRuntimes.add(runtime)
    if (runtime.runtimeId !== runtimeId) {
      throw new Error(
        `CLI runtime factory returned ${runtime.runtimeId} for ${runtimeId}.`,
      )
    }
    this.runtimes.set(runtimeId, runtime)
    return runtime
  }

  selectConversationRuntime(
    runtimeId: CliRuntimeId,
  ): CliConversationController {
    this.assertActive()
    const runtime = this.createRuntime(runtimeId)
    const controller = new CliConversationController(
      runtime,
      () => this.modelCatalog.getSnapshot().get(runtimeId) ?? [],
    )
    this.conversations.add({ runtime, controller })
    controller.subscribe(() => {
      for (const listener of this.runStateListeners) listener()
      const models = controller.getSnapshot().configuration?.models
      if (models && models.length > 0) {
        void this.modelCatalog.record(runtimeId, models)
      }
    })
    return controller
  }

  getSessionRunStates(): ReadonlyMap<string, CliRuntimeRunState> {
    const states = new Map<string, CliRuntimeRunState>()
    for (const { controller } of this.conversations) {
      const snapshot = controller.getSnapshot()
      if (snapshot.sessionRef) {
        states.set(
          getCliSessionIndexKey(snapshot.sessionRef),
          snapshot.runState,
        )
      }
    }
    return states
  }

  subscribeToSessionRunStates(listener: () => void): () => void {
    this.runStateListeners.add(listener)
    return () => this.runStateListeners.delete(listener)
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
    if (runtimeId === 'codex') {
      await this.codexHostPool.warm()
    }
  }

  selectConversationSession(ref: CliSessionRef): CliConversationController {
    this.assertActive()
    return (
      [...this.conversations].find((record) => {
        const selectedRef = record.controller.getSnapshot().sessionRef
        return selectedRef !== null && isSameSession(selectedRef, ref)
      })?.controller ?? this.selectConversationRuntime(ref.runtimeId)
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
        record.controller.dispose()
      }
      const results = await Promise.allSettled(
        [...this.ownedRuntimes].map((runtime) => runtime.dispose()),
      )
      const [hostResult] = await Promise.allSettled([
        this.codexHostPool.dispose(),
      ])
      const failure = [...results, hostResult].find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      if (failure) throw failure.reason
    } finally {
      this.conversations.clear()
    }
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

  private createRuntime(runtimeId: CliRuntimeId): CliRuntime {
    const vaultPath = this.getVaultPath()
    const runtime =
      runtimeId === 'claude-code'
        ? this.factories.createClaudeRuntime({
            ...this.options.getClaudeRuntimeOptions?.(),
            vaultPath,
          })
        : this.factories.createCodexRuntime({
            ...this.codexRuntimeOptions,
            cwd: vaultPath,
            resolveHost: this.codexHostPool.acquire,
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
  ): CliConversationController {
    this.assertActive()
    const controller = this.workspace.selectConversationRuntime(runtimeId)
    this.selectedControllers.set(runtimeId, controller)
    return controller
  }

  selectConversationSession(ref: CliSessionRef): CliConversationController {
    this.assertActive()
    const controller = this.workspace.selectConversationSession(ref)
    this.selectedControllers.set(ref.runtimeId, controller)
    return controller
  }

  getSessionRunStates(): ReadonlyMap<string, CliRuntimeRunState> {
    this.assertActive()
    return this.workspace.getSessionRunStates()
  }

  subscribeToSessionRunStates(listener: () => void): () => void {
    this.assertActive()
    return this.workspace.subscribeToSessionRunStates(listener)
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

  dispose(): Promise<void> {
    this.disposePromise ??= Promise.resolve().then(() => {
      this.disposed = true
      this.selectedControllers.clear()
      this.onDisposed(this)
    })
    return this.disposePromise
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
  const factories = await (
    options.loadRuntimeFactories ?? defaultLoadRuntimeFactories
  )()
  return new DesktopCliRuntimeCoordinator(adapter, options, factories)
}
