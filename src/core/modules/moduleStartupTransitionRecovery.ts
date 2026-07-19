import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateStore,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'

export type ModuleStartupTransitionRecoveryOptions<TVerified = unknown> =
  Readonly<{
    deviceStateStore: Pick<ModuleDeviceStateStore, 'runExclusive'>
    readCurrentSchemaVersion(
      moduleId: string,
      namespace: string,
    ): Promise<number | null>
    verifyArtifact(
      descriptor: ModuleArtifactDescriptor,
      signal: AbortSignal,
    ): Promise<TVerified>
    activateVerifiedArtifact(
      verified: TVerified,
      descriptor: ModuleArtifactDescriptor,
      signal: AbortSignal,
    ): Promise<void>
    realmToken?: object
  }>

export type ModuleStartupTransitionRecoveryResult = Readonly<{
  moduleId: string
  status: 'activated' | 'skipped' | 'failed'
  version?: string
  recoveredVersion?: string
  error?: string
  reloadRequired: boolean
  processPoisoned: boolean
}>

export type ModuleTransitionRealmDisposition = Readonly<{
  reloadRequired: boolean
  processPoisoned: boolean
}>

type RealmPoisonState = {
  processPoisoned: boolean
  reloadRequired: boolean
}

type RealmGuard = {
  queue: Promise<void>
  poison: RealmPoisonState
}

const realmGuards = new WeakMap<object, RealmGuard>()
const GLOBAL_REALM_POISON_KEY = Symbol.for(
  'obsidian-yolo.module-activation.realm-poison.v2',
)

/** Owns the durable pending -> activation-started -> active startup protocol. */
export class ModuleStartupTransitionRecovery<TVerified = unknown> {
  private readonly realmGuard: RealmGuard

  constructor(
    private readonly options: ModuleStartupTransitionRecoveryOptions<TVerified>,
  ) {
    const realmToken = options.realmToken ?? globalThis
    this.realmGuard = getRealmGuard(realmToken)
  }

