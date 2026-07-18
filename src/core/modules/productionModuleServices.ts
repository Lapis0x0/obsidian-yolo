import {
  ModuleActivationCoordinator,
  type ModuleActivationCoordinatorOptions,
} from './moduleActivationCoordinator'
import { ModuleArtifactInstaller } from './moduleArtifactInstaller'
import { ModuleDeviceStateInstalledStateSource } from './moduleDeviceStateInstalledStateSource'
import type { ModuleDeviceStateStore } from './moduleDeviceStateStore'
import {
  type ConfirmedModuleCandidate,
  ModuleInstallationCoordinator,
  type ModuleInstallationResult,
} from './moduleInstallationCoordinator'
import { ModuleLoader } from './moduleLoader'
import { ModuleManager } from './moduleManager'
import {
  type ModuleArtifactPlatform,
  type ModuleStore,
  assertModuleId,
} from './moduleStore'
import { ModuleTransitionCoordinator } from './moduleTransitionCoordinator'
import type { ObsidianModuleTransitionSettingsBackend } from './obsidianModuleConfigBackend'
import {
  type OfficialModuleArtifactRequest,
  createOfficialModuleArtifactDownloader,
} from './officialModuleArtifactDownloader'
import {
  type OfficialModuleCatalogCacheAdapter,
  OfficialModuleCatalogClient,
  type OfficialModuleCatalogRequest,
} from './officialModuleCatalogClient'
import {
  OfficialModuleCatalogSource,
  type OfficialModuleCompatibilityProvider,
} from './officialModuleCatalogSource'
import {
  OFFICIAL_MODULE_SETTINGS_DATA_NAMESPACE,
  YOLO_HOST_API_VERSION,
} from './officialModuleCompatibilityProvider'
import { DomBlobModuleScriptExecutor } from './scriptExecutor'

export const OFFICIAL_MODULE_CATALOG_CACHE_PATH =
  'official-module-catalog/catalog-v1.json'
export const OFFICIAL_MODULE_CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1_000
export const OFFICIAL_MODULE_CATALOG_TIMEOUT_MS = 10_000
export const OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS = 30_000

export type ProductionModuleServicesOptions = Readonly<{
  store: ModuleStore
  deviceStateStore: ModuleDeviceStateStore
  catalogCacheAdapter: OfficialModuleCatalogCacheAdapter
  platform: ModuleArtifactPlatform
  getCompatibility: OfficialModuleCompatibilityProvider
  isActive(moduleId: string, version: string): boolean
  activationRuntime: ModuleActivationCoordinatorOptions['runtime']
  activationLoader?: ModuleActivationCoordinatorOptions['loader']
  transitionSettingsBackend: Pick<
    ObsidianModuleTransitionSettingsBackend,
    'capture' | 'readAtCapturedLocation'
  >
  transitionRecoveryRealmToken?: object
  readCurrentSchemaVersion: ModuleActivationCoordinatorOptions['readCurrentSchemaVersion']
  catalogRequest?: OfficialModuleCatalogRequest
  artifactRequest?: OfficialModuleArtifactRequest
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  reportCleanupError?: (error: unknown) => void
  reportRefreshError?: (error: unknown) => void
  reportActivationError?: (moduleId: string, error: unknown) => void
}>

export type ProductionModuleServices = Readonly<{
  manager: ModuleManager
  coordinator: ModuleInstallationCoordinator
  activationCoordinator: ModuleActivationCoordinator
  catalogClient: OfficialModuleCatalogClient
  catalogSource: OfficialModuleCatalogSource
  installer: ModuleArtifactInstaller
  installedStateSource: ModuleDeviceStateInstalledStateSource
  getInstallCandidate(moduleId: string): ConfirmedModuleCandidate | undefined
  getTransitionCandidate(
    moduleId: string,
  ): Promise<ConfirmedModuleCandidate | undefined>
  installConfirmedCandidate(
    candidate: ConfirmedModuleCandidate,
  ): Promise<ModuleInstallationResult>
  prepareConfirmedTransition(candidate: ConfirmedModuleCandidate): Promise<void>
  dispose(): void
}>

