import type { ModuleArtifactInstaller } from './moduleArtifactInstaller'
import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateStore,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import type { ModuleManager } from './moduleManager'
import {
  type ModuleArtifactManifest,
  type ModuleArtifactPlatform,
  assertModuleId,
} from './moduleStore'
import type { OfficialModuleCatalogSource } from './officialModuleCatalogSource'

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export type ConfirmedModuleCandidate = Readonly<{
  moduleId: string
  expectedVersion: string
  expectedManifestSha256: string
}>

export type ModuleInstallationResult = Readonly<{
  descriptor: ModuleArtifactDescriptor
  manifest: ModuleArtifactManifest
  state: ModuleDeviceState
}>

export type ModuleInstallationCoordinatorOptions = Readonly<{
  catalogSource: Pick<
    OfficialModuleCatalogSource,
    'getResolvedArtifactDescriptor'
  >
  installer: Pick<ModuleArtifactInstaller, 'install'>
  deviceStateStore: Pick<ModuleDeviceStateStore, 'runExclusive'>
  manager: Pick<ModuleManager, 'refresh'>
  platform: ModuleArtifactPlatform
  reportRefreshError?: (error: unknown) => void
}>

/** Installs a catalog candidate confirmed by the user without activating it. */
export class ModuleInstallationCoordinator {
  private readonly activeControllers = new Set<AbortController>()
  private disposed = false

  constructor(private readonly options: ModuleInstallationCoordinatorOptions) {
    if (
      !options ||
      typeof options.catalogSource?.getResolvedArtifactDescriptor !==
        'function' ||
      typeof options.installer?.install !== 'function' ||
      typeof options.deviceStateStore?.runExclusive !== 'function' ||
      typeof options.manager?.refresh !== 'function' ||
      (options.platform !== 'desktop' && options.platform !== 'mobile') ||
      (options.reportRefreshError !== undefined &&
        typeof options.reportRefreshError !== 'function')
    ) {
      throw new Error('Module installation coordinator options are invalid')
    }
  }

