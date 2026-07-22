import {
  type ModuleArtifactDescriptor,
  type ModuleArtifactReadStore,
  type VerifiedModuleArtifact,
  verifyInstalledModuleArtifact,
} from './moduleArtifactVerifier'
import type {
  ModuleDeviceStateStore,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import type { ModuleArtifactPlatform } from './moduleStore'
import { selectInitialCompatibleVersion } from './officialModuleCatalog'
import type {
  ModuleIntentStateSource,
  YoloModuleDefinition,
  YoloModuleEntry,
} from './types'
import type { VerifiedModuleArtifactRegistry } from './verifiedModuleArtifactRegistry'

export type ModuleActivationCoordinatorOptions = Readonly<{
  deviceStateStore: Pick<ModuleDeviceStateStore, 'list' | 'runExclusive'>
  intentStateSource?: Pick<ModuleIntentStateSource, 'load'>
  artifactStore: ModuleArtifactReadStore
  platform: ModuleArtifactPlatform
  hostApi: string
  loader: Readonly<{
    load(
      entry: YoloModuleEntry,
      bytes: Uint8Array,
      signal?: AbortSignal,
    ): Promise<YoloModuleDefinition>
  }>
  runtime: Readonly<{
    activate(
      definition: YoloModuleDefinition,
      version: string,
      signal?: AbortSignal,
    ): Promise<void>
  }>
  activationTimeoutMs?: number
  startupTimeoutMs?: number
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  verifiedArtifactRegistry?: Pick<
    VerifiedModuleArtifactRegistry,
    'publish' | 'clear' | 'clearAll'
  >
  reportActivationError?: (moduleId: string, error: unknown) => void
}>

export type ModuleActivationResult = Readonly<{
  moduleId: string
  status: 'activated' | 'skipped' | 'failed'
  version?: string
  error?: string
}>

const EMPTY_RESULTS = Object.freeze([]) as readonly ModuleActivationResult[]
export const DEFAULT_MODULE_ACTIVATION_TIMEOUT_MS = 30_000

/** Loads each enabled module's exact verified target. Interrupted targets retry. */
export class ModuleActivationCoordinator {
  private readonly errors = new Map<string, string>()
  private readonly controllers = new Set<AbortController>()
  private readonly activationTimeoutMs: number
  private readonly startupTimeoutMs: number
  private activation: Promise<readonly ModuleActivationResult[]> | undefined
  private disposed = false

  constructor(private readonly options: ModuleActivationCoordinatorOptions) {
    if (
      !options ||
      typeof options.deviceStateStore?.list !== 'function' ||
      typeof options.deviceStateStore?.runExclusive !== 'function' ||
      (options.intentStateSource !== undefined &&
        typeof options.intentStateSource.load !== 'function') ||
      !options.artifactStore ||
      (options.platform !== 'desktop' && options.platform !== 'mobile') ||
      typeof options.hostApi !== 'string' ||
      typeof options.loader?.load !== 'function' ||
      typeof options.runtime?.activate !== 'function' ||
      (options.activationTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.activationTimeoutMs) ||
          options.activationTimeoutMs <= 0)) ||
      (options.startupTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.startupTimeoutMs) ||
          options.startupTimeoutMs <= 0)) ||
      (options.verifiedArtifactRegistry !== undefined &&
        (typeof options.verifiedArtifactRegistry.publish !== 'function' ||
          typeof options.verifiedArtifactRegistry.clear !== 'function' ||
          typeof options.verifiedArtifactRegistry.clearAll !== 'function')) ||
      (options.reportActivationError !== undefined &&
        typeof options.reportActivationError !== 'function')
    ) {
      throw new Error('Module activation coordinator options are invalid')
    }
    this.activationTimeoutMs =
      options.activationTimeoutMs ?? DEFAULT_MODULE_ACTIVATION_TIMEOUT_MS
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? this.activationTimeoutMs + 5_000
  }

  activatePersistedModules(): Promise<readonly ModuleActivationResult[]> {
    if (this.disposed) return Promise.reject(disposedError())
    this.activation ??= this.activateAll()
    return this.activation
  }

  getError(moduleId: string): string | undefined {
    return this.errors.get(moduleId)
  }

  activateModule(moduleId: string): Promise<ModuleActivationResult> {
    if (this.disposed) return Promise.reject(disposedError())
    const controller = new AbortController()
    this.controllers.add(controller)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.startupTimeoutMs)
    return this.activateModuleWithSignal(moduleId, controller.signal)
      .catch((error) => {
        if (timedOut) {
          throw new Error(
            `Module "${moduleId}" activation timed out after ${this.startupTimeoutMs} ms`,
          )
        }
        throw error
      })
      .finally(() => {
        clearTimeout(timeout)
        this.controllers.delete(controller)
      })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.options.verifiedArtifactRegistry?.clearAll()
  }

  private async activateAll(): Promise<readonly ModuleActivationResult[]> {
    this.options.verifiedArtifactRegistry?.clearAll()
    const controller = new AbortController()
    this.controllers.add(controller)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.startupTimeoutMs)
    try {
      const states = await withAbort(
        this.options.deviceStateStore.list(),
        controller.signal,
      )
      if (states.length === 0) return EMPTY_RESULTS
      const results = await withAbort(
        Promise.all(
          [...states]
            .sort((left, right) => left.moduleId.localeCompare(right.moduleId))
            .map((state) =>
              this.activateModuleWithSignal(state.moduleId, controller.signal),
            ),
        ),
        controller.signal,
      )
      return Object.freeze(results)
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `Persisted module activation timed out after ${this.startupTimeoutMs} ms`,
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
  }

  private async activateModuleWithSignal(
    moduleId: string,
    signal: AbortSignal,
  ): Promise<ModuleActivationResult> {
    try {
      const intents = await withAbort(
        this.options.intentStateSource?.load([moduleId]) ?? Promise.resolve([]),
        signal,
      )
      const matches = intents.filter((intent) => intent.id === moduleId)
      if (matches.length !== 1 || matches[0]?.state !== 'enabled') {
        this.options.verifiedArtifactRegistry?.clear(moduleId)
        return result({ moduleId, status: 'skipped' })
      }
      return await this.options.deviceStateStore.runExclusive(
        moduleId,
        (transaction) =>
          this.activateTransaction(moduleId, transaction, signal),
      )
    } catch (error) {
      if (signal.aborted) throw error
      return this.failed(moduleId, error)
    }
  }

  private async activateTransaction(
    moduleId: string,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleActivationResult> {
    const state = await withAbort(transaction.read(), signal)
    if (!state) return result({ moduleId, status: 'skipped' })
    if (state.moduleId !== moduleId) {
      throw new Error(`Module "${moduleId}" returned mismatched device state`)
    }
    const descriptor = snapshotDescriptor(
      state.pending?.descriptor ?? state.active,
    )
    if (!descriptor) return result({ moduleId, status: 'skipped' })

    await this.activateDescriptor(descriptor, signal)
    if (state.pending) {
      await transaction.write({
        ...state,
        active: descriptor,
        pending: null,
      })
    }
    this.errors.delete(moduleId)
    return result({
      moduleId,
      status: 'activated',
      version: descriptor.version,
    })
  }

  private async activateDescriptor(
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertCompatible(descriptor)
    const subtleCrypto =
      this.options.subtleCrypto ?? globalThis.crypto?.subtle ?? null
    if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
    const artifact = await withAbort(
      verifyInstalledModuleArtifact(
        this.options.artifactStore,
        descriptor,
        subtleCrypto,
      ),
      signal,
    )
    await this.activateVerifiedArtifact(artifact, descriptor, signal)
  }

  private assertCompatible(descriptor: ModuleArtifactDescriptor): void {
    const selected = selectInitialCompatibleVersion(
      {
        id: descriptor.id,
        versions: [
          {
            version: descriptor.version,
            hostApi: descriptor.hostApi,
            platforms: [descriptor.platform],
            dataSchemas: descriptor.dataSchemas,
            manifestUrl: descriptor.manifestUrl,
            manifest: descriptor.manifest,
          },
        ],
      },
      {
        hostApi: this.options.hostApi,
        platform: this.options.platform,
      },
    )
    if (!selected) {
      throw new Error(
        `Module "${descriptor.id}" version "${descriptor.version}" is incompatible with the current Host API or platform`,
      )
    }
  }

  private async activateVerifiedArtifact(
    artifact: VerifiedModuleArtifact,
    descriptor: ModuleArtifactDescriptor,
    parentSignal: AbortSignal,
  ): Promise<void> {
    this.options.verifiedArtifactRegistry?.clear(descriptor.id)
    const controller = new AbortController()
    this.controllers.add(controller)
    const abortFromParent = () => controller.abort()
    parentSignal.addEventListener('abort', abortFromParent, { once: true })
    if (this.disposed || parentSignal.aborted) controller.abort()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.activationTimeoutMs)
    try {
      const entry = artifact.variant.files.find(
        (file) => file.role === 'entry' && file.path === artifact.variant.entry,
      )
      if (!entry) {
        throw new Error(`Module "${descriptor.id}" selected entry is missing`)
      }
      const definition = await this.options.loader.load(
        { id: descriptor.id, byteSize: entry.byteSize, sha256: entry.sha256 },
        artifact.entryBytes,
        controller.signal,
      )
      await this.options.runtime.activate(
        definition,
        descriptor.version,
        controller.signal,
      )
      if (this.disposed || parentSignal.aborted || controller.signal.aborted) {
        throw new Error(`Module "${descriptor.id}" activation was aborted`)
      }
      this.options.verifiedArtifactRegistry?.publish(
        descriptor.id,
        descriptor.version,
        artifact,
      )
    } catch (error) {
      this.options.verifiedArtifactRegistry?.clear(descriptor.id)
      if (timedOut) {
        throw new Error(
          `Module "${descriptor.id}" activation timed out after ${this.activationTimeoutMs} ms`,
        )
      }
      if (controller.signal.aborted) {
        throw new Error(`Module "${descriptor.id}" activation was aborted`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
      parentSignal.removeEventListener('abort', abortFromParent)
      this.controllers.delete(controller)
    }
  }

  private failed(moduleId: string, error: unknown): ModuleActivationResult {
    const message = errorMessage(error)
    this.errors.set(moduleId, message)
    try {
      this.options.reportActivationError?.(moduleId, error)
    } catch {
      // Diagnostics cannot block activation of the remaining modules.
    }
    return result({ moduleId, status: 'failed', error: message })
  }
}

function result(value: ModuleActivationResult): ModuleActivationResult {
  return Object.freeze({ ...value })
}

function snapshotDescriptor(
  descriptor: ModuleArtifactDescriptor | null,
): ModuleArtifactDescriptor | null {
  if (!descriptor) return null
  return Object.freeze({
    ...descriptor,
    dataSchemas: Object.freeze(
      Object.fromEntries(
        Object.entries(descriptor.dataSchemas).map(([namespace, schema]) => [
          namespace,
          Object.freeze({ ...schema }),
        ]),
      ),
    ),
    manifest: Object.freeze({ ...descriptor.manifest }),
  })
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortedError())
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

function abortedError(): Error {
  return new Error('Module activation was aborted')
}

function disposedError(): Error {
  return new Error('Module activation coordinator is disposed')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
