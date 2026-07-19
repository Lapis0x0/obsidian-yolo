import {
  ItemView,
  type Plugin,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian'
import React from 'react'
import { type Root, createRoot } from 'react-dom/client'

import type { StagedModuleContributions } from './contributionStager'
import { ModuleContributionStager } from './contributionStager'
import type { ModuleHostCapabilityProviderV1 } from './hostCapabilities'
import { ModuleLifecycleScope } from './lifecycleScope'
import { installYoloModuleRuntimeBridge } from './runtimeBridge'
import type {
  YoloModuleDefinition,
  YoloModuleOpenViewOptionsV1,
  YoloModuleViewV1,
  YoloModuleWorkspaceV1,
} from './types'

type ModuleViewSlotListener = (
  declaration: YoloModuleViewV1 | null,
  previous: YoloModuleViewV1 | null,
) => void

class ModuleViewSlot {
  private declaration: YoloModuleViewV1 | null = null
  private readonly listeners = new Set<ModuleViewSlotListener>()

  constructor(
    readonly moduleId: string,
    readonly type: string,
    readonly name: string,
    readonly icon: string,
  ) {}

  get(): YoloModuleViewV1 | null {
    return this.declaration
  }

  bind(declaration: YoloModuleViewV1): void {
    if (this.declaration) {
      throw new Error(`Module view type "${this.type}" is already active`)
    }
    if (declaration.type !== this.type) {
      throw new Error(
        `Module "${this.moduleId}" changed view type from "${this.type}" to "${declaration.type}"`,
      )
    }
    const previous = this.declaration
    this.declaration = declaration
    for (const listener of this.listeners) listener(declaration, previous)
  }

  unbind(expected?: YoloModuleViewV1): void {
    if (!this.declaration || (expected && this.declaration !== expected)) return
    const previous = this.declaration
    this.declaration = null
    for (const listener of this.listeners) listener(null, previous)
  }

  subscribe(listener: ModuleViewSlotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

abstract class ModuleItemView extends ItemView {
  private root: Root | null = null
  private mountedHost: HTMLElement | null = null
  private mountedDocument: Document | null = null
  private observer: MutationObserver | null = null
  private windowMigratedDisposer: (() => void) | null = null
  private rebuildRaf: number | null = null
  private declaration: YoloModuleViewV1 | null = null
  private lastState: Record<string, unknown> = {}
  private unsubscribeSlot: (() => void) | null = null
  private closed = false

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: Plugin,
  ) {
    super(leaf)
  }

  protected abstract get slot(): ModuleViewSlot

  getViewType(): string {
    return this.slot.type
  }

  getDisplayText(): string {
    return this.declaration?.name ?? this.slot.name
  }

  getIcon(): string {
    return this.declaration?.icon ?? this.slot.icon
  }

  onOpen(): Promise<void> {
    this.closed = false
    this.declaration = this.slot.get()
    this.unsubscribeSlot = this.slot.subscribe((declaration, previous) => {
      void this.replaceDeclaration(declaration, previous)
    })
    this.render()
    this.windowMigratedDisposer = this.containerEl.onWindowMigrated(() =>
      this.scheduleRebuild(),
    )
    this.registerEvent(
      this.plugin.app.workspace.on('window-open', () => this.scheduleRebuild()),
    )
    this.registerEvent(
      this.plugin.app.workspace.on('window-close', () =>
        this.scheduleRebuild(),
      ),
    )
    this.registerEvent(
      this.plugin.app.workspace.on('layout-change', () =>
        this.scheduleRebuild(),
      ),
    )
    this.observer = new MutationObserver(() => this.scheduleRebuild())
    this.observer.observe(this.containerEl, { childList: true })
    return Promise.resolve()
  }

  onClose(): Promise<void> {
    this.closed = true
    this.unsubscribeSlot?.()
    this.unsubscribeSlot = null
    if (this.rebuildRaf !== null) {
      this.containerEl.win.cancelAnimationFrame(this.rebuildRaf)
      this.rebuildRaf = null
    }
    this.observer?.disconnect()
    this.observer = null
    this.windowMigratedDisposer?.()
    this.windowMigratedDisposer = null
    this.root?.unmount()
    this.root = null
    this.mountedHost = null
    this.mountedDocument = null
    return Promise.resolve()
  }

  getState(): Record<string, unknown> {
    const state = snapshotViewState(this.declaration?.getState?.())
    if (state) this.lastState = state
    return { ...this.lastState }
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result)
    this.lastState = snapshotViewState(state) ?? {}
    await this.declaration?.setState?.({ ...this.lastState })
  }

  private render(): void {
    const host = this.containerEl.children[1] as HTMLElement | undefined
    if (!host) return
    if (!this.root) {
      this.root = createRoot(host)
      this.mountedHost = host
      this.mountedDocument = host.ownerDocument
    }
    this.root.render(
      <React.StrictMode>
        {this.declaration ? (
          this.declaration.render()
        ) : (
          <div className="yolo-module-view-transition" role="status" />
        )}
      </React.StrictMode>,
    )
  }

  private async replaceDeclaration(
    declaration: YoloModuleViewV1 | null,
    previous: YoloModuleViewV1 | null,
  ): Promise<void> {
    if (this.closed) return
    const state = snapshotViewState(previous?.getState?.())
    if (state) this.lastState = state
    this.root?.unmount()
    this.root = null
    this.declaration = declaration
    if (declaration) await declaration.setState?.({ ...this.lastState })
    if (!this.closed) this.render()
  }

  private scheduleRebuild(): void {
    if (this.closed || this.rebuildRaf !== null) return
    this.rebuildRaf = this.containerEl.win.requestAnimationFrame(() => {
      this.rebuildRaf = null
      if (this.closed) return
      const host = this.containerEl.children[1] as HTMLElement | undefined
      if (
        !host ||
        (host === this.mountedHost &&
          host.ownerDocument === this.mountedDocument)
      ) {
        return
      }
      this.root?.unmount()
      this.root = null
      this.render()
    })
  }
}

function createModuleItemView(
  leaf: WorkspaceLeaf,
  plugin: Plugin,
  slot: ModuleViewSlot,
): ModuleItemView {
  return new (class extends ModuleItemView {
    protected get slot(): ModuleViewSlot {
      return slot
    }
  })(leaf, plugin)
}

export type ModuleContributionRegistrar = {
  commit(
    moduleId: string,
    contributions: StagedModuleContributions,
    lifecycle: ModuleLifecycleScope,
  ): void
  deactivate?(moduleId: string, closeViews: boolean): void
  openView?(
    moduleId: string,
    options?: YoloModuleOpenViewOptionsV1,
    isActive?: () => boolean,
  ): Promise<void>
}

/** Activates modules atomically through a declaration-first host API. */
export class ModuleRuntime {
  private readonly scopes = new Map<string, ModuleLifecycleScope>()
  private readonly activeVersions = new Map<string, string>()
  private readonly pending = new Map<
    string,
    {
      lifecycle: ModuleLifecycleScope
      stager: ModuleContributionStager
      cancelActivation(): void
    }
  >()
  private readonly removeRuntimeBridge: () => void
  private disposed = false

  constructor(
    private readonly registrar: ModuleContributionRegistrar,
    private readonly capabilityProvider: ModuleHostCapabilityProviderV1,
  ) {
    this.removeRuntimeBridge = installYoloModuleRuntimeBridge()
  }

  isActive(moduleId: string, version?: string): boolean {
    if (this.disposed || !this.scopes.has(moduleId)) return false
    return (
      version === undefined || this.activeVersions.get(moduleId) === version
    )
  }

  async activate(
    definition: YoloModuleDefinition,
    version?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.disposed) throw new Error('Module runtime is disposed')
    if (signal?.aborted) throw new Error('Module activation was aborted')
    if (this.scopes.has(definition.id) || this.pending.has(definition.id)) {
      throw new Error(`Module "${definition.id}" is already active`)
    }
    const lifecycle = new ModuleLifecycleScope()
    const stager = new ModuleContributionStager()
    let cancelActivation!: () => void
    const activationCancelled = new Promise<void>((resolve) => {
      cancelActivation = resolve
    })
    let activationWasCancelled = false
    const markActivationCancelled = () => {
      activationWasCancelled = true
      cancelActivation()
    }
    const abortActivation = () => markActivationCancelled()
    signal?.addEventListener('abort', abortActivation, { once: true })
    let workspaceActive = false
    const isWorkspaceActive = (): boolean => workspaceActive && !this.disposed
    const workspace: YoloModuleWorkspaceV1 = Object.freeze({
      registerView: stager.workspace.registerView,
      registerRibbonAction: stager.workspace.registerRibbonAction,
      registerCommand: stager.workspace.registerCommand,
      openView: (options) => {
        if (!isWorkspaceActive()) {
          return Promise.reject(
            new Error(`Module "${definition.id}" workspace is not active`),
          )
        }
        if (!this.registrar.openView) {
          return Promise.reject(
            new Error('Module workspace navigation is unavailable'),
          )
        }
        let snapshot: YoloModuleOpenViewOptionsV1 | undefined
        try {
          snapshot = snapshotOpenViewOptions(options)
        } catch (error) {
          return Promise.reject(toError(error))
        }
        return this.registrar.openView(
          definition.id,
          snapshot,
          isWorkspaceActive,
        )
      },
    })
    this.pending.set(definition.id, {
      lifecycle,
      stager,
      cancelActivation: markActivationCancelled,
    })
    try {
      const capabilityActivation = this.capabilityProvider.create(
        definition.id,
        lifecycle,
      )
      const definitionResult = await Promise.race([
        Promise.resolve(
          definition.activate({
            version: 1,
            lifecycle,
            workspace,
            agent: capabilityActivation.capabilities.agent,
            assets: capabilityActivation.capabilities.assets,
            background: capabilityActivation.capabilities.background,
            config: capabilityActivation.capabilities.config,
            paths: capabilityActivation.capabilities.paths,
            privateStorage: capabilityActivation.capabilities.privateStorage,
            settings: capabilityActivation.capabilities.settings,
            ui: capabilityActivation.capabilities.ui,
            vault: capabilityActivation.capabilities.vault,
            workers: capabilityActivation.capabilities.workers,
          }),
        ).then(() => 'activated' as const),
        activationCancelled.then(() => 'disposed' as const),
      ])
      if (
        definitionResult === 'disposed' ||
        activationWasCancelled ||
        this.disposed
      ) {
        throw new Error('Module runtime was disposed during activation')
      }
      lifecycle.closeWhenActiveRegistration()
      const contributions = stager.finish({ allowEmpty: true })
      const preparationResult = await Promise.race([
        capabilityActivation.prepare().then(() => 'prepared' as const),
        activationCancelled.then(() => 'disposed' as const),
      ])
      if (
        preparationResult === 'disposed' ||
        activationWasCancelled ||
        this.disposed
      ) {
        throw new Error('Module runtime was disposed during capability prepare')
      }
      // Runtime state also closes navigation during reentrant disposal.
      lifecycle.add(() => {
        workspaceActive = false
      })
      capabilityActivation.activate()
      if (activationWasCancelled || this.disposed) {
        throw new Error(
          'Module runtime was disposed during capability activation',
        )
      }
      const activeCallbackResult = await Promise.race([
        lifecycle
          .runWhenActiveCallbacks(() => activationWasCancelled || this.disposed)
          .then(() => 'activated' as const),
        activationCancelled.then(() => 'disposed' as const),
      ])
      if (
        activeCallbackResult === 'disposed' ||
        activationWasCancelled ||
        this.disposed
      ) {
        throw new Error(
          'Module runtime was disposed during whenActive callbacks',
        )
      }
      workspaceActive = true
      this.registrar.commit(definition.id, contributions, lifecycle)
      if (activationWasCancelled || this.disposed) {
        throw new Error(
          'Module runtime was disposed during contribution commit',
        )
      }
      capabilityActivation.commit()
      if (activationWasCancelled || this.disposed) {
        throw new Error('Module runtime was disposed during capability commit')
      }
      this.scopes.set(definition.id, lifecycle)
      if (version !== undefined) this.activeVersions.set(definition.id, version)
    } catch (error) {
      workspaceActive = false
      stager.close()
      try {
        lifecycle.dispose()
      } catch (cleanupError) {
        console.error(
          `[YOLO] Module "${definition.id}" activation rollback failed`,
          cleanupError,
        )
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', abortActivation)
      this.pending.delete(definition.id)
    }
  }

  async deactivate(
    moduleId: string,
    options: Readonly<{ closeViews?: boolean }> = {},
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.disposed) throw new Error('Module runtime is disposed')
    const lifecycle = this.scopes.get(moduleId)
    if (!lifecycle) return
    await waitForQuiescence(lifecycle.quiesce(), signal)
    if (signal?.aborted) throw new Error('Module deactivation was aborted')
    this.registrar.deactivate?.(moduleId, options.closeViews === true)
    this.scopes.delete(moduleId)
    this.activeVersions.delete(moduleId)
    lifecycle.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [id, activation] of [...this.pending].reverse()) {
      activation.cancelActivation()
      activation.stager.close()
      try {
        activation.lifecycle.dispose()
      } catch (error) {
        console.error(`[YOLO] Pending module "${id}" cleanup failed`, error)
      }
    }
    this.pending.clear()
    for (const [id, scope] of [...this.scopes].reverse()) {
      try {
        scope.dispose()
      } catch (error) {
        console.error(`[YOLO] Module "${id}" cleanup failed`, error)
      }
    }
    this.scopes.clear()
    this.activeVersions.clear()
    this.removeRuntimeBridge()
  }
}

