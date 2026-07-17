import { ItemView, type Plugin, type WorkspaceLeaf } from 'obsidian'
import React from 'react'
import { type Root, createRoot } from 'react-dom/client'

import type { StagedModuleContributions } from './contributionStager'
import { ModuleContributionStager } from './contributionStager'
import { ModuleLifecycleScope } from './lifecycleScope'
import { installYoloModuleRuntimeBridge } from './runtimeBridge'
import type { YoloModuleDefinition, YoloModuleViewV1 } from './types'

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
}

/** Activates modules atomically through a declaration-first host API. */
export class ModuleRuntime {
  private readonly scopes = new Map<string, ModuleLifecycleScope>()
  private readonly pending = new Map<
    string,
    {
      lifecycle: ModuleLifecycleScope
      stager: ModuleContributionStager
    }
  >()
  private readonly removeRuntimeBridge: () => void
  private disposed = false

  constructor(private readonly registrar: ModuleContributionRegistrar) {
    this.removeRuntimeBridge = installYoloModuleRuntimeBridge()
  }

  async activate(definition: YoloModuleDefinition): Promise<void> {
    if (this.disposed) throw new Error('Module runtime is disposed')
    if (this.scopes.has(definition.id) || this.pending.has(definition.id)) {
      throw new Error(`Module "${definition.id}" is already active`)
    }
    const lifecycle = new ModuleLifecycleScope()
    const stager = new ModuleContributionStager()
    this.pending.set(definition.id, { lifecycle, stager })
    try {
      await definition.activate({
        version: 1,
        lifecycle,
        workspace: stager.workspace,
      })
      if (this.disposed) {
        throw new Error('Module runtime was disposed during activation')
      }
      const contributions = stager.finish()
      this.registrar.commit(definition.id, contributions, lifecycle)
      this.scopes.set(definition.id, lifecycle)
    } catch (error) {
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
      this.pending.delete(definition.id)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [id, activation] of [...this.pending].reverse()) {
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
    }
  }
}
