import { App } from 'obsidian'

import { IndexProgress } from '../../components/chat-view/QueryProgress'
import { ReconcileResult } from '../../database/modules/vector/VectorManager'
import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'
import {
  type AutomaticRetrySchedule,
  getNextAutomaticRetry,
} from '../retry/limitedAutomaticRetry'

import { RAGEngine } from './ragEngine'
import {
  type RagIndexFailureKind,
  describeRagIndexError,
} from './ragIndexErrors'
import type { ReconcileScope } from './reconciler'

type AppWithLocalStorage = App & {
  loadLocalStorage?: (key: string) => string | null | Promise<string | null>
  saveLocalStorage?: (key: string, value: string) => void | Promise<void>
}

export type RagIndexRunStatus =
  | 'idle'
  | 'running'
  | 'queued'
  | 'retry_scheduled'
  | 'failed'
  | 'completed'

export type RagIndexRunTrigger = 'manual' | 'auto'
export type RagIndexRetryPolicy = 'none' | 'transient'
export type RagIndexRunMode = 'rebuild' | 'sync'

type RagIndexRunOptions = {
  /**
   * `rebuild`: truncate the active model namespace, then reconcile from scratch.
   * `sync`: reconcile against current state without truncation. Idempotent —
   * a crashed sync run resumes naturally on the next call.
   */
  mode: RagIndexRunMode
  scope: ReconcileScope
  trigger: RagIndexRunTrigger
  retryPolicy: RagIndexRetryPolicy
  onProgress?: (progress: IndexProgress) => void
}

export type RagIndexRunSnapshot = {
  runId: string | null
  trigger: RagIndexRunTrigger | null
  retryPolicy: RagIndexRetryPolicy
  mode: RagIndexRunMode | null
  /** Last scope kind for retry restoration (paths are not persisted). */
  scopeKind: 'all' | 'paths' | null
  status: RagIndexRunStatus
  startedAt: number | null
  updatedAt: number | null
  currentFile?: string
  lastCompletedFile?: string
  totalFiles?: number
  completedFiles?: number
  totalChunks?: number
  completedChunks?: number
  waitingForRateLimit?: boolean
  retryCount: number
  retryAt?: number
  failureKind?: RagIndexFailureKind
  failureMessage?: string
  failureHttpStatus?: number
  /**
   * Files that could not be indexed permanently on the last completed run (kept
   * partial results, not retried). Persisted so the settings page can surface a
   * durable "X files couldn't be indexed" notice. Cleared on a clean completion.
   */
  permanentFailedPaths?: string[]
}

/** One knowledge base runs at a time; every other queued or scheduled base is
 * visible here so the UI can show "N 个知识库等待" without polling each one. */
export type RagIndexServiceSnapshot = {
  runs: Record<string, RagIndexRunSnapshot>
  activeKbId: string | null
  queuedKbIds: string[]
}

type RagIndexServiceDeps = {
  app: App
  getRagEngine: (kbId: string) => Promise<RAGEngine>
  activityRegistry: BackgroundActivityRegistry
  isRagEnabled: () => boolean
  t: (key: string, fallback?: string) => string
}

type RagIndexSubscriber = (snapshot: RagIndexServiceSnapshot) => void

// Keyed per knowledge base (`Record<kbId, RagIndexRunSnapshot>`); the
// single-run shape released earlier lived under `yolo_rag_index_run`.
const STORAGE_KEY = 'yolo_rag_index_runs'
const RETRY_ACTIVITY_ID = 'rag:index'
const INTERRUPTED_RETRY_DELAY_MS = 15 * 1000
const MANUAL_RETRY_SCHEDULE = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
] as const satisfies AutomaticRetrySchedule

const isPromiseLike = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof value === 'object' &&
  value !== null &&
  'then' in (value as Record<string, unknown>) &&
  typeof (value as { then?: unknown }).then === 'function'

