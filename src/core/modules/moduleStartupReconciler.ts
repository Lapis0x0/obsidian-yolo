import type { ModuleActivationCoordinator } from './moduleActivationCoordinator'
import type { ModuleIntent, ModuleIntentStore } from './moduleIntentStore'
import type { ModuleManager } from './moduleManager'
import type { ModuleReadinessReconciler } from './moduleReadinessReconciler'
import { assertModuleId } from './moduleStore'
import type { ModuleDisposer } from './types'

/**
 * Production-owned union of synchronized intent, local device-state, and
 * catalog module IDs. The intent backend cannot provide this safely itself.
 */
export type ModuleStartupReconcileSource = Readonly<{
  listKnownModuleIds(): Promise<readonly string[]>
  subscribe(listener: (moduleId: string) => void): ModuleDisposer
}>

export type ModuleStartupReconcilerOptions = Readonly<{
  source: ModuleStartupReconcileSource
  intentStore: Pick<ModuleIntentStore, 'get'>
  readinessReconciler: Pick<ModuleReadinessReconciler, 'ensureModuleReady'>
  activationCoordinator: Pick<
    ModuleActivationCoordinator,
    'activatePersistedModules'
  >
  manager: Pick<ModuleManager, 'refresh'>
  scheduleSafeUninstall?: (moduleId: string) => Promise<void>
  requestReload: (moduleId: string) => void
  reportError?: (error: unknown, moduleId?: string) => void
}>

/** Owns startup ordering and synchronized-intent reconciliation. */
export class ModuleStartupReconciler {
  private readonly intents = new Map<string, ModuleIntent | null>()
  private readonly pendingModuleIds = new Set<string>()
  private unsubscribe: ModuleDisposer | undefined
  private startup: Promise<void> | undefined
  private updateOperation: Promise<void> = Promise.resolve()
  private drainScheduled = false
  private startupComplete = false
  private disposed = false

  constructor(private readonly options: ModuleStartupReconcilerOptions) {
    if (
      !options ||
      typeof options.source?.listKnownModuleIds !== 'function' ||
      typeof options.source?.subscribe !== 'function' ||
      typeof options.intentStore?.get !== 'function' ||
      typeof options.readinessReconciler?.ensureModuleReady !== 'function' ||
      typeof options.activationCoordinator?.activatePersistedModules !==
        'function' ||
      typeof options.manager?.refresh !== 'function' ||
      (options.scheduleSafeUninstall !== undefined &&
        typeof options.scheduleSafeUninstall !== 'function') ||
      typeof options.requestReload !== 'function' ||
      (options.reportError !== undefined &&
        typeof options.reportError !== 'function')
    ) {
      throw new TypeError('Module startup reconciler options are invalid')
    }
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(disposedError())
    if (this.startup) return this.startup

    try {
      this.unsubscribe = this.options.source.subscribe((moduleId) => {
        if (this.disposed) return
        try {
          assertModuleId(moduleId, 'Module id')
        } catch (error) {
          this.report(error)
          return
        }
        this.pendingModuleIds.add(moduleId)
        if (this.startupComplete) this.scheduleDrain()
      })
    } catch (error) {
      return Promise.reject(toError(error))
    }

    this.startup = this.runStartup().catch((error) => {
      this.releaseSubscription()
      throw toError(error)
    })
    return this.startup
  }

  async whenIdle(): Promise<void> {
    if (this.disposed) throw disposedError()
    if (!this.startup)
      throw new Error('Module startup reconciler has not started')
    await this.startup
    while (this.drainScheduled || this.pendingModuleIds.size > 0) {
      const operation = this.updateOperation
      await operation
      if (operation === this.updateOperation && !this.drainScheduled) break
    }
    if (this.disposed) throw disposedError()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pendingModuleIds.clear()
    this.releaseSubscription()
  }

  private releaseSubscription(): void {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch (error) {
        this.report(error)
      }
    }
  }

  private async runStartup(): Promise<void> {
    const listed = await this.options.source.listKnownModuleIds()
    if (this.disposed) throw disposedError()
    if (!Array.isArray(listed)) {
      throw new TypeError('Module startup source ids must be an array')
    }
    for (const moduleId of listed) {
      assertModuleId(moduleId, 'Module id')
      this.pendingModuleIds.add(moduleId)
    }

    while (this.pendingModuleIds.size > 0) {
      await this.reconcilePending()
      if (this.disposed) throw disposedError()
    }

    const results =
      await this.options.activationCoordinator.activatePersistedModules()
    for (const result of results) {
      if (result.status === 'failed') {
        this.report(
          new Error(result.error ?? 'Module activation failed'),
          result.moduleId,
        )
      }
    }
    if (this.disposed) throw disposedError()
    this.startupComplete = true
    if (this.pendingModuleIds.size > 0) this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.disposed || this.drainScheduled) return
    this.drainScheduled = true
    this.updateOperation = this.updateOperation
      .catch(() => undefined)
      .then(async () => {
        try {
          while (!this.disposed && this.pendingModuleIds.size > 0) {
            await this.reconcilePending()
          }
        } finally {
          this.drainScheduled = false
          if (!this.disposed && this.pendingModuleIds.size > 0) {
            this.scheduleDrain()
          }
        }
      })
  }

  private async reconcilePending(): Promise<void> {
    const moduleIds = [...this.pendingModuleIds].sort()
    this.pendingModuleIds.clear()
    const reloadIds: string[] = []
    const uninstallIds: string[] = []

    for (const moduleId of moduleIds) {
      if (this.disposed) return
      const previous = this.intents.get(moduleId)
      let intent: ModuleIntent | undefined
      try {
        intent = await this.options.intentStore.get(moduleId)
      } catch (error) {
        this.report(error, moduleId)
        continue
      }
      if (this.disposed) return
      const current = intent ? snapshotIntent(intent) : null
      this.intents.set(moduleId, current)

      if (current?.desiredInstalled) {
        try {
          const result =
            await this.options.readinessReconciler.ensureModuleReady(moduleId)
          if (result.status === 'failed') {
            this.report(
              new Error(
                result.error ?? 'Module readiness reconciliation failed',
              ),
              moduleId,
            )
          }
        } catch (error) {
          this.report(error, moduleId)
        }
      } else if (current?.desiredInstalled === false) {
        uninstallIds.push(moduleId)
      }

      if (
        previous !== undefined &&
        isLiveEligible(previous) !== isLiveEligible(current)
      ) {
        reloadIds.push(moduleId)
      }
    }

    if (this.disposed) return
    try {
      await this.options.manager.refresh()
    } catch (error) {
      this.report(error)
    }
    if (this.disposed) return

    for (const moduleId of uninstallIds) {
      try {
        await this.options.scheduleSafeUninstall?.(moduleId)
      } catch (error) {
        this.report(error, moduleId)
      }
    }
    if (this.disposed) return
    for (const moduleId of reloadIds) {
      try {
        this.options.requestReload(moduleId)
      } catch (error) {
        this.report(error, moduleId)
      }
    }
  }

  private report(error: unknown, moduleId?: string): void {
    try {
      this.options.reportError?.(error, moduleId)
    } catch {
      // Diagnostics must not block reconciliation of other modules.
    }
  }
}

function snapshotIntent(intent: ModuleIntent): ModuleIntent {
  return Object.freeze({
    desiredInstalled: intent.desiredInstalled,
    enabled: intent.enabled,
  })
}

function isLiveEligible(intent: ModuleIntent | null): boolean {
  return intent?.desiredInstalled === true && intent.enabled === true
}

function disposedError(): Error {
  return new Error('Module startup reconciler is disposed')
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
