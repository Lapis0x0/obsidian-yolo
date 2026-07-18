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

class ModuleItemView extends ItemView {
  private root: Root | null = null
  private mountedHost: HTMLElement | null = null
  private mountedDocument: Document | null = null
  private observer: MutationObserver | null = null
  private windowMigratedDisposer: (() => void) | null = null
  private rebuildRaf: number | null = null
  private closed = false

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: Plugin,
    private readonly declaration: YoloModuleViewV1,
  ) {
    super(leaf)
  }

  getViewType(): string {
    return this.declaration.type
  }

  getDisplayText(): string {
    return this.declaration.name
  }

  getIcon(): string {
    return this.declaration.icon
  }

  onOpen(): Promise<void> {
    this.closed = false
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
    return snapshotViewState(this.declaration.getState?.()) ?? {}
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result)
    await this.declaration.setState?.(snapshotViewState(state) ?? {})
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
      <React.StrictMode>{this.declaration.render()}</React.StrictMode>,
    )
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

export type ModuleContributionRegistrar = {
  commit(
    moduleId: string,
    contributions: StagedModuleContributions,
    lifecycle: ModuleLifecycleScope,
  ): void
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
    const abortActivation = () => cancelActivation()
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
      cancelActivation,
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
      if (definitionResult === 'disposed' || this.disposed) {
        throw new Error('Module runtime was disposed during activation')
      }
      const contributions = stager.finish({ allowEmpty: true })
      const preparationResult = await Promise.race([
        capabilityActivation.prepare().then(() => 'prepared' as const),
        activationCancelled.then(() => 'disposed' as const),
      ])
      if (preparationResult === 'disposed' || this.disposed) {
        throw new Error('Module runtime was disposed during capability prepare')
      }
      // Runtime state also closes navigation during reentrant disposal.
      lifecycle.add(() => {
        workspaceActive = false
      })
      capabilityActivation.activate()
      if (this.disposed) {
        throw new Error(
          'Module runtime was disposed during capability activation',
        )
      }
      workspaceActive = true
      this.registrar.commit(definition.id, contributions, lifecycle)
      if (this.disposed) {
        throw new Error(
          'Module runtime was disposed during contribution commit',
        )
      }
      capabilityActivation.commit()
      if (this.disposed) {
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
 * Obsidian has no public unregisterView API. Registered view types therefore
 * live until plugin reload. Module disposal removes resources that have public
 * cleanup APIs; Obsidian preserves and restores view leaves across reloads.
 */
export class ObsidianModuleContributionRegistrar
  implements ModuleContributionRegistrar
{
  private readonly viewTypes = new Set<string>()
  private readonly viewTypeByModuleId = new Map<string, string>()
  private readonly openingViewByModuleId = new Map<string, Promise<void>>()

  constructor(private readonly plugin: Plugin) {}

  commit(
    moduleId: string,
    contributions: StagedModuleContributions,
    lifecycle: ModuleLifecycleScope,
  ): void {
    const view = contributions.view
    if (view && this.viewTypes.has(view.type)) {
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
      this.plugin.registerView(
        view.type,
        (leaf) => new ModuleItemView(leaf, this.plugin, view),
      )
      this.viewTypes.add(view.type)
      this.viewTypeByModuleId.set(moduleId, view.type)
    }
  }

  async openView(
    moduleId: string,
    options?: YoloModuleOpenViewOptionsV1,
    isActive: () => boolean = () => true,
  ): Promise<void> {
    const viewType = this.viewTypeByModuleId.get(moduleId)
    if (!viewType) {
      throw new Error(`Module "${moduleId}" has no registered view`)
    }
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
