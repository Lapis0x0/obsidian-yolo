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
import type { ModuleArtifactPlatform, ModuleStore } from './moduleStore'
import { assertModuleId } from './moduleStore'
import type { OfficialModuleCatalogSource } from './officialModuleCatalogSource'

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
  installer: Pick<ModuleArtifactInstaller, 'install'>
  platform: ModuleArtifactPlatform
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
}>

/** Reconciles synchronized intent with exact, device-local ready artifacts. */
export class ModuleReadinessReconciler {
  private readonly controllers = new Set<AbortController>()
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
      (options.platform !== 'desktop' && options.platform !== 'mobile')
    ) {
      throw new Error('Module readiness reconciler options are invalid')
    }
  }

  ensureModuleReady(moduleId: string): Promise<ModuleReadinessResult> {
    assertModuleId(moduleId, 'Module id')
    if (this.disposed) {
      return Promise.reject(
        new Error('Module readiness reconciler is disposed'),
      )
    }
    const controller = new AbortController()
    this.controllers.add(controller)
    return this.options.deviceStateStore
      .runExclusive(moduleId, (transaction) =>
        this.ensureTransaction(moduleId, transaction, controller.signal),
      )
      .finally(() => this.controllers.delete(controller))
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
  }

  private async ensureTransaction(
    moduleId: string,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleReadinessResult> {
    this.throwIfUnavailable(signal)
    const state = await transaction.read()
    this.throwIfUnavailable(signal)
    if (state !== null) {
      validateState(state, moduleId, this.options.platform)
      return this.ensurePersistedState(state, signal)
    }

    const intent = await this.options.intentStore.get(moduleId)
    this.throwIfUnavailable(signal)
    if (!intent?.desiredInstalled) {
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

    const candidate = snapshotDescriptor(descriptor)
    const repaired = await this.ensureDescriptor(candidate, signal, 'initial')
    this.throwIfUnavailable(signal)
    const intended = snapshotState({
      moduleId,
      platform: this.options.platform,
      activeVersion: null,
      downloadedCandidate: candidate.version,
      pendingVersion: null,
      readyVersions: { [candidate.version]: candidate },
      transition: null,
    })
    // Once the durable commit starts, dispose must not report cancellation for
    // an installation that may already have become visible.
    this.controllers.forEach((controller) => {
      if (controller.signal === signal) this.controllers.delete(controller)
    })
    const committed = await writeWithReadback(transaction, intended)
    return readinessResult({
      moduleId,
      status: 'ready',
      versions: [candidate.version],
      repairedVersions: repaired ? [candidate.version] : [],
      installedVersion: committed.downloadedCandidate ?? candidate.version,
    })
  }

  private async ensurePersistedState(
    state: ModuleDeviceState,
    signal: AbortSignal,
  ): Promise<ModuleReadinessResult> {
    const versions = referencedVersions(state)
    const protectedVersions = new Set(
      [state.activeVersion, state.pendingVersion].filter(
        (version): version is string => version !== null,
      ),
    )
    const repairedVersions: string[] = []
    for (const version of versions) {
      const descriptor = state.readyVersions[version]
      if (
        await this.ensureDescriptor(
          descriptor,
          signal,
          protectedVersions.has(version) ? 'protected' : 'candidate',
        )
      ) {
        repairedVersions.push(version)
      }
    }
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
    repairPolicy: 'protected' | 'candidate' | 'initial',
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
      if (repairPolicy === 'protected') {
        throw new Error(
          `Module "${descriptor.id}" version "${descriptor.version}" requires repair; its active or pending artifact was preserved: ${errorMessage(error)}`,
        )
      }
      if (error instanceof ArtifactAccessError) {
        if (repairPolicy === 'candidate') throw error
        // With no durable state, installation is safe if the version is absent.
        // An immutable existing version will be verified again by the installer.
        return this.installDescriptor(descriptor, signal)
      }
      await this.options.artifactStore.removeVersionArtifacts(
        descriptor.id,
        descriptor.version,
      )
      this.throwIfUnavailable(signal)
      return this.installDescriptor(descriptor, signal)
    }
  }

  private async installDescriptor(
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<true> {
    try {
      await this.options.installer.install(
        snapshotDescriptor(descriptor),
        signal,
      )
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
  constructor(operation: string, error: unknown) {
    super(`Module artifact ${operation} failed: ${errorMessage(error)}`)
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
    readReadyMarkerBytes: (...args) =>
      guardArtifactAccess('ready marker read', () =>
        store.readReadyMarkerBytes(...args),
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
  for (const version of referencedVersions(state)) {
    const descriptor = state.readyVersions[version]
    if (
      !descriptor ||
      descriptor.id !== moduleId ||
      descriptor.version !== version ||
      descriptor.platform !== platform
    ) {
      throw new Error(
        `Module "${moduleId}" has no exact ready descriptor for "${version}"`,
      )
    }
  }
}

function referencedVersions(state: ModuleDeviceState): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        [
          state.activeVersion,
          state.pendingVersion,
          state.downloadedCandidate,
        ].filter((version): version is string => version !== null),
      ),
    ].sort(),
  )
}

async function writeWithReadback(
  transaction: ModuleDeviceStateTransaction,
  intended: ModuleDeviceState,
): Promise<ModuleDeviceState> {
  try {
    return snapshotState(await transaction.write(intended))
  } catch (error) {
    try {
      const actual = await transaction.read()
      if (actual !== null && statesEqual(actual, intended))
        return snapshotState(actual)
    } catch {
      // Preserve the original uncertain write failure.
    }
    throw error
  }
}

function snapshotDescriptor(
  descriptor: ModuleArtifactDescriptor,
): ModuleArtifactDescriptor {
  return Object.freeze({
    ...descriptor,
    dataSchemas: Object.freeze(
      Object.fromEntries(
        Object.entries(descriptor.dataSchemas).map(([name, schema]) => [
          name,
          Object.freeze({ ...schema }),
        ]),
      ),
    ),
    manifest: Object.freeze({ ...descriptor.manifest }),
  })
}

function snapshotState(state: ModuleDeviceState): ModuleDeviceState {
  return Object.freeze({
    ...state,
    readyVersions: Object.freeze(
      Object.fromEntries(
        Object.entries(state.readyVersions).map(([version, descriptor]) => [
          version,
          snapshotDescriptor(descriptor),
        ]),
      ),
    ),
    transition: state.transition,
  })
}

function statesEqual(
  left: ModuleDeviceState,
  right: ModuleDeviceState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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
