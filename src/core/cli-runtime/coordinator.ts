import { App, FileSystemAdapter, Platform } from 'obsidian'

import type { YoloSettingsLike } from '../paths/yoloManagedData'

import type {
  ClaudeCliRuntimeOptions,
  ClaudePluginPathProvider,
} from './claude'
import { createCliChatRuntimeActions } from './cli-actions'
import type { CodexCliRuntimeOptions } from './codex'
import { CliConversationController } from './conversation-controller'
import type {
  CliSessionIndexEntry,
  CliSessionIndexStore,
} from './session-index'
import { CliSessionService } from './session-service'
import type { CliRuntime, CliRuntimeId, CliSessionRef } from './types'
import { VaultCliSessionIndexStore } from './vault-session-index-store'

type ClaudeRuntimeOptions = Omit<
  ClaudeCliRuntimeOptions,
  'vaultPath' | 'resolvePluginPaths'
>
type CodexRuntimeOptions = Omit<CodexCliRuntimeOptions, 'cwd'>

export type CliRuntimeFactories = Readonly<{
  createClaudeRuntime(options: ClaudeCliRuntimeOptions): CliRuntime
  createCodexRuntime(options: CodexCliRuntimeOptions): CliRuntime
}>

export type CliRuntimeCoordinatorOptions = Readonly<{
  app: App
  getSettings?: () => YoloSettingsLike | null
  getClaudeRuntimeOptions?: () => ClaudeRuntimeOptions
  getCodexRuntimeOptions?: () => CodexRuntimeOptions
  resolveClaudePluginPaths?: ClaudePluginPathProvider
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
  readonly conversationController: CliConversationController
  readonly chatRuntimeActions: ReturnType<typeof createCliChatRuntimeActions>

  resolveRuntime(runtimeId: CliRuntimeId): CliRuntime
  selectConversationRuntime(runtimeId: CliRuntimeId): CliConversationController
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

class DesktopCliRuntimeScope implements CliRuntimeScope {
  private readonly runtimes = new Map<CliRuntimeId, CliRuntime>()
  private readonly ownedRuntimes = new Set<CliRuntime>()
  private sessionServiceInstance: CliSessionService | null = null
  private conversationControllerInstance: CliConversationController | null =
    null
  private disposePromise: Promise<void> | null = null
  private disposing = false

  readonly chatRuntimeActions = createCliChatRuntimeActions((runtimeId) =>
    this.resolveRuntime(runtimeId),
  )

  constructor(
    private readonly adapter: FileSystemAdapter,
    private readonly options: CliRuntimeCoordinatorOptions,
    private readonly factories: CliRuntimeFactories,
    private readonly indexStore: CliSessionIndexStore,
    private readonly onDisposed: (scope: DesktopCliRuntimeScope) => void,
  ) {}

  get sessionService(): CliSessionService {
    this.assertActive()
    this.sessionServiceInstance ??= new CliSessionService({
      runtimes: [
        this.resolveRuntime('claude-code'),
        this.resolveRuntime('codex'),
      ],
      indexStore: this.indexStore,
    })
    return this.sessionServiceInstance
  }

  get conversationController(): CliConversationController {
    return (
      this.conversationControllerInstance ??
      this.selectConversationRuntime('claude-code')
    )
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
            ...(this.options.resolveClaudePluginPaths
              ? {
                  resolvePluginPaths: this.options.resolveClaudePluginPaths,
                }
              : {}),
          })
        : this.factories.createCodexRuntime({
            ...this.options.getCodexRuntimeOptions?.(),
            cwd: vaultPath,
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
    const runtime = this.resolveRuntime(runtimeId)
    if (!this.conversationControllerInstance) {
      this.conversationControllerInstance = new CliConversationController(
        runtime,
      )
    } else {
      this.conversationControllerInstance.setRuntime(runtime)
    }
    return this.conversationControllerInstance
  }

  dispose(): Promise<void> {
    this.disposing = true
    this.disposePromise ??= this.disposeOwnedResources()
    return this.disposePromise
  }

  private async disposeOwnedResources(): Promise<void> {
    try {
      this.conversationControllerInstance?.dispose()
      const results = await Promise.allSettled(
        [...this.ownedRuntimes].map((runtime) => runtime.dispose()),
      )
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      if (failure) throw failure.reason
    } finally {
      this.onDisposed(this)
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
}

class DesktopCliRuntimeCoordinator implements CliRuntimeCoordinator {
  private readonly scopes = new Set<DesktopCliRuntimeScope>()
  private readonly indexStore: CliSessionIndexStore
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
  }

  createScope(): CliRuntimeScope {
    if (this.disposing) throw new Error('CLI runtime coordinator is disposed.')
    const scope = new DesktopCliRuntimeScope(
      this.adapter,
      this.options,
      this.factories,
      this.indexStore,
      (disposedScope) => this.scopes.delete(disposedScope),
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
    const results = await Promise.allSettled(
      [...this.scopes].map((scope) => scope.dispose()),
    )
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