  async installConfirmedCandidate(
    request: ConfirmedModuleCandidate,
  ): Promise<ModuleInstallationResult> {
    if (this.disposed) {
      throw new Error('Module installation coordinator is disposed')
    }
    const { moduleId, expectedVersion, expectedManifestSha256 } =
      parseRequest(request)
    const controller = new AbortController()
    this.activeControllers.add(controller)
    try {
      return await this.options.deviceStateStore.runExclusive(
        moduleId,
        async (transaction) => {
          this.throwIfUnavailable(controller.signal)
          const existing = await transaction.read()
          if (existing && existing.platform !== this.options.platform) {
            throw new Error(
              `Module "${moduleId}" device state belongs to ${existing.platform}, not ${this.options.platform}`,
            )
          }
          if (existing !== null && existing.transition !== null) {
            throw new Error(
              `Module "${moduleId}" installation is blocked by an active transition`,
            )
          }

          const resolved =
            this.options.catalogSource.getResolvedArtifactDescriptor(
              moduleId,
              expectedVersion,
              this.options.platform,
            )
          if (!resolved) {
            throw new Error(
              `Official module "${moduleId}" candidate "${expectedVersion}" is unavailable`,
            )
          }
          if (resolved.manifest.sha256 !== expectedManifestSha256) {
            throw new Error(
              `Official module "${moduleId}" candidate changed after confirmation`,
            )
          }
          if (
            resolved.id !== moduleId ||
            resolved.version !== expectedVersion ||
            resolved.platform !== this.options.platform
          ) {
            throw new Error(
              `Official module "${moduleId}" returned a mismatched artifact descriptor`,
            )
          }

          const descriptor = snapshotDescriptor(resolved)
          const installedDescriptor = existing?.readyVersions[expectedVersion]
          if (
            installedDescriptor &&
            !descriptorsEqual(installedDescriptor, descriptor)
          ) {
            throw new Error(
              `Module "${moduleId}" version "${expectedVersion}" has a conflicting immutable descriptor`,
            )
          }

          const manifest = snapshotManifest(
            await this.options.installer.install(descriptor, controller.signal),
          )
          this.throwIfUnavailable(controller.signal)
          // The state write is the operation's linearization point. Once commit
          // starts, unload must not turn a durable result into cancellation.
          this.activeControllers.delete(controller)
          const nextState: ModuleDeviceState = {
            moduleId,
            platform: this.options.platform,
            activeVersion: existing?.activeVersion ?? null,
            downloadedCandidate: expectedVersion,
            pendingVersion: existing?.pendingVersion ?? null,
            readyVersions: {
              ...(existing?.readyVersions ?? {}),
              [expectedVersion]: descriptor,
            },
            transition: existing?.transition ?? null,
          }
          const intendedState = snapshotState(nextState)
          let state: ModuleDeviceState
          try {
            state = snapshotState(await transaction.write(intendedState))
          } catch (writeError) {
            const recovered = await this.readCommittedState(
              transaction,
              intendedState,
            )
            if (!recovered) {
              await this.refreshSafely()
              throw writeError
            }
            state = recovered
          }
          await this.refreshSafely()
          return Object.freeze({ descriptor, manifest, state })
        },
      )
    } finally {
      this.activeControllers.delete(controller)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
  }

  private throwIfUnavailable(signal: AbortSignal): void {
    if (this.disposed || signal.aborted) {
      throw new Error('Module installation coordinator is disposed')
    }
  }

  private async readCommittedState(
    transaction: ModuleDeviceStateTransaction,
    intended: ModuleDeviceState,
  ): Promise<ModuleDeviceState | null> {
    try {
      const actual = await transaction.read()
      return actual !== null && statesEqual(actual, intended)
        ? snapshotState(actual)
        : null
    } catch {
      return null
    }
  }

  private async refreshSafely(): Promise<void> {
    try {
      await this.options.manager.refresh()
    } catch (refreshError) {
      try {
        this.options.reportRefreshError?.(refreshError)
      } catch {
        // Diagnostics cannot turn a durable installation into a failure.
      }
    }
  }
}

function statesEqual(
  left: ModuleDeviceState,
  right: ModuleDeviceState,
): boolean {
  if (
    left.moduleId !== right.moduleId ||
    left.platform !== right.platform ||
    left.activeVersion !== right.activeVersion ||
    left.downloadedCandidate !== right.downloadedCandidate ||
    left.pendingVersion !== right.pendingVersion ||
    JSON.stringify(left.transition) !== JSON.stringify(right.transition)
  ) {
    return false
  }
  const leftVersions = Object.keys(left.readyVersions).sort()
  const rightVersions = Object.keys(right.readyVersions).sort()
  return (
    leftVersions.length === rightVersions.length &&
    leftVersions.every(
      (version, index) =>
        version === rightVersions[index] &&
        descriptorsEqual(
          left.readyVersions[version],
          right.readyVersions[version],
        ),
    )
  )
}

function parseRequest(
  request: ConfirmedModuleCandidate,
): ConfirmedModuleCandidate {
  if (!isPlainRecord(request)) {
    throw new TypeError('Confirmed module candidate must be a plain object')
  }
  const keys = Object.getOwnPropertyNames(request)
  if (
    Object.getOwnPropertySymbols(request).length > 0 ||
    keys.length !== 3 ||
    !keys.includes('moduleId') ||
    !keys.includes('expectedVersion') ||
    !keys.includes('expectedManifestSha256')
  ) {
    throw new Error(
      'Confirmed module candidate must contain only moduleId, expectedVersion, and expectedManifestSha256',
    )
  }
  const moduleId = dataProperty(request, 'moduleId')
  const expectedVersion = dataProperty(request, 'expectedVersion')
  const expectedManifestSha256 = dataProperty(request, 'expectedManifestSha256')
  if (typeof moduleId !== 'string') throw new Error('Module id is invalid')
  assertModuleId(moduleId, 'Module id')
  if (typeof expectedVersion !== 'string' || !SEMVER.test(expectedVersion)) {
    throw new Error('Expected module version must be semantic')
  }
  if (
    typeof expectedManifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedManifestSha256)
  ) {
    throw new Error('Expected module manifest SHA-256 is invalid')
  }
  return Object.freeze({
    moduleId,
    expectedVersion,
    expectedManifestSha256,
  })
}

