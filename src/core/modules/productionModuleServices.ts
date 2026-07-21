import {
  ModuleActivationCoordinator,
  type ModuleActivationCoordinatorOptions,
} from './moduleActivationCoordinator'
import {
  ModuleArtifactInstaller,
  type ModuleArtifactInstallerOptions,
} from './moduleArtifactInstaller'
import type { ModuleCatalogLocaleSource } from './moduleCatalogPresentation'
import { ModuleDeviceStateInstalledStateSource } from './moduleDeviceStateInstalledStateSource'
import type { ModuleDeviceStateStore } from './moduleDeviceStateStore'
import {
  type ConfirmedModuleCandidate,
  ModuleInstallationCoordinator,
} from './moduleInstallationCoordinator'
import { SynchronizedModuleIntentStateSource } from './moduleIntentStateSource'
import type { ModuleIntentStore } from './moduleIntentStore'
import { ModuleLoader } from './moduleLoader'
import { ModuleManager, compareModuleVersions } from './moduleManager'
import {
  ModuleReadinessReconciler,
  type ModuleReadinessResult,
} from './moduleReadinessReconciler'
import type { ModuleRuntimeQuiescence } from './moduleRuntimeReservation'
import type { ModuleService } from './moduleService'
import { ModuleStartupReconciler } from './moduleStartupReconciler'
import {
  type ModuleArtifactPlatform,
  type ModuleStore,
  assertModuleId,
} from './moduleStore'
import { ModuleUninstallCoordinator } from './moduleUninstallCoordinator'
import {
  type OfficialModuleArtifactRequest,
  createOfficialModuleArtifactDownloader,
} from './officialModuleArtifactDownloader'
import { authorizeOfficialModuleArtifactRemoval } from './officialModuleArtifactRemovalPolicy'
import {
  type OfficialModuleCatalogCacheAdapter,
  OfficialModuleCatalogClient,
  type OfficialModuleCatalogRequest,
} from './officialModuleCatalogClient'
import {
  OfficialModuleCatalogSource,
  type OfficialModuleCompatibilityProvider,
} from './officialModuleCatalogSource'
import { YOLO_HOST_API_VERSION } from './officialModuleCompatibilityProvider'
import { DomBlobModuleScriptExecutor } from './scriptExecutor'
import type { ModuleRecord } from './types'
import { VerifiedModuleArtifactRegistry } from './verifiedModuleArtifactRegistry'

export const OFFICIAL_MODULE_CATALOG_CACHE_PATH =
  'official-module-catalog/catalog-v1.json'
export const OFFICIAL_MODULE_CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1_000
export const OFFICIAL_MODULE_CATALOG_TIMEOUT_MS = 10_000
export const OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS = 30_000
export const MODULE_QUIESCENCE_TIMEOUT_MS = 30_000

export type ProductionModuleRuntimeReservation = Readonly<{
  isActive(moduleId: string): boolean
  activate: ModuleActivationCoordinatorOptions['runtime']['activate']
  deactivate: ModuleRuntimeQuiescence['deactivate']
  runWithModuleQuiesced: ModuleRuntimeQuiescence['runWithModuleQuiesced']
}>

export type ProductionModuleReadinessReconciler = Readonly<{
  ensureModuleReady(moduleId: string): Promise<ModuleReadinessResult>
  reconcile(
    moduleIds: readonly string[],
  ): Promise<readonly ModuleReadinessResult[]>
  dispose(): void
}>

type ProductionModuleIntentStore = Pick<
  ModuleIntentStore,
  'get' | 'set' | 'listModuleIds' | 'subscribeAll'
>

export type ModuleCatalogResolutionSource = Pick<
  OfficialModuleCatalogSource,
  'load' | 'getResolvedVersion' | 'getResolvedArtifactDescriptor'
>

