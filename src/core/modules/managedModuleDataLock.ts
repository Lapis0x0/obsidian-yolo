import { assertModuleId } from './moduleStore'

export type ManagedModuleDataVaultIdentity = object

type QueueEntry<T> = {
  readonly operation: () => T | PromiseLike<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason: unknown) => void
  readonly onStart?: () => void
  started: boolean
  cancelled: boolean
}

type LockState = {
  running: boolean
  readonly queue: QueueEntry<unknown>[]
}

const locksByVault = new WeakMap<
  ManagedModuleDataVaultIdentity,
  Map<string, LockState>
>()

const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const MAX_NAMESPACE_LENGTH = 64
const MAX_LOCK_NAMESPACE_LENGTH = 256

export class ManagedModuleDataLockDisposedError extends Error {
  constructor() {
    super(
      'Managed module data lock owner was disposed before the operation ran',
    )
    this.name = 'ManagedModuleDataLockDisposedError'
  }
}

export function assertManagedModuleDataNamespace(namespace: string): void {
  if (
    typeof namespace !== 'string' ||
    namespace.length > MAX_NAMESPACE_LENGTH ||
    !NAMESPACE_PATTERN.test(namespace)
  ) {
    throw new TypeError(
      'Managed data namespace must be 1-64 lowercase ASCII characters, start with a letter, and contain only alphanumerics, dots, underscores, or hyphens',
    )
  }
}

/** Maps a module-local namespace to the process-wide namespace Core must share. */
export function managedModuleDataNamespace(
  moduleId: string,
  namespace: string,
): string {
  assertModuleId(moduleId, 'Module id')
  assertManagedModuleDataNamespace(namespace)
  return `module/${moduleId}/${namespace}`
}

/**
 * Runs an operation under the process-wide FIFO lock for a Vault and namespace.
 * The operation is invoked when the lock is acquired, not when it is queued.
 */
export function runExclusive<T>(
  vaultIdentity: ManagedModuleDataVaultIdentity,
  namespace: string,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  return enqueue(vaultIdentity, namespace, operation).promise
}

export class ManagedModuleDataLockOwner {
  private readonly queued = new Set<() => void>()
  private disposed = false

  constructor(private readonly vaultIdentity: ManagedModuleDataVaultIdentity) {}

  runExclusive<T>(
    namespace: string,
    operation: () => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new ManagedModuleDataLockDisposedError())
    }

    let cancel = (): void => undefined
    const queued = enqueue(this.vaultIdentity, namespace, operation, () => {
      this.queued.delete(cancel)
    })
    cancel = () => queued.cancel()
    if (!queued.started()) this.queued.add(cancel)
    return queued.promise
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const cancel of [...this.queued]) cancel()
    this.queued.clear()
  }
}

function enqueue<T>(
  vaultIdentity: ManagedModuleDataVaultIdentity,
  namespace: string,
  operation: () => T | PromiseLike<T>,
  onStart?: () => void,
): { promise: Promise<T>; cancel(): void; started(): boolean } {
  if (
    (typeof vaultIdentity !== 'object' &&
      typeof vaultIdentity !== 'function') ||
    vaultIdentity === null
  ) {
    throw new TypeError('Managed data Vault identity must be an object')
  }
  assertLockNamespace(namespace)
  if (typeof operation !== 'function') {
    throw new TypeError('Managed data lock operation must be a function')
  }

  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  const entry: QueueEntry<T> = {
    operation,
    resolve,
    reject,
    onStart,
    started: false,
    cancelled: false,
  }
  const vaultLocks = getVaultLocks(vaultIdentity)
  let state = vaultLocks.get(namespace)
  if (!state) {
    state = { running: false, queue: [] }
    vaultLocks.set(namespace, state)
  }
  state.queue.push(entry as QueueEntry<unknown>)
  drain(vaultLocks, namespace, state)

  return {
    promise,
    cancel: () => {
      if (entry.started || entry.cancelled) return
      entry.cancelled = true
      entry.reject(new ManagedModuleDataLockDisposedError())
      drain(vaultLocks, namespace, state)
    },
    started: () => entry.started,
  }
}

function assertLockNamespace(namespace: string): void {
  if (
    typeof namespace !== 'string' ||
    namespace.length > MAX_LOCK_NAMESPACE_LENGTH ||
    namespace.split('/').some((segment) => !NAMESPACE_PATTERN.test(segment))
  ) {
    throw new TypeError(
      'Managed data lock namespace must contain only valid non-empty lowercase ASCII path segments',
    )
  }
}

function getVaultLocks(
  vaultIdentity: ManagedModuleDataVaultIdentity,
): Map<string, LockState> {
  let vaultLocks = locksByVault.get(vaultIdentity)
  if (!vaultLocks) {
    vaultLocks = new Map()
    locksByVault.set(vaultIdentity, vaultLocks)
  }
  return vaultLocks
}

function drain(
  vaultLocks: Map<string, LockState>,
  namespace: string,
  state: LockState,
): void {
  if (state.running) return
  let entry = state.queue.shift()
  while (entry?.cancelled) entry = state.queue.shift()
  if (!entry) {
    vaultLocks.delete(namespace)
    return
  }

  state.running = true
  entry.started = true
  entry.onStart?.()
  void Promise.resolve()
    .then(entry.operation)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      state.running = false
      drain(vaultLocks, namespace, state)
    })
}