function descriptorsEqual(
  left: ModuleArtifactDescriptor | undefined,
  right: ModuleArtifactDescriptor,
): boolean {
  if (!left) return false
  if (
    left.id !== right.id ||
    left.version !== right.version ||
    left.hostApi !== right.hostApi ||
    left.platform !== right.platform ||
    left.manifestUrl !== right.manifestUrl ||
    left.manifest.byteSize !== right.manifest.byteSize ||
    left.manifest.sha256 !== right.manifest.sha256
  ) {
    return false
  }
  const leftNames = Object.keys(left.dataSchemas).sort()
  const rightNames = Object.keys(right.dataSchemas).sort()
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name, index) => {
      const leftSchema = left.dataSchemas[name]
      const rightSchema = right.dataSchemas[rightNames[index]]
      return (
        name === rightNames[index] &&
        leftSchema.readMin === rightSchema.readMin &&
        leftSchema.readMax === rightSchema.readMax &&
        leftSchema.write === rightSchema.write
      )
    })
  )
}

function snapshotDescriptor(
  descriptor: ModuleArtifactDescriptor,
): ModuleArtifactDescriptor {
  const dataSchemas: Record<
    string,
    Readonly<{ readMin: number; readMax: number; write: number }>
  > = {}
  for (const [name, schema] of Object.entries(descriptor.dataSchemas)) {
    dataSchemas[name] = Object.freeze({ ...schema })
  }
  return Object.freeze({
    id: descriptor.id,
    version: descriptor.version,
    hostApi: descriptor.hostApi,
    dataSchemas: Object.freeze(dataSchemas),
    platform: descriptor.platform,
    manifestUrl: descriptor.manifestUrl,
    manifest: Object.freeze({ ...descriptor.manifest }),
  })
}

function snapshotManifest(
  manifest: ModuleArtifactManifest,
): ModuleArtifactManifest {
  const dataSchemas: Record<
    string,
    Readonly<{ readMin: number; readMax: number; write: number }>
  > = {}
  for (const [name, schema] of Object.entries(manifest.dataSchemas)) {
    dataSchemas[name] = Object.freeze({ ...schema })
  }
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    hostApi: manifest.hostApi,
    dataSchemas: Object.freeze(dataSchemas),
    variants: Object.freeze(
      manifest.variants.map((variant) =>
        Object.freeze({
          platform: variant.platform,
          entry: variant.entry,
          files: Object.freeze(
            variant.files.map((file) => Object.freeze({ ...file })),
          ),
        }),
      ),
    ),
  })
}

function snapshotState(state: ModuleDeviceState): ModuleDeviceState {
  const readyVersions: Record<string, ModuleArtifactDescriptor> = {}
  for (const [version, descriptor] of Object.entries(state.readyVersions)) {
    readyVersions[version] = snapshotDescriptor(descriptor)
  }
  return Object.freeze({
    moduleId: state.moduleId,
    platform: state.platform,
    activeVersion: state.activeVersion,
    downloadedCandidate: state.downloadedCandidate,
    pendingVersion: state.pendingVersion,
    readyVersions: Object.freeze(readyVersions),
    transition: state.transition,
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function dataProperty(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(
      `Property "${name}" must be an enumerable data property`,
    )
  }
  return descriptor.value
}
