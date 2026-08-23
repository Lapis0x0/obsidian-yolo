import {
  type AutomaticRetrySchedule,
  getNextAutomaticRetry,
} from '../retry/limitedAutomaticRetry'

import type { RuntimeComponentId, RuntimeComponentLease } from './contracts'
import { RuntimeComponentDeviceStateStore } from './runtimeComponentDeviceStateStore'
import { isTransientRuntimeComponentError } from './runtimeComponentErrors'
import { RuntimeComponentInstaller } from './runtimeComponentInstaller'
import { RuntimeComponentIntentStore } from './runtimeComponentIntentStore'
import { RuntimeComponentLoader } from './runtimeComponentLoader'
import type {
  RuntimeComponentDescriptor,
  RuntimeComponentPlatform,
  RuntimeComponentRegistry,
} from './runtimeComponentManifest'
import { RuntimeComponentRuntime } from './runtimeComponentRuntime'
import { RuntimeComponentStore } from './runtimeComponentStore'

const RUNTIME_COMPONENT_RETRY_SCHEDULE = [
  10_000,
  60_000,
  5 * 60_000,
] as const satisfies AutomaticRetrySchedule

export type RuntimeComponentStatus =
  | 'missing'
  | 'downloading'
  | 'ready'
  | 'loading'
  | 'active'
  | 'quiescing'
  | 'disabled'
  | 'failed'

export type RuntimeComponentRecord = Readonly<{
  descriptor: RuntimeComponentDescriptor
  enabled: boolean
  status: RuntimeComponentStatus
  error: string | null
}>

export type RuntimeComponentSnapshot = readonly RuntimeComponentRecord[]
export type RuntimeComponentQuiesceParticipant = () => Promise<void>

type MutableRecord = {
  descriptor: RuntimeComponentDescriptor
  enabled: boolean
  status: RuntimeComponentStatus
  error: string | null
  automaticRetryCount: number
  retryAt: number | null
}