/**
 * Obsidian has no public unregisterView API. Each view type therefore keeps a
 * host-owned slot for the plugin lifetime while module declarations are bound
 * and released independently across activation changes.
 */
export class ObsidianModuleContributionRegistrar
  implements ModuleContributionRegistrar
{
  private readonly viewSlotsByType = new Map<string, ModuleViewSlot>()
  private readonly viewSlotByModuleId = new Map<string, ModuleViewSlot>()
  private readonly openingViewByModuleId = new Map<string, Promise<void>>()

  constructor(private readonly plugin: Plugin) {}

  commit(
    moduleId: string,
    contributions: StagedModuleContributions,
    lifecycle: ModuleLifecycleScope,
  ): void {
    const view = contributions.view
    const existingSlot = this.viewSlotByModuleId.get(moduleId)
    if (view && existingSlot?.get()) {
      throw new Error(`Module view type "${view.type}" is already active`)
    }
    if (view && !existingSlot && this.viewSlotsByType.has(view.type)) {
      throw new Error(`Module view type "${view.type}" is already registered`)
    }

    for (const command of contributions.commands ?? []) {
      const commandId = `module:${moduleId}:${command.id}`
      let commandActive = true
      this.plugin.addCommand({
        id: commandId,
        name: command.name,
        callback: () => {
          if (!commandActive) return
          try {
            const result = command.callback()
            if (isThenable(result)) {
              void Promise.resolve(result).catch((error: unknown) => {
                console.error(
                  `[YOLO] Module "${moduleId}" command "${command.id}" failed`,
                  error,
                )
              })
            }
          } catch (error) {
            console.error(
              `[YOLO] Module "${moduleId}" command "${command.id}" failed`,
              error,
            )
          }
        },
      })
      lifecycle.add(() => {
        commandActive = false
        this.plugin.removeCommand(commandId)
      })
    }

    if (contributions.ribbonAction) {
      const action = contributions.ribbonAction
      const ribbon = this.plugin.addRibbonIcon(
        action.icon,
        action.title,
        () => {
          try {
            action.onClick()
          } catch (error) {
            console.error(
              `[YOLO] Module "${moduleId}" ribbon action failed`,
              error,
            )
          }
        },
      )
      lifecycle.add(() => ribbon.remove())
    }

    if (view) {
      const slot =
        existingSlot ??
        new ModuleViewSlot(moduleId, view.type, view.name, view.icon)
      if (!existingSlot) {
        this.plugin.registerView(view.type, (leaf) =>
          createModuleItemView(leaf, this.plugin, slot),
        )
        this.viewSlotsByType.set(view.type, slot)
        this.viewSlotByModuleId.set(moduleId, slot)
      }
      slot.bind(view)
      lifecycle.add(() => slot.unbind(view))
    }
  }

  deactivate(moduleId: string, closeViews: boolean): void {
    const slot = this.viewSlotByModuleId.get(moduleId)
    if (!slot) return
    slot.unbind()
    if (closeViews) this.plugin.app.workspace.detachLeavesOfType(slot.type)
  }

  async openView(
    moduleId: string,
    options?: YoloModuleOpenViewOptionsV1,
    isActive: () => boolean = () => true,
  ): Promise<void> {
    const slot = this.viewSlotByModuleId.get(moduleId)
    if (!slot?.get()) {
      throw new Error(`Module "${moduleId}" has no registered view`)
    }
    const viewType = slot.type
    assertModuleWorkspaceActive(moduleId, isActive)
    if (options?.newLeaf) {
      return this.openViewNow(moduleId, viewType, options, isActive)
    }
    const pending = this.openingViewByModuleId.get(moduleId)
    if (pending) return pending
    const opening = this.openViewNow(moduleId, viewType, options, isActive)
    this.openingViewByModuleId.set(moduleId, opening)
    try {
      await opening
    } finally {
      if (this.openingViewByModuleId.get(moduleId) === opening) {
        this.openingViewByModuleId.delete(moduleId)
      }
    }
  }

  private async openViewNow(
    moduleId: string,
    viewType: string,
    options: YoloModuleOpenViewOptionsV1 | undefined,
    isActive: () => boolean,
  ): Promise<void> {
    const workspace = this.plugin.app.workspace
    const newLeaf = options?.newLeaf === true
    assertModuleWorkspaceActive(moduleId, isActive)
    if (!newLeaf) {
      const existing = workspace.getLeavesOfType(viewType)[0]
      if (existing) {
        if (optionsHasState(options)) {
          await existing.setViewState({
            type: viewType,
            active: true,
            state: options.state,
          })
          assertModuleWorkspaceActive(moduleId, isActive)
        }
        await workspace.revealLeaf(existing)
        assertModuleWorkspaceActive(moduleId, isActive)
        return
      }
    }
    const leaf = workspace.getLeaf('tab')
    try {
      assertModuleWorkspaceActive(moduleId, isActive)
      await leaf.setViewState({
        type: viewType,
        active: true,
        ...(optionsHasState(options) ? { state: options.state } : {}),
      })
      assertModuleWorkspaceActive(moduleId, isActive)
      await workspace.revealLeaf(leaf)
      assertModuleWorkspaceActive(moduleId, isActive)
    } catch (error) {
      try {
        leaf.detach()
      } catch (cleanupError) {
        console.error(
          `[YOLO] Module "${moduleId}" failed to detach an incomplete view`,
          cleanupError,
        )
      }
      throw error
    }
  }
}

