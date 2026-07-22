import type {
  ModuleDeviceState,
  ModuleDeviceStateStore,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import type { ModuleIntentStore } from './moduleIntentStore'
import type { ModuleManager } from './moduleManager'
import type { ModuleRuntimeQuiescence } from './moduleRuntimeReservation'
import {
  type ModuleArtifactPlatform,
  type ModuleStore,
  assertModuleId,
} from './moduleStore'

export type ModuleUninstallCoordinatorOptions = Readonly<{
  artifactStore: Pick<ModuleStore, 'removeVersionArtifacts'>
  deviceStateStore: Pick<ModuleDeviceStateStore, 'runExclusive'>
  intentStore: Pick<ModuleIntentStore, 'get'>
  manager: Pick<ModuleManager, 'refresh'>
  /** Shared with every activation path; it does not deactivate a live module. */
  runtime: ModuleRuntimeQuiescence
  platform: ModuleArtifactPlatform
}>

export class ModuleUninstallRefreshError extends Error {
  readonly uninstallError: Error
  readonly refreshError: Error

  constructor(moduleId: string, uninstallError: Error, refreshError: Error) {
    super(
      `Module "${moduleId}" uninstall failed and the module manager could not be refreshed`,
    )
    this.name = 'ModuleUninstallRefreshError'
    this.uninstallError = uninstallError
    this.refreshError = refreshError
  }
}

/** Removes only local program artifacts and their device-local installation state. */
export class ModuleUninstallCoordinator {
  constructor(private readonly options: ModuleUninstallCoordinatorOptions) {
    if (
      !options ||
      typeof options.artifactStore?.removeVersionArtifacts !== 'function' ||
      typeof options.deviceStateStore?.runExclusive !== 'function' ||
      typeof options.intentStore?.get !== 'function' ||
      typeof options.manager?.refresh !== 'function' ||
      typeof options.runtime?.runWithModuleQuiesced !== 'function' ||
      (options.platform !== 'desktop' && options.platform !== 'mobile')
    ) {
      throw new Error('Module uninstall coordinator options are invalid')
    }
  }

  async uninstall(moduleId: string): Promise<void> {
    assertModuleId(moduleId, 'Module id')
    let uninstallError: Error | undefined
    try {
      await this.options.runtime.runWithModuleQuiesced(moduleId, () =>
        this.options.deviceStateStore.runExclusive(
          moduleId,
          async (transaction) => {
            const intent = await this.options.intentStore.get(moduleId)
            if (intent !== 'uninstalled') {
              throw new Error(
                `Module "${moduleId}" uninstall requires uninstalled intent`,
              )
            }

            let state = await transaction.read()
            if (state === null) return
            const versions = validateRemovableState(
              state,
              moduleId,
              this.options.platform,
            )
            for (const version of versions) {
              await this.options.artifactStore.removeVersionArtifacts(
                moduleId,
                version,
              )
            }
            if (state.pending !== null) {
              state = await transaction.write({ ...state, pending: null })
            }
            await removeState(transaction)
          },
        ),
      )
    } catch (error) {
      uninstallError = toError(error)
    }

    try {
      await this.options.manager.refresh()
    } catch (refreshError) {
      const refreshFailure = toError(refreshError)
      if (uninstallError !== undefined) {
        throw new ModuleUninstallRefreshError(
          moduleId,
          uninstallError,
          refreshFailure,
        )
      }
      throw refreshFailure
    }
    if (uninstallError !== undefined) throw uninstallError
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function validateRemovableState(
  state: ModuleDeviceState,
  moduleId: string,
  platform: ModuleArtifactPlatform,
): readonly string[] {
  if (state.moduleId !== moduleId) {
    throw new Error(`Module "${moduleId}" returned mismatched device state`)
  }
  if (state.platform !== platform) {
    throw new Error(
      `Module "${moduleId}" device state belongs to ${state.platform}, not ${platform}`,
    )
  }
  // The runtime reservation proves current-process inactivity. `active` only
  // records the descriptor from the last successful startup.
  return Object.freeze(
    [
      ...new Set(
        [state.active?.version, state.pending?.descriptor.version].filter(
          (version): version is string => version !== undefined,
        ),
      ),
    ].sort(),
  )
}

async function removeState(
  transaction: ModuleDeviceStateTransaction,
): Promise<void> {
  try {
    await transaction.remove()
  } catch (error) {
    // Removal can fail after commit. Readback proves success without restoring
    // state or any other data; uncertainty remains a retryable failure.
    try {
      if ((await transaction.read()) === null) return
    } catch {
      // Preserve the original removal failure when readback is unavailable.
    }
    throw error
  }
}