type InstallJob = {
  id: RuntimeComponentId
  descriptor: RuntimeComponentDescriptor
  demand: boolean
  started: boolean
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

export class RuntimeComponentService {
  private readonly records = new Map<RuntimeComponentId, MutableRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly transitions = new Map<RuntimeComponentId, Promise<void>>()
  private readonly participants = new Map<
    RuntimeComponentId,
    Set<RuntimeComponentQuiesceParticipant>
  >()
  private readonly retryTimers = new Map<
    RuntimeComponentId,
    ReturnType<typeof setTimeout>
  >()
  private readonly installJobs = new Map<RuntimeComponentId, InstallJob>()
  private readonly installQueue: InstallJob[] = []
  private installRunning = false
  private readonly subscriptions: (() => void)[] = []
  private prefetchTail: Promise<void> = Promise.resolve()
  private cancelScheduledPrefetch: (() => void) | null = null
  private readonly operationAbort = new AbortController()
  private stopped = false
  private snapshot: RuntimeComponentSnapshot = Object.freeze([])

  constructor(
    private readonly options: Readonly<{
      registry: RuntimeComponentRegistry
      platform: RuntimeComponentPlatform
      store: RuntimeComponentStore
      installer: RuntimeComponentInstaller
      loader: RuntimeComponentLoader
      runtime: RuntimeComponentRuntime
      intentStore: RuntimeComponentIntentStore
      deviceStateStore: RuntimeComponentDeviceStateStore
      scheduleIdle?(callback: () => void): () => void
      /**
       * `id` is a `RuntimeComponentId` for a failure scoped to one
       * component, or the `'runtime'` sentinel for failures that span the
       * whole runtime-component subsystem (e.g. disposing every component
       * on service `stop()`).
       */
      reportError?(id: RuntimeComponentId | 'runtime', error: unknown): void
    }>,
  ) {
    for (const descriptor of options.registry.components) {
      if (!descriptor.platforms.includes(options.platform)) continue
      this.records.set(descriptor.id, {
        descriptor,
        enabled: true,
        status: 'missing',
        error: null,
        automaticRetryCount: 0,
        retryAt: null,
      })
    }
    this.snapshot = this.buildSnapshot()
  }

  getSnapshot = (): RuntimeComponentSnapshot => this.snapshot

  private buildSnapshot(): RuntimeComponentSnapshot {
    return Object.freeze(
      [...this.records.values()].map((record) =>
        Object.freeze({
          descriptor: record.descriptor,
          enabled: record.enabled,
          status: record.status,
          error: record.error,
        }),
      ),
    )
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    for (const record of this.records.values()) {
      this.subscriptions.push(
        this.options.intentStore.subscribe(record.descriptor.id, () => {
          void this.enqueueTransition(record.descriptor.id, () =>
            this.reconcileIntent(record.descriptor.id),
          ).catch((error) =>
            this.recordFailure(this.requireRecord(record.descriptor.id), error),
          )
        }),
      )
      try {
        await this.enqueueTransition(record.descriptor.id, () =>
          this.reconcileIntent(record.descriptor.id, false),
        )
      } catch (error) {
        await this.recordFailure(record, error)
      }
    }
    this.schedulePrefetch()
  }

  async acquire<I extends RuntimeComponentId>(
    id: I,
  ): Promise<RuntimeComponentLease<I>> {
    const record = this.requireRecord(id)
    if (!record.enabled) {
      throw new Error(`Runtime component "${id}" is disabled`)
    }
    if (record.status === 'failed') {
      throw new Error(
        record.error ?? `Runtime component "${id}" failed to initialize`,
      )
    }
    try {
      if (!this.options.runtime.isActive(id)) {
        this.update(record, { status: 'loading', error: null })
      }
      const lease = await this.options.runtime.acquire(id, async () => {
        // Runtime activation deduplicates this callback, so the artifact is
        // verified exactly once per in-memory instance instead of once per
        // short-lived lease (token counting can acquire many times per turn).
        await this.ensureInstalledWithFailureHandling(record, true)
        if (
          !record.enabled ||
          this.options.runtime.isQuiescing(record.descriptor.id)
        ) {
          throw new Error(
            `Runtime component "${record.descriptor.id}" is quiescing`,
          )
        }
        const bytes = await this.options.store.readEntry(record.descriptor)
        return this.options.loader.load(
          record.descriptor as RuntimeComponentDescriptor & { id: I },
          bytes,
          this.operationAbort.signal,
        )
      })
      this.update(record, { status: 'active', error: null })
      return lease
    } catch (error) {
      // A concurrent durable disable owns the visible state. Do not replace
      // quiescing/disabled with a spurious failed status or schedule repair.
      if (
        !record.enabled ||
        this.options.runtime.isQuiescing(record.descriptor.id)
      ) {
        throw error
      }
      if (record.error !== describe(error)) {
        await this.recordFailure(record, error)
      }
      throw error
    }
  }

  /**
   * Reads one declared asset's bytes for a component (e.g. an ONNX Runtime
   * WASM binary), ensuring the component's artifacts are installed first.
   * Unlike `acquire`, this never touches the script loader/runtime — it only
   * hands back bytes the host injects into a component through a callback
   * (see `readRuntimeComponentAsset`), so `entry.js` is never executed as a
   * side effect of reading an asset.
   */
  async readAsset(id: RuntimeComponentId, name: string): Promise<Uint8Array> {
    const record = this.requireRecord(id)
    const asset = record.descriptor.assets?.find((a) => a.name === name)
    if (!asset) {
      throw new Error(`Runtime component "${id}" has no asset "${name}"`)
    }
    if (!record.enabled) {
      throw new Error(`Runtime component "${id}" is disabled`)
    }
    if (record.status === 'failed') {
      throw new Error(
        record.error ?? `Runtime component "${id}" failed to initialize`,
      )
    }
    await this.ensureInstalledWithFailureHandling(record, true)
    if (!record.enabled || this.options.runtime.isQuiescing(id)) {
      throw new Error(`Runtime component "${id}" is quiescing`)
    }
    return this.options.store.readAsset(record.descriptor, asset)
  }

  setEnabled(id: RuntimeComponentId, enabled: boolean): Promise<void> {
    return this.enqueueTransition(id, async () => {
      if (enabled) {
        await this.options.intentStore.enable(id)
      } else {
        // Desired intent is durable before this device rejects new work.
        await this.options.intentStore.disable(id)
      }
      await this.reconcileIntent(id)
    })
  }

  retry(id: RuntimeComponentId): Promise<void> {
    return this.enqueueTransition(id, async () => {
      const record = this.requireRecord(id)
      if (!record.enabled) {
        throw new Error(`Runtime component "${id}" is disabled`)
      }
      this.clearRetryTimer(id)
      record.automaticRetryCount = 0
      record.retryAt = null
      this.update(record, { status: 'missing', error: null })
      await this.writeDeviceState(record, null)
      await this.ensureInstalledWithFailureHandling(record, false)
    })
  }

  async onOnline(): Promise<void> {
    for (const record of this.records.values()) {
      if (!record.enabled || !this.retryTimers.has(record.descriptor.id)) {
        continue
      }
      this.clearRetryTimer(record.descriptor.id)
      record.retryAt = Date.now()
      try {
        await this.writeDeviceState(record, null)
      } finally {
        this.armRetryTimer(record, 0)
      }
    }
  }

  registerQuiesceParticipant(
    id: RuntimeComponentId,
    participant: RuntimeComponentQuiesceParticipant,
  ): () => void {
    const values = this.participants.get(id) ?? new Set()
    values.add(participant)
    this.participants.set(id, values)
    return () => values.delete(participant)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.operationAbort.abort()
    this.cancelScheduledPrefetch?.()
    this.cancelScheduledPrefetch = null
    const stoppedError = new DOMException(
      'Runtime component service stopped',
      'AbortError',
    )
    for (const job of this.installQueue.splice(0)) {
      this.installJobs.delete(job.id)
      job.reject(stoppedError)
    }
    for (const unsubscribe of this.subscriptions.splice(0)) {
      try {
        unsubscribe()
      } catch (error) {
        this.options.reportError?.('tokenizer', error)
      }
    }
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    for (const id of this.records.keys()) this.options.runtime.beginQuiesce(id)
    void this.options.runtime.dispose().catch((error) => {
      this.options.reportError?.('runtime', error)
    })
  }

  private async reconcileIntent(
    id: RuntimeComponentId,
    installWhenEnabled = true,
  ): Promise<void> {
    const record = this.requireRecord(id)
    const enabled = await this.options.intentStore.isEnabled(id)
    if (!enabled) {
      record.enabled = false
      this.clearRetryTimer(id)
      record.automaticRetryCount = 0
      record.retryAt = null
      this.options.runtime.beginQuiesce(id)
      this.update(record, { status: 'quiescing', error: null })
      let participantError: unknown
      for (const participant of this.participants.get(id) ?? []) {
        try {
          await participant()
        } catch (error) {
          participantError ??= error
        }
      }
      await this.options.runtime.drainAndDispose(id)
      await this.writeDeviceState(record, null)
      this.update(record, {
        status: 'disabled',
        error: participantError ? describe(participantError) : null,
      })
      if (participantError) this.options.reportError?.(id, participantError)
      return
    }

    record.enabled = true
    this.options.runtime.endQuiesce(id)
    if (!installWhenEnabled) {
      const deviceState = await this.options.deviceStateStore.read(id)
      const retryState =
        deviceState?.retry?.descriptorHash === record.descriptor.sha256
          ? deviceState.retry
          : null
      record.automaticRetryCount = retryState?.automaticRetryCount ?? 0
      record.retryAt = retryState?.retryAt ?? null
      const plausible = await this.options.store.hasPlausibleEntry(
        record.descriptor,
      )
      const restoredFailure = retryState && deviceState?.error
      this.update(record, {
        status: restoredFailure
          ? 'failed'
          : deviceState?.platform === this.options.platform &&
              deviceState.activeHash === record.descriptor.sha256 &&
              plausible
            ? 'ready'
            : 'missing',
        error: restoredFailure ? deviceState.error : null,
      })
      if (restoredFailure && record.retryAt !== null) {
        this.armRetryTimer(record, Math.max(0, record.retryAt - Date.now()))
      }
      return
    }
    record.automaticRetryCount = 0
    record.retryAt = null
    await this.ensureInstalledWithFailureHandling(record, false)
  }

  private async ensureInstalledWithFailureHandling(
    record: MutableRecord,
    demand: boolean,
  ): Promise<void> {
    try {
      await this.ensureInstalled(record, demand)
    } catch (error) {
      await this.recordFailure(record, error)
      throw error
    }
  }

  private async ensureInstalled(
    record: MutableRecord,
    demand: boolean,
  ): Promise<void> {
    if (!record.enabled) {
      throw new Error(`Runtime component "${record.descriptor.id}" is disabled`)
    }
    const plausible = await this.options.store.hasPlausibleEntry(
      record.descriptor,
    )
    if (plausible) {
      let verified = false
      try {
        await this.options.installer.verifyInstalled(record.descriptor)
        verified = true
      } catch {
        // A present but invalid artifact is repaired through the same verified
        // installer path instead of being verified forever on every retry.
      }
      if (verified) {
        await this.finishInstall(record)
        return
      }
    }
    this.update(record, { status: 'downloading', error: null })
    await this.writeDeviceState(record, null)
    await this.enqueueInstall(record.descriptor, demand)
    if (
      !record.enabled ||
      this.options.runtime.isQuiescing(record.descriptor.id)
    ) {
      return
    }
    await this.finishInstall(record)
  }

  private async finishInstall(record: MutableRecord): Promise<void> {
    this.clearRetryTimer(record.descriptor.id)
    record.automaticRetryCount = 0
    record.retryAt = null
    this.update(record, { status: 'ready', error: null })
    await this.writeDeviceState(record, record.descriptor.sha256)
  }

  private async writeDeviceState(
    record: MutableRecord,
    activeHash: string | null,
  ): Promise<void> {
    await this.options.deviceStateStore.write({
      componentId: record.descriptor.id,
      platform: this.options.platform,
      activeHash,
      pending: record.status === 'downloading' ? record.descriptor : null,
      error: record.error,
      retry:
        record.error !== null ||
        record.automaticRetryCount > 0 ||
        record.retryAt !== null
          ? {
              descriptorHash: record.descriptor.sha256,
              automaticRetryCount: record.automaticRetryCount,
              retryAt: record.retryAt,
            }
          : null,
    })
  }

  private schedulePrefetch(): void {
    const schedule =
      this.options.scheduleIdle ??
      ((callback: () => void) => {
        const globalWithIdle = globalThis as typeof globalThis & {
          requestIdleCallback?: (callback: () => void) => number
          cancelIdleCallback?: (id: number) => void
        }
        if (globalWithIdle.requestIdleCallback) {
          const id = globalWithIdle.requestIdleCallback(callback)
          return () => globalWithIdle.cancelIdleCallback?.(id)
        }
        const id = setTimeout(callback, 0)
        return () => clearTimeout(id)
      })
    this.cancelScheduledPrefetch = schedule(() => {
      this.cancelScheduledPrefetch = null
      if (this.stopped) return
      for (const record of this.records.values()) {
        if (!record.enabled || record.status === 'failed') continue
        this.prefetchTail = this.prefetchTail
          .catch(() => undefined)
          .then(() => this.ensureInstalledWithFailureHandling(record, false))
          .catch((error) =>
            this.options.reportError?.(record.descriptor.id, error),
          )
      }
    })
  }

  private async recordFailure(
    record: MutableRecord,
    error: unknown,
  ): Promise<void> {
    this.update(record, { status: 'failed', error: describe(error) })
    this.options.reportError?.(record.descriptor.id, error)
    this.clearRetryTimer(record.descriptor.id)
    const next = isTransientRuntimeComponentError(error)
      ? getNextAutomaticRetry(
          record.automaticRetryCount,
          RUNTIME_COMPONENT_RETRY_SCHEDULE,
        )
      : null
    if (next) {
      record.automaticRetryCount = next.retryCount
      record.retryAt = Date.now() + next.delayMs
    } else {
      record.retryAt = null
    }
    await this.writeDeviceState(record, null).catch((stateError) => {
      this.options.reportError?.(record.descriptor.id, stateError)
    })
    if (next) this.armRetryTimer(record, next.delayMs)
  }

  private armRetryTimer(record: MutableRecord, delayMs: number): void {
    const id = record.descriptor.id
    if (this.stopped || this.retryTimers.has(id)) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(id)
      void this.enqueueTransition(id, async () => {
        const current = this.requireRecord(id)
        current.retryAt = null
        if (current.enabled) {
          await this.ensureInstalledWithFailureHandling(current, false)
        }
      }).catch((error) => {
        this.options.reportError?.(id, error)
      })
    }, delayMs)
    this.retryTimers.set(id, timer)
  }

  private enqueueInstall(
    descriptor: RuntimeComponentDescriptor,
    demand: boolean,
  ): Promise<void> {
    const existing = this.installJobs.get(descriptor.id)
    if (existing) {
      if (demand && !existing.demand && !existing.started) {
        existing.demand = true
        const index = this.installQueue.indexOf(existing)
        if (index >= 0) this.installQueue.splice(index, 1)
        this.installQueue.unshift(existing)
      }
      return existing.promise
    }
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const job: InstallJob = {
      id: descriptor.id,
      descriptor,
      demand,
      started: false,
      promise,
      resolve,
      reject,
    }
    this.installJobs.set(descriptor.id, job)
    if (demand) this.installQueue.unshift(job)
    else this.installQueue.push(job)
    this.pumpInstallQueue()
    return promise
  }

  private pumpInstallQueue(): void {
    if (this.installRunning || this.stopped) return
    const job = this.installQueue.shift()
    if (!job) return
    this.installRunning = true
    job.started = true
    void this.options.installer
      .ensure(job.descriptor, this.operationAbort.signal)
      .then(
        () => job.resolve(),
        (error) => job.reject(error),
      )
      .finally(() => {
        this.installJobs.delete(job.id)
        this.installRunning = false
        this.pumpInstallQueue()
      })
  }

  private clearRetryTimer(id: RuntimeComponentId): void {
    const timer = this.retryTimers.get(id)
    if (timer) clearTimeout(timer)
    this.retryTimers.delete(id)
  }

  private enqueueTransition<T>(
    id: RuntimeComponentId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.transitions.get(id) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.transitions.set(id, tail)
    void tail.then(() => {
      if (this.transitions.get(id) === tail) this.transitions.delete(id)
    })
    return result
  }

  private requireRecord(id: RuntimeComponentId): MutableRecord {
    const record = this.records.get(id)
    if (!record) {
      throw new Error(
        `Runtime component "${id}" is unavailable on this platform`,
      )
    }
    return record
  }

  private update(
    record: MutableRecord,
    next: Partial<Pick<MutableRecord, 'status' | 'error'>>,
  ): void {
    Object.assign(record, next)
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
