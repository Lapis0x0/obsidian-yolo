import { ModuleArtifactInstaller } from './moduleArtifactInstaller'
import { ModuleDeviceStateInstalledStateSource } from './moduleDeviceStateInstalledStateSource'
import type { ModuleDeviceStateStore } from './moduleDeviceStateStore'
import {
  type ConfirmedModuleCandidate,
  ModuleInstallationCoordinator,
} from './moduleInstallationCoordinator'
import { ModuleManager } from './moduleManager'
import {
  type ModuleArtifactPlatform,
  type ModuleStore,
  assertModuleId,
} from './moduleStore'
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
  catalogRequest?: OfficialModuleCatalogRequest
  artifactRequest?: OfficialModuleArtifactRequest
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  reportCleanupError?: (error: unknown) => void
  reportRefreshError?: (error: unknown) => void
}>

export type ProductionModuleServices = Readonly<{
  manager: ModuleManager
  coordinator: ModuleInstallationCoordinator
  catalogClient: OfficialModuleCatalogClient
  catalogSource: OfficialModuleCatalogSource
  installer: ModuleArtifactInstaller
  installedStateSource: ModuleDeviceStateInstalledStateSource
  getInstallCandidate(moduleId: string): ConfirmedModuleCandidate | undefined
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
  const installedStateSource = new ModuleDeviceStateInstalledStateSource({
    store: options.deviceStateStore,
    isActive: options.isActive,
  })
  const manager = new ModuleManager({
    catalogSource,
    installedStateSource,
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

  return Object.freeze({
    manager,
    coordinator,
    catalogClient,
    catalogSource,
    installer,
    installedStateSource,
    getInstallCandidate(moduleId: string) {
      assertModuleId(moduleId, 'Module id')
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
      return Object.freeze({
        moduleId,
        expectedVersion: resolved.version,
        expectedManifestSha256: resolved.manifest.sha256,
      })
    },
    dispose: () => {
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
    (options.catalogRequest !== undefined &&
      typeof options.catalogRequest !== 'function') ||
    (options.artifactRequest !== undefined &&
      typeof options.artifactRequest !== 'function') ||
    (options.reportCleanupError !== undefined &&
      typeof options.reportCleanupError !== 'function') ||
    (options.reportRefreshError !== undefined &&
      typeof options.reportRefreshError !== 'function')
  ) {
    throw new TypeError('Production module services options are invalid')
  }
}
