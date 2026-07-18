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
import type { ModuleArtifactPlatform } from './moduleStore'
import { selectInitialCompatibleVersion } from './officialModuleCatalog'
import type { YoloModuleDefinition, YoloModuleEntry } from './types'

export type ModuleActivationCoordinatorOptions = Readonly<{
  deviceStateStore: Pick<ModuleDeviceStateStore, 'list' | 'runExclusive'>
  artifactStore: ModuleArtifactReadStore
  platform: ModuleArtifactPlatform
  hostApi: string
  supportedDataNamespaces: readonly string[]
  readCurrentSchemaVersion(
    moduleId: string,
    namespace: string,
  ): Promise<number | null>
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
  reportActivationError?: (moduleId: string, error: unknown) => void
}>

export type ModuleActivationResult = Readonly<{
  moduleId: string
  status: 'activated' | 'skipped' | 'failed'
  version?: string
  recoveredVersion?: string
  error?: string
}>

const EMPTY_RESULTS = Object.freeze([]) as readonly ModuleActivationResult[]
export const DEFAULT_MODULE_ACTIVATION_TIMEOUT_MS = 30_000

/** Activates only locally persisted, ready module versions during startup. */
export class ModuleActivationCoordinator {
  private readonly errors = new Map<string, string>()
  private readonly supportedDataNamespaces: readonly string[]
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
      !options.artifactStore ||
      (options.platform !== 'desktop' && options.platform !== 'mobile') ||
      typeof options.hostApi !== 'string' ||
      !Array.isArray(options.supportedDataNamespaces) ||
      typeof options.readCurrentSchemaVersion !== 'function' ||
      typeof options.loader?.load !== 'function' ||
      typeof options.runtime?.activate !== 'function' ||
      (options.activationTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.activationTimeoutMs) ||
          options.activationTimeoutMs <= 0)) ||
      (options.startupTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.startupTimeoutMs) ||
          options.startupTimeoutMs <= 0)) ||
      (options.reportActivationError !== undefined &&
        typeof options.reportActivationError !== 'function')
    ) {
      throw new Error('Module activation coordinator options are invalid')
    }
    this.supportedDataNamespaces = Object.freeze([
      ...options.supportedDataNamespaces,
    ])
    this.activationTimeoutMs =
      options.activationTimeoutMs ?? DEFAULT_MODULE_ACTIVATION_TIMEOUT_MS
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? this.activationTimeoutMs + 5_000
  }

  activatePersistedModules(): Promise<readonly ModuleActivationResult[]> {
    if (this.disposed) {
      return Promise.reject(
        new Error('Module activation coordinator is disposed'),
      )
    }
    this.activation ??= this.activateAll()
    return this.activation
  }

  getError(moduleId: string): string | undefined {
    return this.errors.get(moduleId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }

  private async activateAll(): Promise<readonly ModuleActivationResult[]> {
    const controller = new AbortController()
    this.controllers.add(controller)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.startupTimeoutMs)
    try {
      const listed = await withAbort(
        this.options.deviceStateStore.list(),
        controller.signal,
      )
      if (listed.length === 0) return EMPTY_RESULTS
      const moduleIds = [...listed]
        .map((state) => state.moduleId)
        .sort((left, right) => left.localeCompare(right))
      const results = await withAbort(
        Promise.all(
          moduleIds.map(async (moduleId): Promise<ModuleActivationResult> => {
            if (this.disposed) {
              const error = new Error(
                'Module activation coordinator is disposed',
              )
              return this.failed(moduleId, error)
            }
            try {
              return await this.options.deviceStateStore.runExclusive(
                moduleId,
                (transaction) =>
                  this.activateTransaction(
                    moduleId,
                    transaction,
                    controller.signal,
                  ),
              )
            } catch (error) {
              return this.failed(moduleId, error)
            }
          }),
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

  private async activateTransaction(
    moduleId: string,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleActivationResult> {
    const current = await withAbort(transaction.read(), signal)
    if (!current) return result({ moduleId, status: 'skipped' })
    if (current.moduleId !== moduleId) {
      throw new Error(`Module "${moduleId}" returned mismatched device state`)
    }
    if (current.transition !== null) {
      throw new Error(
        `Module "${moduleId}" transition recovery is not implemented`,
      )
    }
    const targetVersion = current.pendingVersion ?? current.activeVersion
    if (!targetVersion) return result({ moduleId, status: 'skipped' })
    const descriptor = snapshotDescriptor(current.readyVersions[targetVersion])
    if (
      !descriptor ||
      descriptor.id !== moduleId ||
      descriptor.version !== targetVersion
    ) {
      throw new Error(
        `Module "${moduleId}" has no ready descriptor for "${targetVersion}"`,
      )
    }

    const pending = current.pendingVersion === targetVersion
    if (pending) {
      const transitionError = new Error(
        `Module "${moduleId}" pending activation requires a transition journal`,
      )
      this.report(moduleId, transitionError)
      return this.recoverPendingFailure(
        current,
        targetVersion,
        transitionError,
        transaction,
        signal,
      )
    }

    await this.activateDescriptor(descriptor, signal)
    this.errors.delete(moduleId)
    return result({
      moduleId,
      status: 'activated',
      version: targetVersion,
    })
  }

  private async recoverPendingFailure(
    current: ModuleDeviceState,
    targetVersion: string,
    targetError: unknown,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleActivationResult> {
    let rollbackError: unknown
    const rolledBack = snapshotState({
      ...current,
      pendingVersion: null,
      downloadedCandidate: targetVersion,
    })
    try {
      await withAbort(transaction.write(rolledBack), signal)
    } catch (error) {
      if (!(await this.hasIntendedPointers(transaction, rolledBack, signal))) {
        rollbackError = error
      }
    }

    const oldVersion = current.activeVersion
    if (oldVersion && oldVersion !== targetVersion) {
      try {
        const oldDescriptor = snapshotDescriptor(
          current.readyVersions[oldVersion],
        )
        if (!oldDescriptor || oldDescriptor.id !== current.moduleId) {
          throw new Error(
            `Module "${current.moduleId}" has no ready descriptor for fallback "${oldVersion}"`,
          )
        }
        await this.activateDescriptor(oldDescriptor, signal)
        if (rollbackError) {
          throw combinedError(
            targetError,
            rollbackError,
            'state rollback failed',
          )
        }
        const message = `Pending version "${targetVersion}" was not activated; restored active version "${oldVersion}": ${errorMessage(targetError)}`
        this.errors.set(current.moduleId, message)
        return result({
          moduleId: current.moduleId,
          status: 'activated',
          version: oldVersion,
          recoveredVersion: oldVersion,
          error: message,
        })
      } catch (fallbackError) {
        throw combinedError(
          targetError,
          rollbackError
            ? combinedError(rollbackError, fallbackError, 'fallback failed')
            : fallbackError,
          'pending activation and fallback failed',
        )
      }
    }
    if (rollbackError) {
      throw combinedError(targetError, rollbackError, 'state rollback failed')
    }
    throw targetError
  }

  private async activateDescriptor(
    descriptor: ModuleArtifactDescriptor,
    parentSignal: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const abortFromParent = () => controller.abort()
    parentSignal.addEventListener('abort', abortFromParent, { once: true })
    if (this.disposed || parentSignal.aborted) controller.abort()
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await withAbort(this.assertCompatible(descriptor), controller.signal)
      const subtleCrypto =
        this.options.subtleCrypto ?? globalThis.crypto?.subtle ?? null
      if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
      const artifact = await withAbort(
        verifyInstalledModuleArtifact(
          this.options.artifactStore,
          descriptor,
          subtleCrypto,
        ),
        controller.signal,
      )
      const entry = artifact.variant.files.find(
        (file) => file.role === 'entry' && file.path === artifact.variant.entry,
      )
      if (!entry) {
        throw new Error(`Module "${descriptor.id}" selected entry is missing`)
      }
      timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.activationTimeoutMs)
      const definition = await withAbort(
        this.options.loader.load(
          {
            id: descriptor.id,
            byteSize: entry.byteSize,
            sha256: entry.sha256,
          },
          artifact.entryBytes,
          controller.signal,
        ),
        controller.signal,
      )
      await withAbort(
        this.options.runtime.activate(
          definition,
          descriptor.version,
          controller.signal,
        ),
        controller.signal,
      )
    } catch (error) {
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
      if (timeout !== undefined) clearTimeout(timeout)
      parentSignal.removeEventListener('abort', abortFromParent)
      this.controllers.delete(controller)
    }
  }

  private async assertCompatible(
    descriptor: ModuleArtifactDescriptor,
  ): Promise<void> {
    if (descriptor.platform !== this.options.platform) {
      throw new Error(
        `Module "${descriptor.id}" requires ${descriptor.platform}, not ${this.options.platform}`,
      )
    }
    const currentSchemas: Record<string, number> = {}
    const supported = new Set(this.supportedDataNamespaces)
    for (const namespace of Object.keys(descriptor.dataSchemas).sort()) {
      if (!supported.has(namespace)) {
        throw new Error(
          `Module "${descriptor.id}" data namespace "${namespace}" is unsupported`,
        )
      }
      const current = await this.options.readCurrentSchemaVersion(
        descriptor.id,
        namespace,
      )
      currentSchemas[namespace] = current ?? 0
    }
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
        dataSchemas: currentSchemas,
        supportedDataNamespaces: this.supportedDataNamespaces,
      },
    )
    if (!selected) {
      throw new Error(
        `Module "${descriptor.id}" version "${descriptor.version}" is incompatible with the current Host API, platform, or data schemas`,
      )
    }
    for (const [namespace, current] of Object.entries(currentSchemas)) {
      if (current !== descriptor.dataSchemas[namespace]?.write) {
        throw new Error(
          `Module "${descriptor.id}" data schema "${namespace}" requires a transition journal before activation`,
        )
      }
    }
  }

  private async hasIntendedPointers(
    transaction: ModuleDeviceStateTransaction,
    intended: ModuleDeviceState,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const actual = await withAbort(transaction.read(), signal)
      return actual !== null && equalState(actual, intended)
    } catch {
      return false
    }
  }

  private failed(moduleId: string, error: unknown): ModuleActivationResult {
    const message = errorMessage(error)
    this.errors.set(moduleId, message)
    this.report(moduleId, error)
    return result({ moduleId, status: 'failed', error: message })
  }

  private report(moduleId: string, error: unknown): void {
    try {
      this.options.reportActivationError?.(moduleId, error)
    } catch {
      // Diagnostics cannot block activation of the remaining modules.
    }
  }
}

