import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateStore,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import {
  type ModuleTransitionJournal,
  type ModuleTransitionPhase,
  hashModuleTransitionSettingsSnapshot,
  verifyModuleTransitionJournalSnapshot,
} from './moduleTransitionJournal'
import type { ObsidianModuleTransitionSettingsBackend } from './obsidianModuleConfigBackend'

export type ModuleStartupTransitionRecoveryOptions<TVerified = unknown> =
  Readonly<{
    deviceStateStore: Pick<ModuleDeviceStateStore, 'runExclusive'>
    settingsBackend?: Pick<
      ObsidianModuleTransitionSettingsBackend,
      'readAtCapturedLocation'
    >
    subtleCrypto: Pick<SubtleCrypto, 'digest'>
    /** Verifies immutable bytes only. This callback must never evaluate module code. */
    verifyArtifact(
      descriptor: ModuleArtifactDescriptor,
      signal: AbortSignal,
    ): Promise<TVerified>
    activateVerifiedArtifact(
      verified: TVerified,
      descriptor: ModuleArtifactDescriptor,
      signal: AbortSignal,
    ): Promise<void>
    /** Test/isolated-realm seam. Production must use the default global token. */
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

type CleanupResult = Readonly<{ error?: string }>
type RealmPoisonState = {
  processPoisoned: boolean
  reloadRequired: boolean
}
type RealmRecoveryGuard = {
  queue: Promise<void>
  poison: RealmPoisonState
  completed: Map<
    string,
    Readonly<{
      journalIdentity: string
      result: ModuleStartupTransitionRecoveryResult
    }>
  >
}

const realmRecoveryGuards = new WeakMap<object, RealmRecoveryGuard>()
const GLOBAL_REALM_POISON_KEY = Symbol.for(
  'obsidian-yolo.module-transition-recovery.realm-poison.v1',
)

/** Internal startup policy for recovering one durable module transition. */
export class ModuleStartupTransitionRecovery<TVerified = unknown> {
  private readonly realmGuard: RealmRecoveryGuard

  constructor(
    private readonly options: ModuleStartupTransitionRecoveryOptions<TVerified>,
  ) {
    if (
      !options ||
      typeof options.deviceStateStore?.runExclusive !== 'function' ||
      typeof options.subtleCrypto?.digest !== 'function' ||
      typeof options.verifyArtifact !== 'function' ||
      typeof options.activateVerifiedArtifact !== 'function' ||
      (options.realmToken !== undefined &&
        (options.realmToken === null ||
          (typeof options.realmToken !== 'object' &&
            typeof options.realmToken !== 'function'))) ||
      (options.settingsBackend !== undefined &&
        typeof options.settingsBackend.readAtCapturedLocation !== 'function')
    ) {
      throw new Error('Module startup transition recovery options are invalid')
    }
    const realmToken = options.realmToken ?? globalThis
    this.realmGuard = getRealmRecoveryGuard(realmToken)
  }

  async recover(
    moduleId: string,
    signal: AbortSignal,
    allowModuleExecution = true,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    const recovery = this.realmGuard.queue.then(() =>
      this.recoverSerial(moduleId, signal, allowModuleExecution),
    )
    this.realmGuard.queue = recovery.then(
      () => undefined,
      () => undefined,
    )
    return recovery
  }

  private async recoverSerial(
    moduleId: string,
    signal: AbortSignal,
    allowModuleExecution: boolean,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    if (this.realmGuard.poison.processPoisoned) {
      return failed(
        moduleId,
        'Module transition recovery requires a fresh process',
        {
          processPoisoned: true,
          reloadRequired: this.realmGuard.poison.reloadRequired,
        },
      )
    }
    if (signal.aborted) return failed(moduleId, abortedError())
    let recovered: ModuleStartupTransitionRecoveryResult
    try {
      recovered = await this.options.deviceStateStore.runExclusive(
        moduleId,
        async (transaction) => {
          try {
            return await this.recoverExclusive(
              moduleId,
              transaction,
              signal,
              allowModuleExecution,
            )
          } catch (error) {
            return failed(
              moduleId,
              error,
              allowModuleExecution
                ? undefined
                : { processPoisoned: false, reloadRequired: true },
            )
          }
        },
      )
    } catch (error) {
      recovered = failed(
        moduleId,
        error,
        allowModuleExecution
          ? undefined
          : { processPoisoned: false, reloadRequired: true },
      )
    }
    if (recovered.processPoisoned) {
      this.realmGuard.poison.processPoisoned = true
      this.realmGuard.poison.reloadRequired = recovered.reloadRequired
    }
    return recovered
  }

  private async recoverExclusive(
    moduleId: string,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
    allowModuleExecution: boolean,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    const current = await abortable(transaction.read(), signal)
    if (current === null || current.transition === null) {
      this.realmGuard.completed.delete(moduleId)
      return result({ moduleId, status: 'skipped' })
    }
    if (current.moduleId !== moduleId) {
      throw new Error(`Module "${moduleId}" returned mismatched device state`)
    }
    const completed = this.realmGuard.completed.get(moduleId)
    if (
      allowModuleExecution &&
      completed?.journalIdentity === transitionIdentity(current.transition)
    ) {
      return completed.result
    }
    this.realmGuard.completed.delete(moduleId)

    const unverifiedJournal = current.transition
    const targetDescriptor =
      current.readyVersions[unverifiedJournal.targetVersion]
    if (targetDescriptor) {
      assertDescriptorIdentity(
        targetDescriptor,
        moduleId,
        unverifiedJournal.targetVersion,
        current.platform,
      )
    }
    const journal = await abortable(
      verifyModuleTransitionJournalSnapshot(
        unverifiedJournal,
        {
          moduleId: current.moduleId,
          platform: current.platform,
          activeVersion: current.activeVersion,
          downloadedCandidate: current.downloadedCandidate,
          pendingVersion: current.pendingVersion,
          readyVersions: Object.keys(current.readyVersions),
          targetDescriptor: targetDescriptor ?? null,
        },
        this.options.subtleCrypto,
      ),
      signal,
    )
    if (!targetDescriptor) {
      throw new Error(
        `Module "${moduleId}" has no ready descriptor for "${journal.targetVersion}"`,
      )
    }

    if (!allowModuleExecution) {
      return this.settleWithoutExecution(current, journal, transaction, signal)
    }

    switch (journal.phase) {
      case 'prepared':
      case 'settings-committed':
        return this.resumeTarget(
          current,
          journal,
          targetDescriptor,
          transaction,
          signal,
        )
      case 'activation-started':
        return this.rollbackInterrupted(current, journal, transaction, signal)
      case 'committed':
        return this.resumeCommitted(
          current,
          journal,
          targetDescriptor,
          transaction,
          signal,
        )
      case 'rollback-completed':
        return this.resumeRollback(current, journal, transaction, signal)
    }
  }

  private async settleWithoutExecution(
    initial: ModuleDeviceState,
    journal: ModuleTransitionJournal,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    let terminal = initial
    try {
      switch (journal.phase) {
        case 'prepared':
          terminal = rollbackPointers(initial)
          break
        case 'settings-committed':
        case 'activation-started':
          await this.assertSettingsCanRollBack(journal, signal)
          terminal = phaseState(initial, 'rollback-completed')
          await writeExact(transaction, terminal, signal)
          break
        case 'committed':
        case 'rollback-completed':
          break
      }
    } catch (error) {
      return failed(initial.moduleId, error, {
        processPoisoned: false,
        reloadRequired: true,
      })
    }

    const cleanup = await cleanupTerminal(transaction, terminal, signal)
    if (cleanup.error !== undefined) {
      return failed(initial.moduleId, cleanup.error, {
        processPoisoned: false,
        reloadRequired: true,
      })
    }
    this.realmGuard.completed.delete(initial.moduleId)
    return result({ moduleId: initial.moduleId, status: 'skipped' })
  }

  private async assertSettingsCanRollBack(
    journal: ModuleTransitionJournal,
    signal: AbortSignal,
  ): Promise<void> {
    if (journal.settings === null) return
    const backend = this.options.settingsBackend
    if (!backend) {
      throw new Error('Transition settings backend is unavailable')
    }
    const snapshot = await abortable(
      backend.readAtCapturedLocation(journal.settings.location),
      signal,
    )
    const actual = await abortable(
      hashModuleTransitionSettingsSnapshot(snapshot, this.options.subtleCrypto),
      signal,
    )
    if (actual !== journal.settings.previousSha256) {
      throw new Error(
        'Transition settings cannot be rolled back without overwriting newer synchronized settings',
      )
    }
  }

  private async resumeTarget(
    initial: ModuleDeviceState,
    journal: ModuleTransitionJournal,
    descriptor: ModuleArtifactDescriptor,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    const verified = await this.verify(descriptor, signal)
    await this.verifySettings(journal, signal)

    let current = initial
    if (journal.phase === 'prepared') {
      current = phaseState(current, 'settings-committed')
      await writeExact(transaction, current, signal)
    }
    current = phaseState(current, 'activation-started')
    await writeExact(transaction, current, signal)
    // The state marker is durable before this final observable conflict check.
    // DataAdapter has no CAS, so an external writer can still race afterward.
    await this.verifySettings(journal, signal)

    try {
      await this.activateTarget(verified, descriptor, signal)
    } catch (error) {
      return failed(
        initial.moduleId,
        error,
        error instanceof ActivationAttemptError
          ? { processPoisoned: true, reloadRequired: true }
          : undefined,
      )
    }

    const committed = phaseState(current, 'committed')
    try {
      await writeExact(transaction, committed, signal)
    } catch (error) {
      return failed(initial.moduleId, error, {
        processPoisoned: true,
        reloadRequired: true,
      })
    }
    const cleanup = await cleanupTerminal(transaction, committed, signal)
    const recovered = result({
      moduleId: initial.moduleId,
      status: 'activated',
      version: journal.targetVersion,
      ...(cleanup.error === undefined ? {} : { error: cleanup.error }),
    })
    this.rememberUncertainCleanup(committed, cleanup, recovered)
    return recovered
  }

  private async rollbackInterrupted(
    initial: ModuleDeviceState,
    journal: ModuleTransitionJournal,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    await this.verifySettings(journal, signal)
    const rolledBack = phaseState(initial, 'rollback-completed')
    await writeExact(transaction, rolledBack, signal)
    const previous = await this.verifyPrevious(rolledBack, journal, signal)
    return this.activatePrevious(
      rolledBack,
      journal,
      transaction,
      signal,
      previous,
    )
  }

  private async resumeCommitted(
    committed: ModuleDeviceState,
    journal: ModuleTransitionJournal,
    descriptor: ModuleArtifactDescriptor,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    await this.verifySettings(journal, signal)
    const verified = await this.verify(descriptor, signal)
    try {
      await this.activateTarget(verified, descriptor, signal)
    } catch (error) {
      return failed(
        committed.moduleId,
        error,
        error instanceof ActivationAttemptError
          ? { processPoisoned: true, reloadRequired: false }
          : undefined,
      )
    }
    const cleanup = await cleanupTerminal(transaction, committed, signal)
    const recovered = result({
      moduleId: committed.moduleId,
      status: 'activated',
      version: journal.targetVersion,
      ...(cleanup.error === undefined ? {} : { error: cleanup.error }),
    })
    this.rememberUncertainCleanup(committed, cleanup, recovered)
    return recovered
  }

  private async resumeRollback(
    rolledBack: ModuleDeviceState,
    journal: ModuleTransitionJournal,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    await this.verifySettings(journal, signal)
    const previous = await this.verifyPrevious(rolledBack, journal, signal)
    return this.activatePrevious(
      rolledBack,
      journal,
      transaction,
      signal,
      previous,
    )
  }

  private async activatePrevious(
    rolledBack: ModuleDeviceState,
    journal: ModuleTransitionJournal,
    transaction: ModuleDeviceStateTransaction,
    signal: AbortSignal,
    previous: Readonly<{
      descriptor: ModuleArtifactDescriptor
      verified: TVerified
    }> | null,
  ): Promise<ModuleStartupTransitionRecoveryResult> {
    const previousVersion = journal.previousActiveVersion
    if (previousVersion === null) {
      const cleanup = await cleanupTerminal(transaction, rolledBack, signal)
      const message =
        cleanup.error ?? 'Transition has no previous active version'
      return failed(rolledBack.moduleId, message)
    }
    if (previous === null) throw new Error('Previous artifact was not verified')
    try {
      await this.activate(previous.verified, previous.descriptor, signal)
    } catch (error) {
      return failed(
        rolledBack.moduleId,
        error,
        error instanceof ActivationAttemptError
          ? { processPoisoned: true, reloadRequired: false }
          : undefined,
      )
    }
    const cleanup = await cleanupTerminal(transaction, rolledBack, signal)
    const recovered = result({
      moduleId: rolledBack.moduleId,
      status: 'activated',
      version: previousVersion,
      recoveredVersion: previousVersion,
      ...(cleanup.error === undefined ? {} : { error: cleanup.error }),
    })
    this.rememberUncertainCleanup(rolledBack, cleanup, recovered)
    return recovered
  }

  private async verifyPrevious(
    state: ModuleDeviceState,
    journal: ModuleTransitionJournal,
    signal: AbortSignal,
  ): Promise<Readonly<{
    descriptor: ModuleArtifactDescriptor
    verified: TVerified
  }> | null> {
    const previousVersion = journal.previousActiveVersion
    if (previousVersion === null) return null
    const descriptor = state.readyVersions[previousVersion]
    if (!descriptor) {
      throw new Error(
        `Module "${state.moduleId}" has no ready descriptor for previous active version "${previousVersion}"`,
      )
    }
    assertDescriptorIdentity(
      descriptor,
      state.moduleId,
      previousVersion,
      state.platform,
    )
    const verified = await this.verify(descriptor, signal)
    return Object.freeze({ descriptor, verified })
  }

  private async verify(
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<TVerified> {
    throwIfAborted(signal)
    return abortable(this.options.verifyArtifact(descriptor, signal), signal)
  }

  private async activate(
    verified: TVerified,
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    try {
      // Once module code is invoked, keep the recovery lock until its promise
      // settles. Abort is advisory; releasing early would let code continue
      // mutating runtime state behind a subsequent recovery operation.
      await this.options.activateVerifiedArtifact(verified, descriptor, signal)
    } catch (error) {
      throw new ActivationAttemptError(error)
    }
  }

  private async activateTarget(
    verified: TVerified,
    descriptor: ModuleArtifactDescriptor,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    try {
      await this.options.activateVerifiedArtifact(verified, descriptor, signal)
    } catch (error) {
      throw new ActivationAttemptError(error)
    }
  }

  private async verifySettings(
    journal: ModuleTransitionJournal,
    signal: AbortSignal,
  ): Promise<void> {
    if (journal.settings === null) return
    if (
      journal.settings.previousSha256 !== journal.settings.expectedPostSha256
    ) {
      throw new Error('Transition changes settings schema or content')
    }
    const backend = this.options.settingsBackend
    if (!backend) {
      throw new Error('Transition settings backend is unavailable')
    }
    const snapshot = await abortable(
      backend.readAtCapturedLocation(journal.settings.location),
      signal,
    )
    const actual = await abortable(
      hashModuleTransitionSettingsSnapshot(snapshot, this.options.subtleCrypto),
      signal,
    )
    if (actual !== journal.settings.expectedPostSha256) {
      throw new Error('Transition current settings SHA-256 mismatch')
    }
  }

  private rememberUncertainCleanup(
    terminal: ModuleDeviceState,
    cleanup: CleanupResult,
    recovered: ModuleStartupTransitionRecoveryResult,
  ): void {
    const journal = terminal.transition
    if (cleanup.error === undefined || journal === null) {
      this.realmGuard.completed.delete(terminal.moduleId)
      return
    }
    this.realmGuard.completed.set(
      terminal.moduleId,
      Object.freeze({
        journalIdentity: transitionIdentity(journal),
        result: recovered,
      }),
    )
  }
}

/** Reads the realm fence before any ordinary module code is scheduled. */
export function getModuleTransitionRealmDisposition(
  realmToken: object = globalThis,
): ModuleTransitionRealmDisposition {
  const poison = getRealmRecoveryGuard(realmToken).poison
  return Object.freeze({
    reloadRequired: poison.reloadRequired,
    processPoisoned: poison.processPoisoned,
  })
}

function phaseState(
  current: ModuleDeviceState,
  phase: ModuleTransitionPhase,
): ModuleDeviceState {
  const currentTransition = current.transition
  if (currentTransition === null) {
    throw new Error('Module transition journal is missing')
  }
  const transition = Object.freeze({
    ...currentTransition,
    phase,
  }) as ModuleTransitionJournal
  const pointers =
    phase === 'committed'
      ? {
          activeVersion: currentTransition.targetVersion,
          downloadedCandidate: null,
          pendingVersion: null,
        }
      : phase === 'rollback-completed'
        ? {
            activeVersion: currentTransition.previousActiveVersion,
            downloadedCandidate: currentTransition.targetVersion,
            pendingVersion: null,
          }
        : {}
  return Object.freeze({ ...current, ...pointers, transition })
}

function rollbackPointers(current: ModuleDeviceState): ModuleDeviceState {
  const transition = current.transition
  if (transition === null || transition.phase !== 'prepared') {
    throw new Error('Only a prepared transition can be directly rolled back')
  }
  return Object.freeze({
    ...current,
    activeVersion: transition.previousActiveVersion,
    downloadedCandidate: transition.targetVersion,
    pendingVersion: null,
  })
}

function assertDescriptorIdentity(
  descriptor: ModuleArtifactDescriptor,
  moduleId: string,
  version: string,
  platform: ModuleDeviceState['platform'],
): void {
  if (
    descriptor.id !== moduleId ||
    descriptor.version !== version ||
    descriptor.platform !== platform
  ) {
    throw new Error(
      `Module "${moduleId}" descriptor identity does not match version "${version}"`,
    )
  }
}

async function writeExact(
  transaction: ModuleDeviceStateTransaction,
  intended: ModuleDeviceState,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  try {
    const written = await transaction.write(intended)
    if (!equalCompleteState(written, intended)) {
      throw new Error('Module transition state write returned divergent state')
    }
  } catch (writeError) {
    let actual: ModuleDeviceState | null
    try {
      actual = await transaction.read()
    } catch (readError) {
      throw new Error(
        `Module transition state write is unresolved: ${errorMessage(writeError)}; readback failed: ${errorMessage(readError)}`,
      )
    }
    if (actual !== null && equalCompleteState(actual, intended)) return
    throw new Error(
      `Module transition state write is unresolved: ${errorMessage(writeError)}; readback diverged`,
    )
  }
}

async function cleanupTerminal(
  transaction: ModuleDeviceStateTransaction,
  terminal: ModuleDeviceState,
  signal: AbortSignal,
): Promise<CleanupResult> {
  const cleaned = Object.freeze({ ...terminal, transition: null })
  try {
    await writeExact(transaction, cleaned, signal)
    return Object.freeze({})
  } catch (error) {
    try {
      const actual = await transaction.read()
      if (actual !== null && equalCompleteState(actual, terminal)) {
        return Object.freeze({
          error: `Transition journal cleanup is unresolved: ${errorMessage(error)}`,
        })
      }
    } catch {
      // The terminal state cannot be confirmed below.
    }
    return Object.freeze({
      error: `Transition journal cleanup is unresolved: ${errorMessage(error)}`,
    })
  }
}

function equalCompleteState(
  left: ModuleDeviceState,
  right: ModuleDeviceState,
): boolean {
  return equalJsonValue(left, right)
}

function transitionIdentity(journal: ModuleTransitionJournal): string {
  return JSON.stringify(journal)
}

function getGlobalRealmPoisonState(): RealmPoisonState {
  const host = globalThis as typeof globalThis & {
    [GLOBAL_REALM_POISON_KEY]?: RealmPoisonState
  }
  const existing = host[GLOBAL_REALM_POISON_KEY]
  if (existing) return existing
  const created: RealmPoisonState = {
    processPoisoned: false,
    reloadRequired: false,
  }
  Object.defineProperty(host, GLOBAL_REALM_POISON_KEY, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  })
  return created
}

function getRealmRecoveryGuard(realmToken: object): RealmRecoveryGuard {
  let guard = realmRecoveryGuards.get(realmToken)
  if (guard) return guard
  guard = {
    queue: Promise.resolve(),
    poison:
      realmToken === globalThis
        ? getGlobalRealmPoisonState()
        : { processPoisoned: false, reloadRequired: false },
    completed: new Map(),
  }
  realmRecoveryGuards.set(realmToken, guard)
  return guard
}

function equalJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false
  }
  if (
    Object.getOwnPropertySymbols(left).length > 0 ||
    Object.getOwnPropertySymbols(right).length > 0
  ) {
    return false
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.getOwnPropertyNames(leftRecord).sort()
  const rightKeys = Object.getOwnPropertyNames(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        equalJsonValue(leftRecord[key], rightRecord[key]),
    )
  )
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
  disposition: Readonly<{
    processPoisoned: boolean
    reloadRequired: boolean
  }> = Object.freeze({ processPoisoned: false, reloadRequired: false }),
): ModuleStartupTransitionRecoveryResult {
  return result({
    moduleId,
    status: 'failed',
    error: errorMessage(error),
    reloadRequired: disposition.reloadRequired,
    processPoisoned: disposition.processPoisoned,
  })
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError()
}

function abortedError(): Error {
  return new Error('Module transition recovery was aborted')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class ActivationAttemptError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error))
    this.name = 'ActivationAttemptError'
  }
}