  async recover(
    moduleId: string,
    signal: AbortSignal,
    allowModuleExecution = true,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    const operation = this.realmGuard.queue.then(() =>
      this.recoverSerial(moduleId, signal, allowModuleExecution),
    )
    this.realmGuard.queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async recoverSerial(
    moduleId: string,
    signal: AbortSignal,
    allowModuleExecution: boolean,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    if (this.realmGuard.poison.processPoisoned) {
      return failed(moduleId, 'Module activation requires a fresh process', {
        processPoisoned: true,
        reloadRequired: this.realmGuard.poison.reloadRequired,
      })
    }
    try {
      const recovered = await this.options.deviceStateStore.runExclusive(
        moduleId,
        (transaction) =>
          this.recoverExclusive(
            moduleId,
            transaction,
            signal,
            allowModuleExecution,
          ),
      )
      if (recovered.processPoisoned) {
        this.realmGuard.poison.processPoisoned = true
        this.realmGuard.poison.reloadRequired = recovered.reloadRequired
      }
      return recovered
    } catch (error) {
      return failed(moduleId, error)
    }
  }

  private async recoverExclusive(
    moduleId: string,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
    allowModuleExecution: boolean,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    const current = await abortable(transaction.read(), signal)
    if (current === null || current.pending === null) {
      return result({ moduleId, status: 'skipped' })
    }
    if (current.moduleId !== moduleId) {
      throw new Error(`Module "${moduleId}" pending activation is invalid`)
    }

    if (current.pending.activationStarted) {
      return this.recoverInterrupted(
        current,
        transaction,
        signal,
        allowModuleExecution,
      )
    }
    if (!allowModuleExecution) {
      await writeExact(transaction, clearPending(current), signal)
      return result({ moduleId, status: 'skipped' })
    }

    const target = current.pending.descriptor
    await this.assertCanReadCurrentSchemas(moduleId, target, signal)
    const verified = await abortable(
      this.options.verifyArtifact(target, signal),
      signal,
    )
    const started = Object.freeze({
      ...current,
      pending: Object.freeze({
        descriptor: target,
        activationStarted: true,
      }),
    })
    await writeExact(transaction, started, signal)

    try {
      // Once target code is invoked this realm is never reused for fallback.
      await this.options.activateVerifiedArtifact(verified, target, signal)
      await this.assertWroteSchemas(moduleId, target, signal)
      const committed = Object.freeze({
        ...started,
        active: target,
        pending: null,
      })
      await writeExact(transaction, committed, signal)
      return result({
        moduleId,
        status: 'activated',
        version: target.version,
      })
    } catch (error) {
      let canRestore = false
      let recoveryError: unknown
      try {
        canRestore = await this.canRestorePrevious(started, signal)
        if (canRestore) {
          await writeExact(transaction, clearPending(started), signal)
        }
      } catch (failure) {
        recoveryError = failure
      }
      return failed(
        moduleId,
        recoveryError !== undefined
          ? `Target activation failed and rollback state could not be persisted: ${errorMessage(error)}; ${errorMessage(recoveryError)}`
          : canRestore
            ? error
            : 'Target activation failed and the previous version cannot read the current data schema',
        { processPoisoned: true, reloadRequired: true },
      )
    }
  }

  private async recoverInterrupted(
    current: ModuleDeviceState,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
    allowModuleExecution: boolean,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    const previous = current.active
    if (
      previous === null ||
      !(await this.canRestorePrevious(current, signal))
    ) {
      return failed(
        current.moduleId,
        'Interrupted activation has no compatible previous version',
      )
    }
    const verified = await abortable(
      this.options.verifyArtifact(previous, signal),
      signal,
    )
    if (!allowModuleExecution) {
      await writeExact(transaction, clearPending(current), signal)
      return result({ moduleId: current.moduleId, status: 'skipped' })
    }
    try {
      await this.options.activateVerifiedArtifact(verified, previous, signal)
      await writeExact(transaction, clearPending(current), signal)
    } catch (error) {
      return failed(current.moduleId, error, {
        processPoisoned: true,
        reloadRequired: true,
      })
    }
    return result({
      moduleId: current.moduleId,
      status: 'activated',
      version: previous.version,
      recoveredVersion: previous.version,
    })
  }

  private async canRestorePrevious(
    state: ModuleDeviceState,
    signal: AbortSignal,
  ): Promise<boolean> {
    const previous = state.active
    if (previous === null) return false
    try {
      await this.assertCanReadCurrentSchemas(state.moduleId, previous, signal)
      await abortable(this.options.verifyArtifact(previous, signal), signal)
      return true
    } catch {
      return false
    }
  }

  private async assertCanReadCurrentSchemas(
    moduleId: string,
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<void> {
    for (const [namespace, schema] of Object.entries(descriptor.dataSchemas)) {
      const current = await abortable(
        this.options.readCurrentSchemaVersion(moduleId, namespace),
        signal,
      )
      if (
        current === null ||
        current < schema.readMin ||
        current > schema.readMax
      ) {
        throw new Error(
          `Module "${moduleId}" cannot read current ${namespace} schema ${String(current)}`,
        )
      }
    }
  }

  private async assertWroteSchemas(
    moduleId: string,
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<void> {
    for (const [namespace, schema] of Object.entries(descriptor.dataSchemas)) {
      const current = await abortable(
        this.options.readCurrentSchemaVersion(moduleId, namespace),
        signal,
      )
      if (current !== schema.write) {
        throw new Error(
          `Module "${moduleId}" did not finish ${namespace} schema ${schema.write}; current schema is ${String(current)}`,
        )
      }
    }
  }
}

export function getModuleTransitionRealmDisposition(
  realmToken: object = globalThis,
): ModuleTransitionRealmDisposition {
  const poison = getRealmGuard(realmToken).poison
  return Object.freeze({ ...poison })
}

function clearPending(state: ModuleDeviceState): ModuleDeviceState {
  return Object.freeze({
    ...state,
    pending: null,
  })
}

async function writeExact(
  transaction: ModuleDeviceStateTransaction,
  intended: ModuleDeviceState,
  signal: AbortSignal,
): Promise<void> {
  try {
    const written = await abortable(transaction.write(intended), signal)
    if (JSON.stringify(written) !== JSON.stringify(intended)) {
      throw new Error('Module activation state write returned divergent state')
    }
  } catch (writeError) {
    const actual = await abortable(transaction.read(), signal)
    if (
      actual !== null &&
      JSON.stringify(actual) === JSON.stringify(intended)
    ) {
      return
    }
    throw writeError
  }
}

function getRealmGuard(realmToken: object): RealmGuard {
  let guard = realmGuards.get(realmToken)
  if (guard) return guard
  guard = {
    queue: Promise.resolve(),
    poison:
      realmToken === globalThis
        ? getGlobalPoison()
        : { processPoisoned: false, reloadRequired: false },
  }
  realmGuards.set(realmToken, guard)
  return guard
}

function getGlobalPoison(): RealmPoisonState {
  const host = globalThis as typeof globalThis & {
    [GLOBAL_REALM_POISON_KEY]?: RealmPoisonState
  }
  const existing = host[GLOBAL_REALM_POISON_KEY]
  if (existing) return existing
  const created = { processPoisoned: false, reloadRequired: false }
  Object.defineProperty(host, GLOBAL_REALM_POISON_KEY, { value: created })
  return created
}

function result(
  value: Omit<
    ModuleStartupTransitionRecoveryResult,
    'reloadRequired' | 'processPoisoned'
  > &
    Partial<
      Pick<
        ModuleStartupTransitionRecoveryResult,
        'reloadRequired' | 'processPoisoned'
      >
    >,
): ModuleStartupTransitionRecoveryResult {
  return Object.freeze({
    ...value,
    reloadRequired: value.reloadRequired ?? false,
    processPoisoned: value.processPoisoned ?? false,
  })
}

function failed(
  moduleId: string,
  error: unknown,
  disposition: Pick<
    ModuleStartupTransitionRecoveryResult,
    'reloadRequired' | 'processPoisoned'
  > = { reloadRequired: false, processPoisoned: false },
): ModuleStartupTransitionRecoveryResult {
  return result({
    moduleId,
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
    ...disposition,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new Error('Module activation was aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new Error('Module activation was aborted'))
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
