import type { ModuleArtifactArrivalGrace } from './moduleArtifactArrivalGrace'
import type { ModuleArtifactInstaller } from './moduleArtifactInstaller'
import {
  type ModuleArtifactDescriptor,
  type ModuleArtifactReadStore,
  verifyInstalledModuleArtifact,
} from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateStore,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import type { ModuleIntentStore } from './moduleIntentStore'
import { schedulePendingModule } from './modulePendingInstallation'
import type { ModuleArtifactPlatform, ModuleStore } from './moduleStore'
import { ModuleArtifactMissingError, assertModuleId } from './moduleStore'
import type { OfficialModuleCatalogSource } from './officialModuleCatalogSource'

const MODULE_READINESS_SUPERSEDED = Object.freeze({
  kind: 'module-readiness-superseded',
})

export type ModuleReadinessResult = Readonly<{
  moduleId: string
  status: 'ready' | 'skipped' | 'failed'
  versions: readonly string[]
  repairedVersions: readonly string[]
  installedVersion?: string
  error?: string
}>

export type ModuleReadinessReconcilerOptions = Readonly<{
  deviceStateStore: Pick<ModuleDeviceStateStore, 'runExclusive'>
  intentStore: Pick<ModuleIntentStore, 'get'>
  catalogSource: Pick<
    OfficialModuleCatalogSource,
    'getResolvedVersion' | 'getResolvedArtifactDescriptor'
  >
  artifactStore: ModuleArtifactReadStore &
    Pick<ModuleStore, 'removeVersionArtifacts'>
  installer: Pick<ModuleArtifactInstaller, 'install' | 'repair'>
  artifactArrivalGrace?: Pick<ModuleArtifactArrivalGrace, 'waitForArtifact'>
  platform: ModuleArtifactPlatform
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
}>

/** Reconciles synchronized intent with exact, device-local ready artifacts. */
export class ModuleReadinessReconciler {
  private readonly controllers = new Set<AbortController>()
  private readonly graceControllers = new Map<string, AbortController>()
  private disposed = false

  constructor(private readonly options: ModuleReadinessReconcilerOptions) {
    if (
      !options ||
      typeof options.deviceStateStore?.runExclusive !== 'function' ||
      typeof options.intentStore?.get !== 'function' ||
      typeof options.catalogSource?.getResolvedVersion !== 'function' ||
      typeof options.catalogSource?.getResolvedArtifactDescriptor !==
        'function' ||
      !options.artifactStore ||
      typeof options.artifactStore.removeVersionArtifacts !== 'function' ||
      typeof options.installer?.install !== 'function' ||
      typeof options.installer?.repair !== 'function' ||
      (options.artifactArrivalGrace !== undefined &&
        typeof options.artifactArrivalGrace.waitForArtifact !== 'function') ||
      (options.platform !== 'desktop' && options.platform !== 'mobile')
    ) {
      throw new Error('Module readiness reconciler options are invalid')
    }
  }

  ensureModuleReady(
    moduleId: string,
    options: Readonly<{ waitForSynchronizedArtifact?: boolean }> = {},
  ): Promise<ModuleReadinessResult> {
    assertModuleId(moduleId, 'Module id')
    if (this.disposed) {
      return Promise.reject(
        new Error('Module readiness reconciler is disposed'),
      )
    }
    const waitForSynchronizedArtifact =
      options.waitForSynchronizedArtifact === true
    if (!waitForSynchronizedArtifact) {
      this.graceControllers.get(moduleId)?.abort(MODULE_READINESS_SUPERSEDED)
    }
    const controller = new AbortController()
    this.controllers.add(controller)
    if (waitForSynchronizedArtifact) {
      this.graceControllers.get(moduleId)?.abort(MODULE_READINESS_SUPERSEDED)
      this.graceControllers.set(moduleId, controller)
    }
    return this.options.deviceStateStore
      .runExclusive(moduleId, (transaction) =>
        this.ensureTransaction(
          moduleId,
          transaction,
          controller.signal,
          waitForSynchronizedArtifact,
        ),
      )
      .finally(() => {
        this.controllers.delete(controller)
        if (this.graceControllers.get(moduleId) === controller) {
          this.graceControllers.delete(moduleId)
        }
      })
  }

