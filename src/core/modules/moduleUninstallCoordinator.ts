import type {
  ModuleDeviceState,
  ModuleDeviceStateStore,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
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
  runtime: Readonly<{
    /** Atomically rejects active/pending modules and excludes activation until settlement. */
    runWithModuleQuiesced<T>(
      moduleId: string,
      operation: () => Promise<T>,
    ): Promise<T>
  }>
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

/** Removes only local program artifacts and their device-local installation state. */
export class ModuleUninstallCoordinator {
  constructor(private readonly options: ModuleUninstallCoordinatorOptions) {
    if (
      !options ||
      typeof options.artifactStore?.removeVersionArtifacts !== 'function' ||
      typeof options.deviceStateStore?.runExclusive !== 'function' ||
      typeof options.runtime?.runWithModuleQuiesced !== 'function' ||
      typeof options.authorizeArtifactRemoval !== 'function' ||
      (options.platform !== 'desktop' && options.platform !== 'mobile')
    ) {
      throw new Error('Module uninstall coordinator options are invalid')
    }
  }

  async uninstall(moduleId: string): Promise<void> {
    assertModuleId(moduleId, 'Module id')
    return this.options.runtime.runWithModuleQuiesced(moduleId, () =>
      this.options.deviceStateStore.runExclusive(
        moduleId,
        async (transaction) => {
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
  }
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