function snapshotOpenViewOptions(
  options: YoloModuleOpenViewOptionsV1 | undefined,
): YoloModuleOpenViewOptionsV1 | undefined {
  if (options === undefined) return undefined
  if (!options || typeof options !== 'object') {
    throw new TypeError('Module openView options must be an object')
  }
  const newLeaf = options.newLeaf
  if (newLeaf !== undefined && typeof newLeaf !== 'boolean') {
    throw new TypeError('Module openView newLeaf must be a boolean')
  }
  const state = options.state
  return Object.freeze({
    newLeaf,
    ...(Object.prototype.hasOwnProperty.call(options, 'state')
      ? { state: snapshotViewState(state) }
      : {}),
  })
}

function optionsHasState(
  options: YoloModuleOpenViewOptionsV1 | undefined,
): options is YoloModuleOpenViewOptionsV1 & { state: unknown } {
  return Boolean(
    options && Object.prototype.hasOwnProperty.call(options, 'state'),
  )
}

function snapshotViewState(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Module view state must be an object')
  }
  try {
    return structuredClone(value) as Record<string, unknown>
  } catch {
    throw new TypeError('Module view state must be structured-cloneable')
  }
}

function assertModuleWorkspaceActive(
  moduleId: string,
  isActive: () => boolean,
): void {
  if (!isActive()) {
    throw new Error(`Module "${moduleId}" workspace is not active`)
  }
}

function waitForQuiescence(
  operation: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return operation
  if (signal.aborted)
    return Promise.reject(new Error('Module deactivation was aborted'))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new Error('Module deactivation was aborted'))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      () => {
        cleanup()
        resolve()
      },
      (error) => {
        cleanup()
        reject(toError(error))
      },
    )
  })
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}