  async reconcile(
    moduleIds: readonly string[],
  ): Promise<readonly ModuleReadinessResult[]> {
    if (!Array.isArray(moduleIds)) {
      throw new TypeError('Module readiness ids must be an array')
    }
    const ids = [...new Set(moduleIds)]
    for (const moduleId of ids) assertModuleId(moduleId, 'Module id')
    if (this.disposed) {
      throw new Error('Module readiness reconciler is disposed')
    }
    return Object.freeze(
      await Promise.all(
        ids.sort().map(async (moduleId) => {
          try {
            return await this.ensureModuleReady(moduleId)
          } catch (error) {
            return readinessResult({
              moduleId,
              status: 'failed',
              versions: [],
              repairedVersions: [],
              error: errorMessage(error),
            })
          }
        }),
      ),
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.graceControllers.clear()
  }

  private async ensureTransaction(
    moduleId: string,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
    waitForSynchronizedArtifact: boolean,
  ): Promise<ModuleReadinessResult> {
    this.throwIfUnavailable(signal)
    const state = await transaction.read()
    this.throwIfUnavailable(signal)
    if (state !== null) {
      validateState(state, moduleId, this.options.platform)
      return this.ensurePersistedState(state, transaction, signal)
    }

    const intent = await this.options.intentStore.get(moduleId)
    this.throwIfUnavailable(signal)
    if (intent === undefined || intent === 'uninstalled') {
      return readinessResult({
        moduleId,
        status: 'skipped',
        versions: [],
        repairedVersions: [],
      })
    }

    const resolved = this.options.catalogSource.getResolvedVersion(moduleId)
    if (!resolved) {
      throw new Error(
        `Official module "${moduleId}" has no resolved installation candidate`,
      )
    }
    const descriptor = this.options.catalogSource.getResolvedArtifactDescriptor(
      moduleId,
      resolved.version,
      this.options.platform,
    )
    if (
      !descriptor ||
      descriptor.id !== moduleId ||
      descriptor.version !== resolved.version ||
      descriptor.platform !== this.options.platform ||
      descriptor.manifest.sha256 !== resolved.manifest.sha256
    ) {
      throw new Error(
        `Official module "${moduleId}" returned a mismatched resolved descriptor`,
      )
    }

    const synchronizedArtifactReady =
      waitForSynchronizedArtifact && this.options.artifactArrivalGrace
        ? await this.options.artifactArrivalGrace.waitForArtifact(
            descriptor.id,
            descriptor.version,
            () => this.isDescriptorReady(descriptor, signal),
            signal,
          )
        : false
    if (signal.aborted && signal.reason === MODULE_READINESS_SUPERSEDED) {
      return readinessResult({
        moduleId,
        status: 'skipped',
        versions: [],
        repairedVersions: [],
      })
    }
    this.throwIfUnavailable(signal)
    if (!synchronizedArtifactReady) {
      await this.installDescriptor(descriptor, signal)
    }
    this.throwIfUnavailable(signal)
    // Once the durable commit starts, dispose must not report cancellation for
    // an installation that may already have become visible.
    this.controllers.forEach((controller) => {
      if (controller.signal === signal) this.controllers.delete(controller)
    })
    const committed = await schedulePendingModule(
      transaction,
      moduleId,
      this.options.platform,
      descriptor,
    )
    return readinessResult({
      moduleId,
      status: 'ready',
      versions: [descriptor.version],
      repairedVersions: [descriptor.version],
      installedVersion:
        committed.pending?.descriptor.version ?? descriptor.version,
    })
  }

  private async ensurePersistedState(
    state: ModuleDeviceState,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleReadinessResult> {
    const selected = state.pending?.descriptor ?? state.active
    const resolved = this.options.catalogSource.getResolvedVersion(
      state.moduleId,
    )
    if (selected && resolved?.version === selected.version) {
      const current = this.options.catalogSource.getResolvedArtifactDescriptor(
        state.moduleId,
        resolved.version,
        this.options.platform,
      )
      if (current && current.manifest.sha256 !== selected.manifest.sha256) {
        const repaired = await this.ensureDescriptor(current, signal)
        await transaction.write({
          ...state,
          pending: { descriptor: current },
        })
        return readinessResult({
          moduleId: state.moduleId,
          status: 'ready',
          versions: [current.version],
          repairedVersions: repaired ? [current.version] : [],
          installedVersion: current.version,
        })
      }
    }
    const descriptors = referencedDescriptors(state)
    const repairedVersions: string[] = []
    for (const descriptor of descriptors) {
      if (await this.ensureDescriptor(descriptor, signal)) {
        repairedVersions.push(descriptor.version)
      }
    }
    const versions = descriptors.map((descriptor) => descriptor.version)
    return readinessResult({
      moduleId: state.moduleId,
      status: versions.length === 0 ? 'skipped' : 'ready',
      versions,
      repairedVersions,
    })
  }

  private async ensureDescriptor(
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.throwIfUnavailable(signal)
    const subtleCrypto =
      this.options.subtleCrypto ?? globalThis.crypto?.subtle ?? null
    if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
    try {
      await withAbort(
        verifyInstalledModuleArtifact(
          guardArtifactReads(this.options.artifactStore),
          descriptor,
          guardArtifactCrypto(subtleCrypto),
        ),
        signal,
      )
      return false
    } catch (error) {
      if (signal.aborted || this.disposed) throw disposedError()
      if (error instanceof ArtifactAccessError) {
        if (error.accessCause instanceof ModuleArtifactMissingError) {
          return this.installDescriptor(descriptor, signal)
        }
        throw error
      }
      return this.repairDescriptor(descriptor, signal)
    }
  }

  private async isDescriptorReady(
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.throwIfUnavailable(signal)
    const subtleCrypto =
      this.options.subtleCrypto ?? globalThis.crypto?.subtle ?? null
    if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
    try {
      await withAbort(
        verifyInstalledModuleArtifact(
          this.options.artifactStore,
          descriptor,
          guardArtifactCrypto(subtleCrypto),
        ),
        signal,
      )
      return true
    } catch {
      if (signal.aborted || this.disposed) throw disposedError()
      return false
    }
  }

  private async installDescriptor(
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<true> {
    try {
      await this.options.installer.install(descriptor, signal)
    } catch (error) {
      if (signal.aborted || this.disposed) throw disposedError()
      throw error
    }
    this.throwIfUnavailable(signal)
    return true
  }

  private async repairDescriptor(
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<true> {
    try {
      await this.options.installer.repair(descriptor, signal)
    } catch (error) {
      if (signal.aborted || this.disposed) throw disposedError()
      throw error
    }
    this.throwIfUnavailable(signal)
    return true
  }

  private throwIfUnavailable(signal: AbortSignal): void {
    if (this.disposed || signal.aborted) throw disposedError()
  }
}

class ArtifactAccessError extends Error {
  constructor(
    operation: string,
    readonly accessCause: unknown,
  ) {
    super(`Module artifact ${operation} failed: ${errorMessage(accessCause)}`)
    this.name = 'ArtifactAccessError'
  }
}

function guardArtifactReads(
  store: ModuleArtifactReadStore,
): ModuleArtifactReadStore {
  return {
    readManifestBytes: (...args) =>
      guardArtifactAccess('manifest read', () =>
        store.readManifestBytes(...args),
      ),
    readEntryBytes: (...args) =>
      guardArtifactAccess('entry read', () => store.readEntryBytes(...args)),
    listVersionFiles: (...args) =>
      guardArtifactAccess('file listing', () =>
        store.listVersionFiles(...args),
      ),
  }
}

function guardArtifactCrypto(
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Pick<SubtleCrypto, 'digest'> {
  return {
    digest: (algorithm, data) =>
      guardArtifactAccess('SHA-256 digest', () =>
        subtleCrypto.digest(algorithm, data),
      ),
  }
}

async function guardArtifactAccess<T>(
  operation: string,
  access: () => Promise<T>,
): Promise<T> {
  try {
    return await access()
  } catch (error) {
    throw new ArtifactAccessError(operation, error)
  }
}

function validateState(
  state: ModuleDeviceState,
  moduleId: string,
  platform: ModuleArtifactPlatform,
): void {
  if (state.moduleId !== moduleId) {
    throw new Error(`Module "${moduleId}" returned mismatched device state`)
  }
  if (state.platform !== platform) {
    throw new Error(
      `Module "${moduleId}" device state belongs to ${state.platform}, not ${platform}`,
    )
  }
  for (const descriptor of referencedDescriptors(state)) {
    if (descriptor.id !== moduleId || descriptor.platform !== platform) {
      throw new Error(`Module "${moduleId}" has a mismatched ready descriptor`)
    }
  }
}

function referencedDescriptors(
  state: ModuleDeviceState,
): readonly ModuleArtifactDescriptor[] {
  const descriptors = [state.active, state.pending?.descriptor].filter(
    (descriptor): descriptor is ModuleArtifactDescriptor =>
      descriptor !== null && descriptor !== undefined,
  )
  return descriptors.filter(
    (descriptor, index) =>
      descriptors.findIndex((other) => other.version === descriptor.version) ===
      index,
  )
}

function readinessResult(value: ModuleReadinessResult): ModuleReadinessResult {
  return Object.freeze({
    ...value,
    versions: Object.freeze([...value.versions]),
    repairedVersions: Object.freeze([...value.repairedVersions]),
  })
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(disposedError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(disposedError())
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function disposedError(): Error {
  return new Error('Module readiness reconciler is disposed')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