/** Composes the production official-module discovery and installation pipeline. */
export function createProductionModuleServices(
  options: ProductionModuleServicesOptions,
): ProductionModuleServices {
  assertOptions(options)

  const catalogClient = new OfficialModuleCatalogClient({
    adapter: options.catalogCacheAdapter,
    cachePath: OFFICIAL_MODULE_CATALOG_CACHE_PATH,
    timeoutMs: OFFICIAL_MODULE_CATALOG_TIMEOUT_MS,
    cacheTtlMs: OFFICIAL_MODULE_CATALOG_CACHE_TTL_MS,
    ...(options.catalogRequest ? { requestUrl: options.catalogRequest } : {}),
  })
  const catalogSource = new OfficialModuleCatalogSource({
    client: catalogClient,
    getCompatibility: async (module) => {
      const compatibility = await options.getCompatibility(module)
      if (compatibility.platform !== options.platform) {
        throw new Error(
          `Official module compatibility platform ${compatibility.platform} does not match ${options.platform}`,
        )
      }
      return compatibility
    },
  })
  const activationLoader =
    options.activationLoader ??
    Object.freeze({
      load: (...args: Parameters<ModuleLoader['load']>) => {
        const loader = new ModuleLoader({
          executor: new DomBlobModuleScriptExecutor(),
          ...(options.subtleCrypto
            ? { subtleCrypto: options.subtleCrypto }
            : {}),
        })
        return loader.load(...args)
      },
    })
  const activationCoordinator = new ModuleActivationCoordinator({
    deviceStateStore: options.deviceStateStore,
    artifactStore: options.store,
    platform: options.platform,
    hostApi: YOLO_HOST_API_VERSION,
    supportedDataNamespaces: [OFFICIAL_MODULE_SETTINGS_DATA_NAMESPACE],
    readCurrentSchemaVersion: options.readCurrentSchemaVersion,
    loader: activationLoader,
    runtime: options.activationRuntime,
    transitionSettingsBackend: options.transitionSettingsBackend,
    ...(options.transitionRecoveryRealmToken
      ? { transitionRecoveryRealmToken: options.transitionRecoveryRealmToken }
      : {}),
    ...(options.subtleCrypto ? { subtleCrypto: options.subtleCrypto } : {}),
    ...(options.reportActivationError
      ? { reportActivationError: options.reportActivationError }
      : {}),
  })
  const installedStateSource = new ModuleDeviceStateInstalledStateSource({
    store: options.deviceStateStore,
    isActive: options.isActive,
    getError: (moduleId) => activationCoordinator.getError(moduleId),
  })
  const manager = new ModuleManager({
    catalogSource,
    installedStateSource,
  })
  const transitionCoordinator = new ModuleTransitionCoordinator({
    deviceStateStore: options.deviceStateStore,
    settingsBackend: options.transitionSettingsBackend,
    manager,
    platform: options.platform,
    ...(options.subtleCrypto ? { subtleCrypto: options.subtleCrypto } : {}),
    ...(options.reportRefreshError
      ? { reportRefreshError: options.reportRefreshError }
      : {}),
  })
  const installer = new ModuleArtifactInstaller({
    adapter: options.store.adapter,
    store: options.store,
    download: createOfficialModuleArtifactDownloader({
      timeoutMs: OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS,
      ...(options.artifactRequest
        ? { requestUrl: options.artifactRequest }
        : {}),
    }),
    ...(options.subtleCrypto ? { subtleCrypto: options.subtleCrypto } : {}),
    ...(options.reportCleanupError
      ? { reportCleanupError: options.reportCleanupError }
      : {}),
  })
  const coordinator = new ModuleInstallationCoordinator({
    catalogSource,
    installer,
    deviceStateStore: options.deviceStateStore,
    manager,
    platform: options.platform,
    ...(options.reportRefreshError
      ? { reportRefreshError: options.reportRefreshError }
      : {}),
  })
  const inFlightModuleIds = new Set<string>()
  const completedCandidates = new Map<string, string>()
  let disposed = false

  return Object.freeze({
    manager,
    coordinator,
    activationCoordinator,
    catalogClient,
    catalogSource,
    installer,
    installedStateSource,
    getInstallCandidate(moduleId: string) {
      assertModuleId(moduleId, 'Module id')
      if (disposed || inFlightModuleIds.has(moduleId)) return undefined
      const snapshot = manager.getSnapshot()
      if (snapshot.status !== 'ready') return undefined
      const displayed = snapshot.modules.find(
        (module) => module.id === moduleId,
      )
      const resolved = catalogSource.getResolvedVersion(moduleId)
      if (
        !resolved ||
        (displayed?.status !== 'available' &&
          displayed?.status !== 'update-available') ||
        displayed.catalog?.version !== resolved.version
      ) {
        return undefined
      }
      const candidateIdentity = `${resolved.version}:${resolved.manifest.sha256}`
      if (completedCandidates.get(moduleId) === candidateIdentity) {
        return undefined
      }
      return Object.freeze({
        moduleId,
        expectedVersion: resolved.version,
        expectedManifestSha256: resolved.manifest.sha256,
      })
    },
    async getTransitionCandidate(moduleId: string) {
      assertModuleId(moduleId, 'Module id')
      if (disposed || inFlightModuleIds.has(moduleId)) return undefined
      const state = await options.deviceStateStore.read(moduleId)
      if (disposed || inFlightModuleIds.has(moduleId)) return undefined
      const version = state?.downloadedCandidate
      const descriptor = version ? state.readyVersions[version] : undefined
      if (
        !state ||
        state.platform !== options.platform ||
        state.transition !== null ||
        state.pendingVersion !== null ||
        state.activeVersion === version ||
        !descriptor ||
        descriptor.id !== moduleId ||
        descriptor.version !== version ||
        descriptor.platform !== options.platform
      ) {
        return undefined
      }
      return Object.freeze({
        moduleId: state.moduleId,
        expectedVersion: descriptor.version,
        expectedManifestSha256: descriptor.manifest.sha256,
      })
    },
    async installConfirmedCandidate(candidate: ConfirmedModuleCandidate) {
      const request = Object.freeze({
        moduleId: candidate.moduleId,
        expectedVersion: candidate.expectedVersion,
        expectedManifestSha256: candidate.expectedManifestSha256,
      })
      assertModuleId(request.moduleId, 'Module id')
      const candidateIdentity = `${request.expectedVersion}:${request.expectedManifestSha256}`
      if (disposed) {
        throw new Error('Production module services are disposed')
      }
      if (completedCandidates.get(request.moduleId) === candidateIdentity) {
        throw new Error(
          `Module candidate is already downloaded: ${request.moduleId}@${request.expectedVersion}`,
        )
      }
      if (inFlightModuleIds.has(request.moduleId)) {
        throw new Error(
          `Module installation is already in progress: ${request.moduleId}`,
        )
      }

      inFlightModuleIds.add(request.moduleId)
      try {
        const result = await coordinator.installConfirmedCandidate(request)
        completedCandidates.set(request.moduleId, candidateIdentity)
        return result
      } finally {
        inFlightModuleIds.delete(request.moduleId)
      }
    },
    async prepareConfirmedTransition(candidate: ConfirmedModuleCandidate) {
      const request = Object.freeze({
        moduleId: candidate.moduleId,
        expectedVersion: candidate.expectedVersion,
        expectedManifestSha256: candidate.expectedManifestSha256,
      })
      assertModuleId(request.moduleId, 'Module id')
      if (disposed) {
        throw new Error('Production module services are disposed')
      }
      if (inFlightModuleIds.has(request.moduleId)) {
        throw new Error(
          `Module operation is already in progress: ${request.moduleId}`,
        )
      }

      inFlightModuleIds.add(request.moduleId)
      try {
        await transitionCoordinator.prepareConfirmedCandidate(request)
      } finally {
        inFlightModuleIds.delete(request.moduleId)
      }
    },
    dispose: () => {
      disposed = true
      transitionCoordinator.dispose()
      activationCoordinator.dispose()
      coordinator.dispose()
      manager.dispose()
    },
  })
}