export type ProductionModuleServicesOptions = Readonly<{
  store: ModuleStore
  deviceStateStore: ModuleDeviceStateStore
  catalogCacheAdapter: OfficialModuleCatalogCacheAdapter
  platform: ModuleArtifactPlatform
  locale: ModuleCatalogLocaleSource
  subscribeLocale?: (listener: () => void) => () => void
  getCompatibility: OfficialModuleCompatibilityProvider
  isActive(moduleId: string, version: string): boolean
  /** Shared reservation owned and disposed by the composition root. */
  runtimeReservation: ProductionModuleRuntimeReservation
  intentStore: ProductionModuleIntentStore
  catalogSource?: ModuleCatalogResolutionSource
  artifactDownloader?: ModuleArtifactInstallerOptions['download']
  authorizeArtifactRemoval?: (
    moduleId: string,
    versions: readonly string[],
  ) => Promise<boolean>
  removeVersionArtifacts?: (moduleId: string, version: string) => Promise<void>
  activationLoader?: ModuleActivationCoordinatorOptions['loader']
  catalogRequest?: OfficialModuleCatalogRequest
  artifactRequest?: OfficialModuleArtifactRequest
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  verifiedArtifactRegistry?: VerifiedModuleArtifactRegistry
  reportCleanupError?: (error: unknown) => void
  reportRefreshError?: (error: unknown) => void
  reportActivationError?: (moduleId: string, error: unknown) => void
  reportStartupError?: (error: unknown, moduleId?: string) => void
}>

export type ProductionModuleServices = ModuleService

