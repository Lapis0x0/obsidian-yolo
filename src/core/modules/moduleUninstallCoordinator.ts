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
  assertModulePathSegment,
} from './moduleStore'

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export type ModuleUninstallCoordinatorOptions = Readonly<{
  artifactStore: Pick<ModuleStore, 'removeVersionArtifacts'>
  deviceStateStore: Pick<ModuleDeviceStateStore, 'runExclusive'>
  intentStore: Pick<ModuleIntentStore, 'get'>
  manager: Pick<ModuleManager, 'refresh'>
  /** Shared with every activation path; it does not deactivate a live module. */
  runtime: ModuleRuntimeQuiescence
  /**
   * Product-policy gate only. It cannot detect other devices. Production must
   * not authorize until missing artifacts can be verified and redownloaded.
   */
  authorizeArtifactRemoval(
    moduleId: string,
    versions: readonly string[],
  ): Promise<boolean>
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
      typeof options.authorizeArtifactRemoval !== 'function' ||
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
            if (intent?.desiredInstalled !== false) {
              throw new Error(
                `Module "${moduleId}" uninstall requires desiredInstalled to be false`,
              )
            }

            const state = await transaction.read()
            if (state === null) return
            const versions = validateRemovableState(
              state,
              moduleId,
              this.options.platform,
            )
            const authorized = await this.options.authorizeArtifactRemoval(
              moduleId,
              versions,
            )
            if (authorized !== true) {
              throw new Error(
                `Module "${moduleId}" artifact removal is not authorized by product policy`,
              )
            }
            for (const version of versions) {
              await this.options.artifactStore.removeVersionArtifacts(
                moduleId,
                version,
              )
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
  // The runtime reservation proves current-process inactivity. activeVersion is
  // only the durable pointer from the last successful startup.
  if (state.transition !== null) {
    throw new Error(
      `Module "${moduleId}" uninstall is blocked by an active transition`,
    )
  }
  if (state.pendingVersion !== null) {
    throw new Error(
      `Module "${moduleId}" uninstall is blocked by a pending version`,
    )
  }

  const versions = Object.keys(state.readyVersions).sort()
  const canonicalVersions = new Set<string>()
  for (const version of versions) {
    assertModulePathSegment(version, 'Module version')
    if (!SEMVER.test(version)) {
      throw new Error('Module version must be semantic')
    }
    const canonical = version.normalize('NFKC').toLowerCase()
    if (canonicalVersions.has(canonical)) {
      throw new Error('Module ready versions contain a path alias')
    }
    canonicalVersions.add(canonical)
    const descriptor = state.readyVersions[version]
    if (
      !descriptor ||
      descriptor.id !== moduleId ||
      descriptor.version !== version ||
      descriptor.platform !== platform
    ) {
      throw new Error(
        `Module "${moduleId}" has a mismatched descriptor for "${version}"`,
      )
    }
  }
  for (const pointer of [state.activeVersion, state.downloadedCandidate]) {
    if (
      pointer !== null &&
      !Object.prototype.hasOwnProperty.call(state.readyVersions, pointer)
    ) {
      throw new Error(`Module "${moduleId}" has an invalid version pointer`)
    }
  }
  return Object.freeze(versions)
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
