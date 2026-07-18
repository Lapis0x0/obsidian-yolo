import type { ModuleLifecycleScope } from './lifecycleScope'
import {
  ManagedModuleDataLockOwner,
  type ManagedModuleDataVaultIdentity,
  assertManagedModuleDataNamespace,
  managedModuleDataNamespace,
} from './managedModuleDataLock'
import { assertModuleId } from './moduleStore'
import { normalizeModuleVaultPath } from './moduleVault'
import type {
  ModuleDisposer,
  YoloModulePathsSnapshotV1,
  YoloModulePathsV1,
} from './types'

export type ModulePathsCapabilityActivationV1 = Readonly<{
  api: YoloModulePathsV1
  activate(): void
}>

export type ModulePathsCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModulePathsCapabilityActivationV1
}

export type ManagedModulePathsCapabilityProviderOptions = {
  getBaseDir(): string
  subscribe(listener: () => void): ModuleDisposer
  /** Stable Vault object shared by every provider and Core lock caller. */
  vaultIdentity?: ManagedModuleDataVaultIdentity
  reportCallbackError?: (moduleId: string, error: unknown) => void
}

const unavailable = (): never => {
  throw new Error('Module managed paths are unavailable')
}

export const UNAVAILABLE_MODULE_PATHS_CAPABILITY_PROVIDER: ModulePathsCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: Object.freeze({
        getSnapshot: unavailable,
        subscribe: unavailable,
        runExclusive: unavailable,
      }),
      activate: () => undefined,
    }),
  })

export class ManagedModulePathsCapabilityProvider
  implements ModulePathsCapabilityProviderV1
{
  private readonly fallbackVaultIdentity = {}

  constructor(
    private readonly options: ManagedModulePathsCapabilityProviderOptions,
  ) {}

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModulePathsCapabilityActivationV1 {
    assertModuleId(moduleId, 'Module id')
    let active = true
    let activationComplete = false
    let changedBeforeActivation = false
    let snapshot = this.createSnapshot(moduleId)
    const lockOwner = new ManagedModuleDataLockOwner(
      this.options.vaultIdentity ?? this.fallbackVaultIdentity,
    )
    const listeners = new Set<() => void>()
    const reportCallbackError = (error: unknown): void => {
      try {
        this.options.reportCallbackError?.(moduleId, error)
      } catch {
        // Error reporting must not let module callbacks escape the host boundary.
      }
    }
    const notifyListeners = (): void => {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          reportCallbackError(error)
        }
      }
    }
    const unsubscribeSource = this.options.subscribe(() => {
      if (!active) return
      const next = this.createSnapshot(moduleId)
      if (next.contentRoot === snapshot.contentRoot) return
      snapshot = next
      if (!activationComplete) {
        changedBeforeActivation = true
        return
      }
      notifyListeners()
    })
    lifecycle.add(() => {
      active = false
      activationComplete = false
      listeners.clear()
      unsubscribeSource()
      lockOwner.dispose()
    })

    const assertActive = (): void => {
      if (!active) throw new Error(`Module "${moduleId}" is no longer active`)
    }
    const api: YoloModulePathsV1 = Object.freeze({
      getSnapshot: () => {
        assertActive()
        return snapshot
      },
      subscribe: (listener) => {
        assertActive()
        if (typeof listener !== 'function') {
          throw new TypeError('Module paths listener must be a function')
        }
        listeners.add(listener)
        let subscribed = true
        return () => {
          if (!subscribed) return
          subscribed = false
          listeners.delete(listener)
        }
      },
      runExclusive: (namespace, operation) => {
        assertActive()
        assertManagedModuleDataNamespace(namespace)
        if (typeof operation !== 'function') {
          throw new TypeError('Managed data lock operation must be a function')
        }
        return lockOwner.runExclusive(
          managedModuleDataNamespace(moduleId, namespace),
          operation,
        )
      },
    })
    return Object.freeze({
      api,
      activate: () => {
        assertActive()
        activationComplete = true
        if (changedBeforeActivation) {
          changedBeforeActivation = false
          notifyListeners()
        }
      },
    })
  }

  private createSnapshot(moduleId: string): YoloModulePathsSnapshotV1 {
    const baseDir = normalizeModuleVaultPath(this.options.getBaseDir())
    if (!baseDir) throw new Error('YOLO base directory must not be empty')
    return Object.freeze({
      contentRoot: normalizeModuleVaultPath(`${baseDir}/${moduleId}`),
    })
  }
}
