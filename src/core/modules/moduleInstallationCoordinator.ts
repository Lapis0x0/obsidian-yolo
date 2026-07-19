import type { ModuleArtifactInstaller } from './moduleArtifactInstaller'
import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateStore,
} from './moduleDeviceStateStore'
import type { ModuleManager } from './moduleManager'
import { schedulePendingModule } from './modulePendingInstallation'
import {
  type ModuleArtifactManifest,
  type ModuleArtifactPlatform,
  assertModuleId,
} from './moduleStore'
import type { OfficialModuleCatalogSource } from './officialModuleCatalogSource'

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

/** Downloads one user-confirmed catalog candidate and schedules it for startup. */
export class ModuleInstallationCoordinator {
  private readonly activeControllers = new Set<AbortController>()
  private disposed = false

  constructor(private readonly options: ModuleInstallationCoordinatorOptions) {}

  async installConfirmedCandidate(
    request: ConfirmedModuleCandidate,
  ): Promise<ModuleInstallationResult> {
    if (this.disposed)
      throw new Error('Module installation coordinator is disposed')
    assertModuleId(request.moduleId, 'Module id')
    const descriptor = this.options.catalogSource.getResolvedArtifactDescriptor(
      request.moduleId,
      request.expectedVersion,
      this.options.platform,
    )
    if (
      !descriptor ||
      descriptor.id !== request.moduleId ||
      descriptor.version !== request.expectedVersion ||
      descriptor.platform !== this.options.platform ||
      descriptor.manifest.sha256 !== request.expectedManifestSha256
    ) {
      throw new Error(
        `Official module "${request.moduleId}" candidate changed after confirmation`,
      )
    }

    const controller = new AbortController()
    this.activeControllers.add(controller)
    try {
      const manifest = await this.options.installer.install(
        descriptor,
        controller.signal,
      )
      if (this.disposed || controller.signal.aborted) {
        throw new Error('Module installation coordinator is disposed')
      }
      this.activeControllers.delete(controller)
      const state = await this.options.deviceStateStore.runExclusive(
        request.moduleId,
        (transaction) =>
          schedulePendingModule(
            transaction,
            request.moduleId,
            this.options.platform,
            descriptor,
          ),
      )
      await this.refreshSafely()
      return Object.freeze({ descriptor, manifest, state })
    } finally {
      this.activeControllers.delete(controller)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
  }

  private async refreshSafely(): Promise<void> {
    try {
      await this.options.manager.refresh()
    } catch (error) {
      this.options.reportRefreshError?.(error)
    }
  }
}