export function isInstallCandidateState(
  displayed: ModuleRecord | undefined,
  resolvedVersion: string,
): boolean {
  return Boolean(
    displayed &&
      (displayed.status === 'available' ||
        displayed.status === 'update-available' ||
        (displayed.status === 'disabled' &&
          displayed.installed &&
          compareModuleVersions(displayed.installed.version, resolvedVersion) <
            0)),
  )
}

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
  const catalogSource =
    options.catalogSource ??
    new OfficialModuleCatalogSource({
      client: catalogClient,
      locale: options.locale,
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
  const runtimeReservation = options.runtimeReservation
  const verifiedArtifactRegistry =
    options.verifiedArtifactRegistry ?? new VerifiedModuleArtifactRegistry()
  const intentStateSource = new SynchronizedModuleIntentStateSource({
    store: options.intentStore,
  })
  const activationCoordinator = new ModuleActivationCoordinator({
    deviceStateStore: options.deviceStateStore,
    artifactStore: options.store,
    platform: options.platform,
    hostApi: YOLO_HOST_API_VERSION,
    loader: activationLoader,
    runtime: runtimeReservation,
    intentStateSource,
    verifiedArtifactRegistry,
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
    intentStateSource,
  })
  const installer = new ModuleArtifactInstaller({
    adapter: options.store.adapter,
    store: options.store,
    download:
      options.artifactDownloader ??
      createOfficialModuleArtifactDownloader({
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
  const ownedReadinessReconciler = new ModuleReadinessReconciler({
    deviceStateStore: options.deviceStateStore,
    intentStore: options.intentStore,
    catalogSource,
    artifactStore: options.store,
    installer,
    platform: options.platform,
    ...(options.subtleCrypto ? { subtleCrypto: options.subtleCrypto } : {}),
  })
  const readinessReconciler = createGuardedReadinessReconciler(
    ownedReadinessReconciler,
    runtimeReservation,
  )
  const uninstallCoordinator = new ModuleUninstallCoordinator({
    artifactStore: {
      removeVersionArtifacts:
        options.removeVersionArtifacts ??
        ((moduleId, version) =>
          options.store.removeVersionArtifacts(moduleId, version)),
    },
    deviceStateStore: options.deviceStateStore,
    intentStore: options.intentStore,
    manager,
    runtime: runtimeReservation,
    authorizeArtifactRemoval:
      options.authorizeArtifactRemoval ??
      ((moduleId, versions) =>
        authorizeOfficialModuleArtifactRemoval(
          catalogClient,
          moduleId,
          versions,
          options.platform,
          {
            timeoutMs: OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS,
            ...(options.artifactRequest
              ? { requestUrl: options.artifactRequest }
              : {}),
            ...(options.subtleCrypto
              ? { subtleCrypto: options.subtleCrypto }
              : {}),
          },
        )),
    platform: options.platform,
  })
  const startupIntentStore = options.intentStore
  const startupReconciler = new ModuleStartupReconciler({
    source: {
      async listKnownModuleIds() {
        const catalogEntriesPromise = catalogSource.load().catch((error) => {
          try {
            options.reportStartupError?.(error)
          } catch {
            // Startup diagnostics must not make the optional catalog critical.
          }
          return []
        })
        const [intentModuleIds, deviceStates, catalogEntries] =
          await Promise.all([
            startupIntentStore.listModuleIds(),
            options.deviceStateStore.list(),
            catalogEntriesPromise,
          ])
        return Object.freeze(
          [
            ...new Set([
              ...intentModuleIds,
              ...deviceStates.map((state) => state.moduleId),
              ...catalogEntries.map((entry) => entry.id),
            ]),
          ].sort(),
        )
      },
      subscribe: (listener) => startupIntentStore.subscribeAll(listener),
    },
    intentStore: startupIntentStore,
    readinessReconciler,
    activationCoordinator,
    runtime: runtimeReservation,
    manager,
    scheduleSafeUninstall: (moduleId: string) =>
      uninstallCoordinator.uninstall(moduleId),
    ...(options.reportStartupError
      ? { reportError: options.reportStartupError }
      : {}),
  })
  const inFlightModuleIds = new Set<string>()
  let disposed = false
  const unsubscribeLocale = options.subscribeLocale?.(() => {
    if (disposed) return
    void manager.refresh().catch((error: unknown) => {
      options.reportRefreshError?.(error)
    })
  })

  const runModuleOperation = async <T>(
    moduleId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    assertModuleId(moduleId, 'Module id')
    if (disposed) throw new Error('Production module services are disposed')
    if (inFlightModuleIds.has(moduleId)) {
      throw new Error(`Module operation is already in progress: ${moduleId}`)
    }
    inFlightModuleIds.add(moduleId)
    try {
      return await operation()
    } finally {
      inFlightModuleIds.delete(moduleId)
    }
  }

  const cancelMatchingPendingVersion = async (
    moduleId: string,
    version: string,
  ): Promise<void> => {
    await options.deviceStateStore.runExclusive(
      moduleId,
      async (transaction) => {
        const state = await transaction.read()
        if (state?.pending?.descriptor.version !== version) {
          return
        }
        await transaction.write({
          ...state,
          pending: null,
        })
      },
    )
  }

  const getRunningDescriptor = async (moduleId: string) => {
    const state = await options.deviceStateStore.read(moduleId)
    const descriptors = [state?.pending?.descriptor, state?.active].filter(
      (descriptor): descriptor is NonNullable<typeof descriptor> =>
        descriptor !== null && descriptor !== undefined,
    )
    return (
      descriptors.find((descriptor) =>
        options.isActive(moduleId, descriptor.version),
      ) ?? null
    )
  }

  const deactivateModule = async (
    moduleId: string,
    closeViews: boolean,
  ): Promise<boolean> => {
    if (!(await getRunningDescriptor(moduleId))) return false
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      MODULE_QUIESCENCE_TIMEOUT_MS,
    )
    try {
      await runtimeReservation.deactivate(
        moduleId,
        { closeViews },
        controller.signal,
      )
      verifiedArtifactRegistry.clear(moduleId)
      return true
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Module "${moduleId}" could not safely stop within ${MODULE_QUIESCENCE_TIMEOUT_MS} ms`,
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  const activateInstalledModule = async (moduleId: string): Promise<string> => {
    const result = await activationCoordinator.activateModule(moduleId)
    if (result.status !== 'activated' || !result.version) {
      throw new Error(
        result.error ?? `Module "${moduleId}" could not be activated`,
      )
    }
    return result.version
  }

  return Object.freeze({
    getSnapshot: manager.getSnapshot,
    subscribe: manager.subscribe,
    refresh: () => manager.refresh(),
    getVerifiedArtifact: (moduleId) =>
      verifiedArtifactRegistry.getVerifiedArtifact(moduleId),
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
        !isInstallCandidateState(displayed, resolved.version) ||
        displayed?.catalog?.version !== resolved.version
      ) {
        return undefined
      }
      return Object.freeze({
        moduleId,
        expectedVersion: resolved.version,
        expectedManifestSha256: resolved.manifest.sha256,
      })
    },
    install(candidate: ConfirmedModuleCandidate) {
      return runModuleOperation(candidate.moduleId, async () => {
        const previousIntent = await options.intentStore.get(candidate.moduleId)
        const previousRunning = await getRunningDescriptor(candidate.moduleId)
        const result = await coordinator.installConfirmedCandidate(candidate)
        try {
          await options.intentStore.set(candidate.moduleId, 'enabled')
        } catch (intentError) {
          try {
            await cancelMatchingPendingVersion(
              candidate.moduleId,
              candidate.expectedVersion,
            )
          } catch (rollbackError) {
            options.reportCleanupError?.(rollbackError)
          }
          try {
            await manager.refresh()
          } catch (refreshError) {
            options.reportRefreshError?.(refreshError)
          }
          throw intentError
        }
        const preparedVersion =
          result.state.pending?.descriptor.version ?? candidate.expectedVersion
        if (previousRunning) {
          try {
            await deactivateModule(candidate.moduleId, false)
          } catch (error) {
            await cancelMatchingPendingVersion(
              candidate.moduleId,
              preparedVersion,
            )
            await options.intentStore.set(
              candidate.moduleId,
              previousIntent ?? 'uninstalled',
            )
            await manager.refresh()
            throw error
          }
        }
        try {
          const version = await activateInstalledModule(candidate.moduleId)
          await manager.refresh()
          return Object.freeze({ version })
        } catch (activationError) {
          await options.intentStore.set(
            candidate.moduleId,
            previousIntent ?? 'uninstalled',
          )
          if (previousRunning) {
            await cancelMatchingPendingVersion(
              candidate.moduleId,
              preparedVersion,
            )
            try {
              await activateInstalledModule(candidate.moduleId)
            } catch (rollbackError) {
              throw new Error(
                `Module "${candidate.moduleId}" update failed and its previous version could not be restored: ${errorMessage(activationError)}; rollback: ${errorMessage(rollbackError)}`,
              )
            }
          }
          await manager.refresh()
          throw activationError
        }
      })
    },
    setEnabled(moduleId: string, enabled: boolean) {
      return runModuleOperation(moduleId, async () => {
        const current = await options.intentStore.get(moduleId)
        if (current === undefined || current === 'uninstalled') {
          throw new Error(`Module "${moduleId}" is not installed`)
        }
        await options.intentStore.set(
          moduleId,
          enabled ? 'enabled' : 'disabled',
        )
        try {
          if (enabled) await activateInstalledModule(moduleId)
          else await deactivateModule(moduleId, true)
        } catch (error) {
          await options.intentStore.set(moduleId, current)
          await manager.refresh()
          throw error
        }
        await manager.refresh()
        return Object.freeze({})
      })
    },
    uninstall(moduleId: string) {
      return runModuleOperation(moduleId, async () => {
        const current = await options.intentStore.get(moduleId)
        if (current === undefined || current === 'uninstalled') {
          throw new Error(`Module "${moduleId}" is not installed`)
        }
        await options.intentStore.set(moduleId, 'uninstalled')
        try {
          await deactivateModule(moduleId, true)
        } catch (error) {
          await options.intentStore.set(moduleId, current)
          await manager.refresh()
          throw error
        }
        await uninstallCoordinator.uninstall(moduleId)
        return Object.freeze({})
      })
    },
    async start() {
      let startupError: unknown
      try {
        await startupReconciler.start()
      } catch (error) {
        startupError = error
      }
      try {
        await manager.refresh()
      } catch (refreshError) {
        if (startupError === undefined) throw refreshError
        options.reportRefreshError?.(refreshError)
      }
      if (startupError !== undefined) {
        throw startupError instanceof Error
          ? startupError
          : new Error(
              typeof startupError === 'string'
                ? startupError
                : 'Module startup failed',
            )
      }
    },
    dispose: () => {
      disposed = true
      unsubscribeLocale?.()
      startupReconciler.dispose()
      readinessReconciler.dispose()
      activationCoordinator.dispose()
      verifiedArtifactRegistry.clearAll()
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
    typeof options.runtimeReservation?.isActive !== 'function' ||
    typeof options.runtimeReservation?.activate !== 'function' ||
    typeof options.runtimeReservation?.deactivate !== 'function' ||
    typeof options.runtimeReservation?.runWithModuleQuiesced !== 'function' ||
    typeof options.intentStore?.get !== 'function' ||
    typeof options.intentStore?.set !== 'function' ||
    typeof options.intentStore?.listModuleIds !== 'function' ||
    typeof options.intentStore?.subscribeAll !== 'function' ||
    (options.activationLoader !== undefined &&
      typeof options.activationLoader.load !== 'function') ||
    (options.verifiedArtifactRegistry !== undefined &&
      !(
        options.verifiedArtifactRegistry instanceof
        VerifiedModuleArtifactRegistry
      )) ||
    (options.catalogRequest !== undefined &&
      typeof options.catalogRequest !== 'function') ||
    (options.artifactRequest !== undefined &&
      typeof options.artifactRequest !== 'function') ||
    (options.subscribeLocale !== undefined &&
      typeof options.subscribeLocale !== 'function') ||
    (options.reportCleanupError !== undefined &&
      typeof options.reportCleanupError !== 'function') ||
    (options.reportRefreshError !== undefined &&
      typeof options.reportRefreshError !== 'function') ||
    (options.reportActivationError !== undefined &&
      typeof options.reportActivationError !== 'function') ||
    (options.reportStartupError !== undefined &&
      typeof options.reportStartupError !== 'function')
  ) {
    throw new TypeError('Production module services options are invalid')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createGuardedReadinessReconciler(
  reconciler: ModuleReadinessReconciler,
  runtime: ProductionModuleRuntimeReservation,
): ProductionModuleReadinessReconciler {
  let disposed = false
  const ensureModuleReady = (moduleId: string) =>
    runtime.runWithModuleQuiesced(moduleId, () =>
      reconciler.ensureModuleReady(moduleId),
    )

  return Object.freeze({
    ensureModuleReady,
    async reconcile(moduleIds: readonly string[]) {
      if (!Array.isArray(moduleIds)) {
        throw new TypeError('Module readiness ids must be an array')
      }
      const ids = [...new Set(moduleIds)]
      for (const moduleId of ids) assertModuleId(moduleId, 'Module id')
      if (disposed) {
        throw new Error('Module readiness reconciler is disposed')
      }
      return Object.freeze(
        await Promise.all(
          ids.sort().map(async (moduleId) => {
            try {
              return await ensureModuleReady(moduleId)
            } catch (error) {
              return Object.freeze({
                moduleId,
                status: 'failed' as const,
                versions: Object.freeze([]),
                repairedVersions: Object.freeze([]),
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }),
        ),
      )
    },
    dispose: () => {
      disposed = true
      reconciler.dispose()
    },
  })
}