function result(value: ModuleActivationResult): ModuleActivationResult {
  return Object.freeze({ ...value })
}

function snapshotDescriptor(
  descriptor: ModuleArtifactDescriptor | undefined,
): ModuleArtifactDescriptor | undefined {
  if (!descriptor) return undefined
  const dataSchemas = Object.fromEntries(
    Object.entries(descriptor.dataSchemas).map(([namespace, schema]) => [
      namespace,
      Object.freeze({ ...schema }),
    ]),
  )
  return Object.freeze({
    ...descriptor,
    dataSchemas: Object.freeze(dataSchemas),
    manifest: Object.freeze({ ...descriptor.manifest }),
  })
}

function snapshotState(state: ModuleDeviceState): ModuleDeviceState {
  return Object.freeze({
    ...state,
    readyVersions: Object.freeze({ ...state.readyVersions }),
    transition: state.transition,
  })
}

function equalState(
  left: ModuleDeviceState,
  right: ModuleDeviceState,
): boolean {
  if (
    left.moduleId !== right.moduleId ||
    left.platform !== right.platform ||
    left.activeVersion !== right.activeVersion ||
    left.pendingVersion !== right.pendingVersion ||
    left.downloadedCandidate !== right.downloadedCandidate ||
    JSON.stringify(left.transition) !== JSON.stringify(right.transition)
  ) {
    return false
  }
  const leftVersions = Object.keys(left.readyVersions).sort()
  const rightVersions = Object.keys(right.readyVersions).sort()
  return (
    leftVersions.length === rightVersions.length &&
    leftVersions.every((version, index) => {
      if (rightVersions[index] !== version) return false
      const leftDescriptor = left.readyVersions[version]
      const rightDescriptor = right.readyVersions[version]
      if (!leftDescriptor || !rightDescriptor) return false
      return equalDescriptor(leftDescriptor, rightDescriptor)
    })
  )
}

function equalDescriptor(
  left: ModuleArtifactDescriptor,
  right: ModuleArtifactDescriptor,
): boolean {
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
  const leftNamespaces = Object.keys(left.dataSchemas).sort()
  const rightNamespaces = Object.keys(right.dataSchemas).sort()
  return (
    leftNamespaces.length === rightNamespaces.length &&
    leftNamespaces.every((namespace, index) => {
      if (rightNamespaces[index] !== namespace) return false
      const leftSchema = left.dataSchemas[namespace]
      const rightSchema = right.dataSchemas[namespace]
      return (
        leftSchema?.readMin === rightSchema?.readMin &&
        leftSchema?.readMax === rightSchema?.readMax &&
        leftSchema?.write === rightSchema?.write
      )
    })
  )
}

function combinedError(first: unknown, second: unknown, label: string): Error {
  return new Error(`${label}: ${errorMessage(first)}; ${errorMessage(second)}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
        reject(toError(error))
      },
    )
  })
}

function abortedError(): Error {
  return new Error('Module activation was aborted')
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