function assertOptions(options: ProductionModuleServicesOptions): void {
  if (
    !options ||
    !options.store ||
    !options.deviceStateStore ||
    !options.catalogCacheAdapter ||
    (options.platform !== 'desktop' && options.platform !== 'mobile') ||
    typeof options.getCompatibility !== 'function' ||
    typeof options.isActive !== 'function' ||
    typeof options.activationRuntime?.activate !== 'function' ||
    typeof options.transitionSettingsBackend?.capture !== 'function' ||
    typeof options.transitionSettingsBackend?.readAtCapturedLocation !==
      'function' ||
    (options.activationLoader !== undefined &&
      typeof options.activationLoader.load !== 'function') ||
    (options.transitionRecoveryRealmToken !== undefined &&
      (options.transitionRecoveryRealmToken === null ||
        typeof options.transitionRecoveryRealmToken !== 'object')) ||
    typeof options.readCurrentSchemaVersion !== 'function' ||
    (options.catalogRequest !== undefined &&
      typeof options.catalogRequest !== 'function') ||
    (options.artifactRequest !== undefined &&
      typeof options.artifactRequest !== 'function') ||
    (options.reportCleanupError !== undefined &&
      typeof options.reportCleanupError !== 'function') ||
    (options.reportRefreshError !== undefined &&
      typeof options.reportRefreshError !== 'function') ||
    (options.reportActivationError !== undefined &&
      typeof options.reportActivationError !== 'function')
  ) {
    throw new TypeError('Production module services options are invalid')
  }
}
