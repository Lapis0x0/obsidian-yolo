import type {
  ModuleDeviceState,
  ModuleDeviceStateStore,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import type { ModuleManager } from './moduleManager'
import type { ModuleArtifactPlatform } from './moduleStore'
import { assertModuleId } from './moduleStore'
import {
  type ModuleTransitionJournal,
  verifyModuleTransitionJournalSnapshot,
} from './moduleTransitionJournal'
import type { ObsidianModuleTransitionSettingsBackend } from './obsidianModuleConfigBackend'

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export type ConfirmedModuleTransitionCandidate = Readonly<{
  moduleId: string
  expectedVersion: string
  expectedManifestSha256: string
}>

export type ModuleTransitionPreparationResult = Readonly<{
  journal: ModuleTransitionJournal
  state: ModuleDeviceState
}>

export type ModuleTransitionCoordinatorOptions = Readonly<{
  deviceStateStore: Pick<ModuleDeviceStateStore, 'runExclusive'>
  settingsBackend?: Pick<
    ObsidianModuleTransitionSettingsBackend,
    'capture' | 'readAtCapturedLocation'
  >
  readCurrentSchemaVersion(
    moduleId: string,
    namespace: string,
  ): Promise<number | null>
  manager: Pick<ModuleManager, 'refresh'>
  platform: ModuleArtifactPlatform
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  reportRefreshError?: (error: unknown) => void
}>

/** Durably prepares an installed candidate without changing settings or activation. */
export class ModuleTransitionCoordinator {
  private readonly activeControllers = new Set<AbortController>()
  private disposed = false

  constructor(private readonly options: ModuleTransitionCoordinatorOptions) {
    if (
      !options ||
      typeof options.deviceStateStore?.runExclusive !== 'function' ||
      (options.settingsBackend !== undefined &&
        (typeof options.settingsBackend.capture !== 'function' ||
          typeof options.settingsBackend.readAtCapturedLocation !==
            'function')) ||
      typeof options.readCurrentSchemaVersion !== 'function' ||
      typeof options.manager?.refresh !== 'function' ||
      (options.platform !== 'desktop' && options.platform !== 'mobile') ||
      (options.subtleCrypto !== undefined &&
        typeof options.subtleCrypto.digest !== 'function') ||
      (options.reportRefreshError !== undefined &&
        typeof options.reportRefreshError !== 'function')
    ) {
      throw new Error('Module transition coordinator options are invalid')
    }
  }

  async prepareConfirmedCandidate(
    value: ConfirmedModuleTransitionCandidate,
  ): Promise<ModuleTransitionPreparationResult> {
    if (this.disposed) {
      throw new Error('Module transition coordinator is disposed')
    }
    const request = parseRequest(value)
    const controller = new AbortController()
    this.activeControllers.add(controller)
    try {
      return await this.options.deviceStateStore.runExclusive(
        request.moduleId,
        async (transaction) => {
          this.throwIfUnavailable(controller.signal)
          const current = await withAbort(transaction.read(), controller.signal)
          this.throwIfUnavailable(controller.signal)
          if (!current) {
            throw new Error(
              `Module "${request.moduleId}" transition preparation requires existing device state`,
            )
          }
          assertCurrentCandidate(current, request, this.options.platform)

          const descriptor = current.readyVersions[request.expectedVersion]
          const schema = descriptor.dataSchemas.settings
          if (schema) {
            const sourceSchemaVersion = await withAbort(
              this.options.readCurrentSchemaVersion(
                request.moduleId,
                'settings',
              ),
              controller.signal,
            )
            this.throwIfUnavailable(controller.signal)
            if (
              sourceSchemaVersion === null ||
              sourceSchemaVersion < schema.readMin ||
              sourceSchemaVersion > schema.readMax
            ) {
              throw new Error(
                `Module "${request.moduleId}" cannot read settings schema ${String(sourceSchemaVersion)}`,
              )
            }
          }

          const journalValue: ModuleTransitionJournal = {
            phase: 'prepared',
            moduleId: request.moduleId,
            platform: this.options.platform,
            previousActiveVersion: current.activeVersion,
            targetVersion: request.expectedVersion,
            targetManifestSha256: request.expectedManifestSha256,
            settings: null,
          }
          const intendedPointers = {
            activeVersion: current.activeVersion,
            downloadedCandidate: null,
            pendingVersion: request.expectedVersion,
          } as const
          const binding = {
            moduleId: current.moduleId,
            platform: current.platform,
            ...intendedPointers,
            readyVersions: Object.keys(current.readyVersions),
            targetDescriptor: descriptor,
          }
          const subtleCrypto =
            this.options.subtleCrypto ??
            globalThis.crypto?.subtle ??
            UNAVAILABLE_SUBTLE_CRYPTO
          const journal = await withAbort(
            verifyModuleTransitionJournalSnapshot(
              journalValue,
              binding,
              subtleCrypto,
            ),
            controller.signal,
          )
          this.throwIfUnavailable(controller.signal)
          const intended: ModuleDeviceState = {
            ...current,
            downloadedCandidate: null,
            pendingVersion: request.expectedVersion,
            transition: journal,
          }

          // The durable state write is the linearization point. Disposal after
          // this point must allow the write and exact readback to settle.
          this.activeControllers.delete(controller)
          let state: ModuleDeviceState
          try {
            state = await transaction.write(intended)
          } catch (writeError) {
            const recovered = await readBackState(transaction)
            if (!recovered || !equalJson(recovered, intended)) {
              await this.refreshSafely()
              throw writeError
            }
            state = recovered
          }
          await this.refreshSafely()
          return Object.freeze({ journal: state.transition!, state })
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
      throw new Error('Module transition coordinator is disposed')
    }
  }

  private async refreshSafely(): Promise<void> {
    try {
      await this.options.manager.refresh()
    } catch (error) {
      try {
        this.options.reportRefreshError?.(error)
      } catch {
        // Diagnostics cannot turn a durable transition preparation into failure.
      }
    }
  }
}

const UNAVAILABLE_SUBTLE_CRYPTO: Pick<SubtleCrypto, 'digest'> = Object.freeze({
  digest: () => Promise.reject(new Error('Web Crypto SHA-256 is unavailable')),
})

function assertCurrentCandidate(
  current: ModuleDeviceState,
  request: ConfirmedModuleTransitionCandidate,
  platform: ModuleArtifactPlatform,
): void {
  if (current.moduleId !== request.moduleId) {
    throw new Error('Module device state identity is mismatched')
  }
  if (current.platform !== platform) {
    throw new Error(`Module "${request.moduleId}" platform is mismatched`)
  }
  if (current.transition !== null) {
    throw new Error(`Module "${request.moduleId}" already has a transition`)
  }
  if (current.pendingVersion !== null) {
    throw new Error(
      `Module "${request.moduleId}" already has a pending version`,
    )
  }
  if (current.downloadedCandidate !== request.expectedVersion) {
    throw new Error(`Module "${request.moduleId}" candidate is mismatched`)
  }
  if (current.activeVersion === request.expectedVersion) {
    throw new Error('Transition target must differ from the active version')
  }
  const descriptor = current.readyVersions[request.expectedVersion]
  if (
    !descriptor ||
    descriptor.id !== request.moduleId ||
    descriptor.version !== request.expectedVersion ||
    descriptor.platform !== platform ||
    descriptor.manifest.sha256 !== request.expectedManifestSha256
  ) {
    throw new Error(
      `Module "${request.moduleId}" ready descriptor is mismatched`,
    )
  }
}

async function readBackState(
  transaction: ModuleDeviceStateTransaction,
): Promise<ModuleDeviceState | null> {
  try {
    return await transaction.read()
  } catch {
    return null
  }
}

function parseRequest(
  value: ConfirmedModuleTransitionCandidate,
): ConfirmedModuleTransitionCandidate {
  if (!isPlainRecord(value)) {
    throw new TypeError(
      'Confirmed module transition candidate must be a plain object',
    )
  }
  const keys = Object.getOwnPropertyNames(value)
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    keys.length !== 3 ||
    !keys.includes('moduleId') ||
    !keys.includes('expectedVersion') ||
    !keys.includes('expectedManifestSha256')
  ) {
    throw new Error(
      'Confirmed module transition candidate must contain only moduleId, expectedVersion, and expectedManifestSha256',
    )
  }
  const moduleId = dataProperty(value, 'moduleId')
  const expectedVersion = dataProperty(value, 'expectedVersion')
  const expectedManifestSha256 = dataProperty(value, 'expectedManifestSha256')
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

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
    )
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        equalJson(leftRecord[key], rightRecord[key]),
    )
  )
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
      (result) => {
        cleanup()
        resolve(result)
      },
      (error) => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function disposedError(): Error {
  return new Error('Module transition coordinator is disposed')
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