const defaultSnapshot = (): RagIndexRunSnapshot => ({
  runId: null,
  trigger: null,
  retryPolicy: 'none',
  mode: null,
  scopeKind: null,
  status: 'idle',
  startedAt: null,
  updatedAt: null,
  retryCount: 0,
})

const createRunId = (): string =>
  `rag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const waiterKey = (kbId: string, generation: number): string =>
  `${kbId}#${generation}`

const readLocalStorage = async (
  app: App,
  key: string,
): Promise<string | null> => {
  const appWithLocalStorage = app as AppWithLocalStorage
  if (typeof appWithLocalStorage.loadLocalStorage !== 'function') {
    return null
  }
  const result = appWithLocalStorage.loadLocalStorage(key)
  return isPromiseLike(result) ? await result : result
}

const writeLocalStorage = async (
  app: App,
  key: string,
  value: string,
): Promise<void> => {
  const appWithLocalStorage = app as AppWithLocalStorage
  if (typeof appWithLocalStorage.saveLocalStorage !== 'function') {
    return
  }
  await Promise.resolve(appWithLocalStorage.saveLocalStorage(key, value))
}

/** `rebuild` absorbs a queued `sync` (a truncate-and-rebuild already covers
 * whatever a plain sync would have done); scope merges to `all` unless both
 * sides are `paths`, in which case the path sets union. */
const mergeRunOptions = (
  existing: RagIndexRunOptions,
  incoming: RagIndexRunOptions,
): RagIndexRunOptions => {
  const mode: RagIndexRunMode =
    existing.mode === 'rebuild' || incoming.mode === 'rebuild'
      ? 'rebuild'
      : 'sync'
  const scope: ReconcileScope =
    existing.scope.kind === 'all' || incoming.scope.kind === 'all'
      ? { kind: 'all' }
      : {
          kind: 'paths',
          paths: Array.from(
            new Set([...existing.scope.paths, ...incoming.scope.paths]),
          ),
        }
  return {
    mode,
    scope,
    // A manual trigger anywhere in the merge keeps the run manual (surfaces
    // failures via retry UI rather than silently swallowing them like auto).
    trigger:
      existing.trigger === 'manual' || incoming.trigger === 'manual'
        ? 'manual'
        : 'auto',
    retryPolicy:
      existing.retryPolicy === 'transient' ||
      incoming.retryPolicy === 'transient'
        ? 'transient'
        : 'none',
    // Only the run that is actually about to execute keeps a progress
    // callback; a superseded queue entry's callback would never fire again.
    onProgress: incoming.onProgress ?? existing.onProgress,
  }
}

export class RagIndexService {
  private readonly app: App
  private readonly getRagEngine: (kbId: string) => Promise<RAGEngine>
  private readonly activityRegistry: BackgroundActivityRegistry
  private readonly isRagEnabled: () => boolean
  private readonly t: (key: string, fallback?: string) => string

  private snapshots = new Map<string, RagIndexRunSnapshot>()
  private readonly subscribers = new Set<RagIndexSubscriber>()

  private activeKbId: string | null = null
  private currentAbortController: AbortController | null = null

  /** FIFO of knowledge base ids waiting behind the active run. */
  private queue: string[] = []
  private queuedEntries = new Map<
    string,
    { options: RagIndexRunOptions; generation: number }
  >()
  /** Last generation number issued per kbId — a monotonic counter, not a
   * "current" value (a finished run's generation stays retired). */
  private lastGeneration = new Map<string, number>()
  /**
   * Waiters keyed by `${kbId}#${generation}`, not just `kbId`. A `run()` call
   * against a base that's already active folds into a *follow-up* run (see
   * `run`'s comment) rather than the in-flight one — if waiters were bucketed
   * by kbId alone, the in-flight run's completion would incorrectly resolve
   * waiters that are actually waiting on that not-yet-started follow-up.
   */
  private waiters = new Map<
    string,
    {
      resolve: (result: ReconcileResult) => void
      reject: (error: unknown) => void
    }[]
  >()

  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private retryOptions = new Map<string, RagIndexRunOptions>()

