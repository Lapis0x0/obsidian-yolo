import type { ModuleLifecycleScope } from './lifecycleScope'
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
      }),
      activate: () => undefined,
    }),
  })

export class ManagedModulePathsCapabilityProvider
  implements ModulePathsCapabilityProviderV1
{
  constructor(
    private readonly options: ManagedModulePathsCapabilityProviderOptions,
  ) {}

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModulePathsCapabilityActivationV1 {
    assertModuleId(moduleId)
    let active = true
    let activationComplete = false
    let changedBeforeActivation = false
    let snapshot = this.createSnapshot(moduleId)
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

function assertModuleId(moduleId: string): void {
  if (
    !moduleId ||
    moduleId === '.' ||
    moduleId === '..' ||
    /[\\/]/.test(moduleId)
  ) {
    throw new Error('Module id must be a non-empty path segment')
  }
}