  private initPromise: Promise<void> | null = null

  constructor(deps: RagIndexServiceDeps) {
    this.app = deps.app
    this.getRagEngine = deps.getRagEngine
    this.activityRegistry = deps.activityRegistry
    this.isRagEnabled = deps.isRagEnabled
    this.t = deps.t
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const raw = await readLocalStorage(this.app, STORAGE_KEY)
        if (!raw) {
          return
        }
        try {
          const parsed = JSON.parse(raw) as Record<
            string,
            Partial<RagIndexRunSnapshot>
          >
          for (const [kbId, partial] of Object.entries(parsed)) {
            let snapshot: RagIndexRunSnapshot = {
              ...defaultSnapshot(),
              ...partial,
            }
            if (snapshot.status === 'running') {
              const shouldRecover =
                snapshot.retryPolicy === 'transient' &&
                snapshot.mode !== null &&
                snapshot.trigger !== null
              snapshot = {
                ...snapshot,
                status: shouldRecover ? 'retry_scheduled' : 'failed',
                // Interrupted runs always resume as 'sync' so the reconcile
                // loop skips chunks already in the DB instead of truncating.
                // Users who truly want a fresh rebuild trigger it explicitly.
                mode: shouldRecover ? 'sync' : snapshot.mode,
                retryAt: shouldRecover
                  ? Date.now() + INTERRUPTED_RETRY_DELAY_MS
                  : undefined,
                failureKind: shouldRecover ? 'transient' : 'unknown',
                failureMessage: this.t(
                  'settings.rag.previousRunInterrupted',
                  '上次索引未正常完成。',
                ),
                updatedAt: Date.now(),
              }
            }
            this.snapshots.set(kbId, snapshot)
          }
          await this.persistSnapshots()
          this.publishActivity()
          this.emit()
        } catch (error) {
          console.warn('[YOLO] Failed to restore RAG index state', error)
        }
      })()
    }
    await this.initPromise
  }

  subscribe(subscriber: RagIndexSubscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber(this.getSnapshot())
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  getSnapshot(): RagIndexServiceSnapshot {
    return {
      runs: Object.fromEntries(this.snapshots),
      activeKbId: this.activeKbId,
      queuedKbIds: [...this.queue],
    }
  }

  getRunSnapshot(kbId: string): RagIndexRunSnapshot {
    return this.snapshots.get(kbId) ?? defaultSnapshot()
  }

  isRunning(kbId?: string): boolean {
    if (kbId === undefined) return this.activeKbId !== null
    return this.activeKbId === kbId
  }

  /** No `kbId`: cancel the active run and drop every queued run. One
   * `kbId`: cancel it if active, or drop it from the queue if only queued.
   * Either way also drops any *queued follow-up* for that base (a second
   * `run()` call against an already-active base) and its armed retry timer —
   * cancelling an active base must not leave a follow-up run to silently
   * fire right after, and must not leave a stale retry armed for a base the
   * caller just asked to stop. */
  cancel(kbId?: string): void {
    if (kbId === undefined) {
      this.currentAbortController?.abort()
      if (this.activeKbId !== null) {
        this.releaseEmbeddingIdleSessionEagerly(this.activeKbId)
      }
      this.dequeueAll()
      for (const id of this.retryTimers.keys()) {
        this.clearRetryTimer(id)
      }
      return
    }
    if (this.activeKbId === kbId) {
      this.currentAbortController?.abort()
      this.releaseEmbeddingIdleSessionEagerly(kbId)
      this.dequeueOne(kbId)
      this.clearRetryTimer(kbId)
      return
    }
    if (this.queue.includes(kbId)) {
      this.dequeueOne(kbId)
      this.clearRetryTimer(kbId)
      this.emit()
    }
  }

  /**
   * `abort()` only unblocks the reconcile loop's *own* checkpoints — it
   * never reaches the local embedding engine's session-creation or
   * `embed()` calls (`local-embedding/client.ts` doesn't thread a signal
   * into either), so a cold model load or a slow batch keeps running
   * regardless. Tearing the session down here forces it: `session.dispose()`
   * force-terminates the Worker within `DISPOSE_TIMEOUT_MS` even if it's
   * stuck mid-call, which rejects whatever the reconcile loop was awaiting
   * and actually unblocks `cancel()` instead of leaving it looking inert
   * until the stuck call finishes on its own.
   */
  private releaseEmbeddingIdleSessionEagerly(kbId: string): void {
    void this.getRagEngine(kbId).then((engine) =>
      engine.releaseEmbeddingIdleSession(),
    )
  }

  /** Cancels/dequeues `kbId` (same as `cancel(kbId)`) and waits until it is
   * fully idle — including the in-flight `startRun` call's own `catch`/
   * `finally` settling, which runs asynchronously after `abort()` and would
   * otherwise race a caller that immediately deletes the base's snapshot or
   * database. Callers that need to safely remove a knowledge base must await
   * this before touching anything the active run's completion handler still
   * writes to (see `forgetKnowledgeBase`). */
  async cancelAndWait(kbId: string): Promise<void> {
    this.cancel(kbId)
    await this.waitForKbIdle(kbId)
  }

  async waitForKbIdle(kbId: string): Promise<void> {
    if (this.activeKbId !== kbId && !this.queue.includes(kbId)) return
    await new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (this.activeKbId === kbId || this.queue.includes(kbId)) return
        unsubscribe()
        resolve()
      })
    })
  }

  private dequeueOne(kbId: string): void {
    if (!this.queue.includes(kbId)) return
    this.queue = this.queue.filter((id) => id !== kbId)
    const entry = this.queuedEntries.get(kbId)
    this.queuedEntries.delete(kbId)
    if (entry) {
      this.settleWaiters(
        kbId,
        entry.generation,
        new Error('cancelled'),
        'reject',
      )
    }
  }

  private dequeueAll(): void {
    for (const queuedKbId of [...this.queue]) {
      this.dequeueOne(queuedKbId)
    }
  }

  onOnline(): void {
    // Snapshot entries before iterating: armRetryTimer() re-inserts the same
    // key into `retryOptions` (via clearRetryTimer's delete + its own set),
    // and a live Map iterator revisits a key that's deleted and re-added
    // during iteration — looping over the Map directly here would spin
    // forever re-arming the same knowledge base's retry.
    for (const [kbId, options] of [...this.retryOptions]) {
      if (this.snapshots.get(kbId)?.status !== 'retry_scheduled') continue
      this.clearRetryTimer(kbId)
      this.armRetryTimer(kbId, options, 0)
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.activeKbId === null && this.queue.length === 0) return
    await new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (this.activeKbId !== null || this.queue.length > 0) return
        unsubscribe()
        resolve()
      })
    })
  }

  /**
   * Re-issue a previously scheduled retry. Path-scoped runs can't be retried
   * losslessly because we don't persist the path list — they fall back to a
   * full sync, which is correct (sync is idempotent and self-converging).
   */
  restoreRetryScheduledRun(kbId: string, minDelayMs = 0): void {
    const snapshot = this.snapshots.get(kbId)
    if (
      !snapshot ||
      snapshot.status !== 'retry_scheduled' ||
      snapshot.trigger !== 'manual' ||
      snapshot.retryPolicy !== 'transient' ||
      snapshot.mode === null
    ) {
      return
    }

    this.scheduleRetry(
      kbId,
      {
        mode: snapshot.mode,
        scope: { kind: 'all' },
        trigger: snapshot.trigger,
        retryPolicy: snapshot.retryPolicy,
      },
      minDelayMs,
    )
  }

  /**
   * Enqueues (or runs immediately, if idle) an index pass for one knowledge
   * base. Never throws "busy" — a request against a base that's already
   * active or queued merges into that pending run (see `mergeRunOptions`)
   * and this resolves once that merged run actually finishes.
   */
  async run(
    kbId: string,
    options: RagIndexRunOptions,
    attempt: 'new' | 'automatic-retry' = 'new',
  ): Promise<ReconcileResult> {
    await this.initialize()
    this.clearRetryTimer(kbId)

    const shouldStartImmediately = this.activeKbId === null
    const generation = shouldStartImmediately
      ? this.nextGeneration(kbId)
      : // Already running (or queued behind) this base: fold this request in
        // as a follow-up run rather than merging into the in-flight one
        // (which may already have read stale scope/options) — queue it to
        // run right after, under whichever generation that follow-up
        // already has (or a fresh one if this is the first follow-up).
        this.enqueue(kbId, options)

    const resultPromise = new Promise<ReconcileResult>((resolve, reject) => {
      const key = waiterKey(kbId, generation)
      const list = this.waiters.get(key) ?? []
      list.push({ resolve, reject })
      this.waiters.set(key, list)
    })

    if (shouldStartImmediately) {
      void this.startRun(kbId, generation, options, attempt)
    }

    return resultPromise
  }

  private nextGeneration(kbId: string): number {
    const next = (this.lastGeneration.get(kbId) ?? 0) + 1
    this.lastGeneration.set(kbId, next)
    return next
  }

  /** Returns the generation this request's waiter should attach to. */
  private enqueue(kbId: string, options: RagIndexRunOptions): number {
    const existing = this.queuedEntries.get(kbId)
    const generation = existing?.generation ?? this.nextGeneration(kbId)
    this.queuedEntries.set(kbId, {
      options: existing ? mergeRunOptions(existing.options, options) : options,
      generation,
    })
    if (!this.queue.includes(kbId)) {
      this.queue.push(kbId)
    }
    this.snapshots.set(kbId, {
      ...(this.snapshots.get(kbId) ?? defaultSnapshot()),
      status: 'queued',
      updatedAt: Date.now(),
    })
    this.emit()
    return generation
  }

  private async startRun(
    kbId: string,
    generation: number,
    options: RagIndexRunOptions,
    attempt: 'new' | 'automatic-retry',
  ): Promise<void> {
    this.activeKbId = kbId
    const controller = new AbortController()
    this.currentAbortController = controller

    const runId = createRunId()
    const startedAt = Date.now()
    const previous = this.snapshots.get(kbId) ?? defaultSnapshot()
    this.snapshots.set(kbId, {
      ...previous,
      runId,
      trigger: options.trigger,
      retryPolicy: options.retryPolicy,
      mode: options.mode,
      scopeKind: options.scope.kind,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      // Progress fields belong to this run; don't let the previous run's
      // totals show as a 100% flash before the first progress tick.
      currentFile: undefined,
      lastCompletedFile: undefined,
      totalFiles: undefined,
      completedFiles: undefined,
      totalChunks: undefined,
      completedChunks: undefined,
      waitingForRateLimit: undefined,
      failureKind: undefined,
      failureMessage: undefined,
      failureHttpStatus: undefined,
      retryAt: undefined,
      retryCount: attempt === 'automatic-retry' ? previous.retryCount : 0,
    })
    await this.persistSnapshots()

    let ragEngine: RAGEngine | undefined
    try {
      ragEngine = await this.getRagEngine(kbId)
      const result = await ragEngine.updateVaultIndex(
        {
          scope: options.scope,
          truncate: options.mode === 'rebuild',
          signal: controller.signal,
        },
        (queryProgress) => {
          if (queryProgress.type !== 'indexing') return
          const progress = queryProgress.indexProgress
          const current = this.snapshots.get(kbId) ?? defaultSnapshot()
          this.snapshots.set(kbId, {
            ...current,
            updatedAt: Date.now(),
            // The embedder only names a file when it changes; keep the last
            // one so the status line doesn't blink back to "preparing".
            currentFile: progress.currentFile ?? current.currentFile,
            lastCompletedFile:
              (progress.completedFiles ?? 0) > 0
                ? (progress.currentFile ?? current.lastCompletedFile)
                : current.lastCompletedFile,
            totalFiles: progress.totalFiles,
            completedFiles: progress.completedFiles,
            totalChunks: progress.totalChunks,
            completedChunks: progress.completedChunks,
            waitingForRateLimit: progress.waitingForRateLimit,
          })
          void this.persistSnapshots()
          // Progress arrives once per embedding batch; subscribers (settings
          // cards, activity bar) render live percentages from these snapshots.
          this.publishActivity()
          this.emit()
          options.onProgress?.(progress)
        },
      )

      const completed = this.snapshots.get(kbId) ?? defaultSnapshot()
      this.snapshots.set(kbId, {
        ...completed,
        status: 'completed',
        updatedAt: Date.now(),
        failureKind: undefined,
        failureMessage: undefined,
        failureHttpStatus: undefined,
        retryAt: undefined,
        retryCount: 0,
        waitingForRateLimit: false,
        // Permanent failures need user intervention → persist so the settings
        // page can surface them durably. Clear on a clean completion. Chunkify
        // failures self-heal on the next reconcile, so they're not persisted.
        permanentFailedPaths:
          result.permanentFailedPaths.length > 0
            ? result.permanentFailedPaths
            : undefined,
      })
      await this.persistSnapshots()
      this.settleWaiters(kbId, generation, result, 'resolve')
    } catch (error) {
      const failure = describeRagIndexError(error)
      const failureKind = failure.kind
      const current = this.snapshots.get(kbId) ?? defaultSnapshot()
      const nextRetry =
        failureKind === 'transient' && options.retryPolicy === 'transient'
          ? getNextAutomaticRetry(current.retryCount, MANUAL_RETRY_SCHEDULE)
          : null
      const shouldScheduleRetry = nextRetry !== null
      this.snapshots.set(kbId, {
        ...current,
        status:
          failureKind === 'aborted'
            ? 'idle'
            : shouldScheduleRetry
              ? 'retry_scheduled'
              : 'failed',
        updatedAt: Date.now(),
        failureKind,
        failureMessage: failure.message,
        failureHttpStatus: failure.httpStatus,
        waitingForRateLimit: false,
        retryCount: nextRetry?.retryCount ?? current.retryCount,
        retryAt: shouldScheduleRetry
          ? Date.now() + nextRetry.delayMs
          : undefined,
      })
      await this.persistSnapshots()
      if (shouldScheduleRetry && options.trigger === 'manual') {
        this.scheduleRetry(kbId, options)
      }
      if (failureKind === 'aborted') {
        // A cancelled run leaves the embedding client idling for the rest
        // of its idle-teardown window otherwise — fine for the small
        // models, wasteful for a multi-GB one (Qwen3-Embedding fp16).
        void ragEngine?.releaseEmbeddingIdleSession()
      }
      this.settleWaiters(kbId, generation, error, 'reject')
    } finally {
      this.activeKbId = null
      this.currentAbortController = null
      this.publishActivity()
      this.emit()
      this.runNextQueued()
    }
  }

  private runNextQueued(): void {
    const nextKbId = this.queue.shift()
    if (nextKbId === undefined) return
    const entry = this.queuedEntries.get(nextKbId)
    this.queuedEntries.delete(nextKbId)
    if (!entry) return
    void this.startRun(nextKbId, entry.generation, entry.options, 'new')
  }

  private settleWaiters(
    kbId: string,
    generation: number,
    value: unknown,
    kind: 'resolve' | 'reject',
  ): void {
    const key = waiterKey(kbId, generation)
    const list = this.waiters.get(key)
    if (!list) return
    this.waiters.delete(key)
    for (const waiter of list) {
      if (kind === 'resolve') {
        waiter.resolve(value as ReconcileResult)
      } else {
        waiter.reject(value)
      }
    }
  }

  async markRetryScheduled(
    kbId: string,
    input: {
      mode: RagIndexRunMode
      retryAt: number
      retryCount: number
      failureMessage?: string
    },
  ): Promise<void> {
    await this.initialize()
    const current = this.snapshots.get(kbId) ?? defaultSnapshot()
    this.snapshots.set(kbId, {
      ...current,
      mode: input.mode,
      trigger: 'auto',
      retryPolicy: 'transient',
      status: 'retry_scheduled',
      retryAt: input.retryAt,
      updatedAt: Date.now(),
      failureKind: 'transient',
      failureMessage: input.failureMessage,
      retryCount: input.retryCount,
    })
    await this.persistSnapshots()
  }

  async clearRetryScheduled(kbId: string): Promise<void> {
    await this.initialize()
    const current = this.snapshots.get(kbId)
    if (!current || current.status !== 'retry_scheduled') {
      return
    }
    this.clearRetryTimer(kbId)
    this.snapshots.set(kbId, {
      ...current,
      status: 'idle',
      updatedAt: Date.now(),
      retryAt: undefined,
      failureKind: undefined,
      failureMessage: undefined,
      waitingForRateLimit: false,
    })
    await this.persistSnapshots()
  }

  async resetRetryState(kbId: string): Promise<void> {
    await this.initialize()
    this.clearRetryTimer(kbId)
    const current = this.snapshots.get(kbId) ?? defaultSnapshot()
    this.snapshots.set(kbId, {
      ...current,
      status:
        current.status === 'retry_scheduled' || current.status === 'failed'
          ? 'idle'
          : current.status,
      retryPolicy: 'none',
      retryCount: 0,
      retryAt: undefined,
      failureKind: undefined,
      failureMessage: undefined,
      failureHttpStatus: undefined,
      waitingForRateLimit: false,
      updatedAt: Date.now(),
    })
    await this.persistSnapshots()
  }

  refreshActivity(): void {
    this.publishActivity()
  }

  /** Drops a knowledge base's run state entirely — cancels/dequeues it first,
   * then removes its snapshot and retry timer. Used when the base itself is
   * deleted from settings. */
  async forgetKnowledgeBase(kbId: string): Promise<void> {
    // Must fully await the abort before deleting the snapshot: an active
    // run's catch/finally writes a fresh (aborted) snapshot for `kbId` after
    // `abort()` returns, asynchronously. Deleting the snapshot first would
    // just have it revived by that write landing afterward.
    await this.cancelAndWait(kbId)
    this.clearRetryTimer(kbId)
    this.snapshots.delete(kbId)
    await this.persistSnapshots()
    this.publishActivity()
    this.emit()
  }

  cleanup(): void {
    for (const kbId of this.retryTimers.keys()) {
      this.clearRetryTimer(kbId)
    }
    this.currentAbortController?.abort()
    this.currentAbortController = null
    this.subscribers.clear()
    this.activityRegistry.remove(RETRY_ACTIVITY_ID)
  }

  private async persistSnapshots(): Promise<void> {
    await writeLocalStorage(
      this.app,
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(this.snapshots)),
    )
    this.publishActivity()
    this.emit()
  }

  private scheduleRetry(
    kbId: string,
    options: RagIndexRunOptions,
    minDelayMs = 0,
  ): void {
    this.clearRetryTimer(kbId)
    const retryAt = this.snapshots.get(kbId)?.retryAt ?? Date.now()
    const delayMs = Math.max(retryAt - Date.now(), minDelayMs)
    this.armRetryTimer(kbId, options, delayMs)
  }

  private armRetryTimer(
    kbId: string,
    options: RagIndexRunOptions,
    delayMs: number,
  ): void {
    this.retryOptions.set(kbId, options)
    const timer = setTimeout(() => {
      this.retryTimers.delete(kbId)
      this.retryOptions.delete(kbId)
      // Retries re-enter the same FIFO as any other request — a retry never
      // bypasses another knowledge base's in-flight run.
      void this.run(kbId, options, 'automatic-retry').catch(
        (error: unknown) => {
          console.error('[YOLO] Failed to rerun scheduled RAG index:', error)
        },
      )
    }, delayMs)
    this.retryTimers.set(kbId, timer)
  }

  private clearRetryTimer(kbId: string): void {
    const timer = this.retryTimers.get(kbId)
    if (timer) clearTimeout(timer)
    this.retryTimers.delete(kbId)
    this.retryOptions.delete(kbId)
  }

  /** Single aggregate activity entry across every knowledge base: the active
   * run's own progress when one is running, otherwise a summary of whichever
   * bases are waiting on a retry or have failed. */
  private publishActivity(): void {
    if (!this.isRagEnabled()) {
      this.activityRegistry.remove(RETRY_ACTIVITY_ID)
      return
    }

    if (this.activeKbId) {
      const snapshot = this.snapshots.get(this.activeKbId) ?? defaultSnapshot()
      this.activityRegistry.upsert({
        id: RETRY_ACTIVITY_ID,
        kind: 'rag-index',
        title: this.buildActiveTitle(snapshot),
        detail: this.buildActiveDetail(snapshot),
        status: 'running',
        updatedAt: Date.now(),
        action: { type: 'open-knowledge-settings' },
      })
      return
    }

    const retrying = [...this.snapshots.values()].filter(
      (s) => s.status === 'retry_scheduled',
    )
    const failed = [...this.snapshots.values()].filter(
      (s) => s.status === 'failed',
    )
    if (retrying.length > 0) {
      this.activityRegistry.upsert({
        id: RETRY_ACTIVITY_ID,
        kind: 'rag-index',
        title: this.t('statusBar.ragAutoUpdateRunning', '知识库等待重试'),
        detail:
          retrying.length === 1
            ? (retrying[0].failureMessage ?? this.t('common.retry', '重试'))
            : this.t('settings.knowledgeBases.count', '{{n}} 个知识库').replace(
                '{{n}}',
                String(retrying.length),
              ),
        status: 'waiting',
        updatedAt: Date.now(),
        action: { type: 'open-knowledge-settings' },
      })
      return
    }
    if (failed.length > 0) {
      this.activityRegistry.upsert({
        id: RETRY_ACTIVITY_ID,
        kind: 'rag-index',
        title: this.t('statusBar.ragAutoUpdateFailed', '知识库索引失败'),
        detail:
          failed.length === 1
            ? (failed[0].failureMessage ??
              this.t(
                'statusBar.ragAutoUpdateFailedDetail',
                '最近一次后台同步失败，请稍后重试。',
              ))
            : this.t('settings.knowledgeBases.count', '{{n}} 个知识库').replace(
                '{{n}}',
                String(failed.length),
              ),
        status: 'failed',
        updatedAt: Date.now(),
        action: { type: 'open-knowledge-settings' },
      })
      return
    }
    this.activityRegistry.remove(RETRY_ACTIVITY_ID)
  }

  private buildActiveTitle(snapshot: RagIndexRunSnapshot): string {
    if (snapshot.mode === 'rebuild') {
      return this.t('notices.rebuildingIndex', '正在重建知识库索引')
    }
    return this.t('statusBar.ragAutoUpdateRunning', '知识库正在后台更新')
  }

  private buildActiveDetail(snapshot: RagIndexRunSnapshot): string {
    if (snapshot.waitingForRateLimit) {
      return this.t(
        'settings.rag.waitingRateLimit',
        'Waiting for rate limit to reset...',
      )
    }
    if (snapshot.currentFile) {
      return snapshot.currentFile
    }
    return this.t(
      'statusBar.ragAutoUpdateRunningDetail',
      '正在增量同步知识库索引。',
    )
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    for (const subscriber of this.subscribers) {
      subscriber(snapshot)
    }
  }
}
