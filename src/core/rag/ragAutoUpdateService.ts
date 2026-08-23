import { TAbstractFile, TFile, TFolder } from 'obsidian'

import {
  KnowledgeBase,
  YoloSettings,
} from '../../settings/schema/setting.types'
import { matchesIncludeExcludeScope } from '../../utils/scope-match'
import { isWithinYoloBaseDir } from '../paths/yoloPaths'
import {
  type AutomaticRetrySchedule,
  MAX_AUTOMATIC_RETRIES,
  getNextAutomaticRetry,
} from '../retry/limitedAutomaticRetry'

import { classifyRagIndexError } from './ragIndexErrors'

/**
 * Snapshot of pending vault changes the auto-updater wants reconciled.
 * `kind: 'all'` means the change set is too broad to enumerate (folder
 * rename/delete) and a vault-wide reconcile is required.
 */
export type AutoUpdateRunRequest =
  | { kind: 'all' }
  | { kind: 'paths'; paths: string[] }

type RagAutoUpdateWorkerDeps = {
  kbId: string
  getKnowledgeBase: () => KnowledgeBase | undefined
  getSettings: () => YoloSettings
  setSettings: (settings: YoloSettings) => Promise<boolean>
  runIndex: (request: AutoUpdateRunRequest) => Promise<void>
  getRetryCount: () => number
  markRetryScheduled: (input: {
    retryAt: number
    retryCount: number
    failureMessage?: string
  }) => Promise<void>
  clearRetryScheduled: () => Promise<void>
}

/**
 * Debounced, retrying auto-update state machine for one knowledge base.
 * `RagAutoUpdateService` below owns one of these per configured base — the
 * logic here is unchanged from the pre-multi-knowledge-base single-instance
 * version, just parameterized by `kbId` so each base's dirty paths, retry
 * backoff, and cooldown are entirely independent of every other base's.
 */
class RagAutoUpdateWorker {
  private static readonly EDIT_IDLE_WINDOW_MS = 5 * 60 * 1000
  private static readonly WINDOW_BLUR_GRACE_MS = 15 * 1000
  private static readonly SUCCESS_COOLDOWN_MS = 2 * 60 * 1000
  private static readonly RETRY_SCHEDULE = [
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
  ] as const satisfies AutomaticRetrySchedule

  private readonly deps: RagAutoUpdateWorkerDeps

  private autoUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private isAutoUpdating = false
  private pendingDirtyPaths = new Set<string>()
  private hasPendingChangesDuringRun = false
  private hasRecoveredRetry = false
  private requiresFullScan = false
  private lastRelevantEditAt: number | null = null
  private lastRunFinishedAt: number | null = null
  private lastRunError: string | null = null
  /** True while a transient-failure retry timer is pending (for onOnline). */
  private hasPendingTransientRetry = false

  constructor(deps: RagAutoUpdateWorkerDeps) {
    this.deps = deps
  }

  cleanup() {
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer)
      this.autoUpdateTimer = null
    }
    this.pendingDirtyPaths.clear()
    this.hasPendingChangesDuringRun = false
    this.hasRecoveredRetry = false
    this.requiresFullScan = false
    this.hasPendingTransientRetry = false
  }

  restoreRetryScheduled(retryAt?: number, minDelayMs = 0): void {
    const settings = this.deps.getSettings()
    if (!this.isAutoUpdateEnabled(settings)) return

    this.hasRecoveredRetry = true
    // A restored retry is a pending transient retry, so let onOnline() bring it
    // forward when connectivity returns.
    this.hasPendingTransientRetry = true
    const delayMs = Math.max(
      retryAt === undefined ? 0 : retryAt - Date.now(),
      minDelayMs,
    )
    this.scheduleAutoUpdate(delayMs)
  }

  onVaultFileChanged(
    file: TAbstractFile,
    changeType: 'create' | 'modify' | 'delete' | 'rename' = 'modify',
  ) {
    try {
      if (file instanceof TFile) {
        const settings = this.deps.getSettings()
        if (file.extension === 'md') {
          this.markDirty(file.path)
          return
        }
        if (
          file.extension === 'pdf' &&
          (settings.ragOptions.indexPdf ?? true)
        ) {
          this.markDirty(file.path)
        }
        return
      }

      if (
        file instanceof TFolder &&
        (changeType === 'rename' || changeType === 'delete')
      ) {
        this.markDirty(file.path, { requiresFullScan: true })
      }
    } catch {
      // Ignore unexpected file type changes during event handling.
    }
  }

  onVaultPathChanged(path: string, options?: { requiresFullScan?: boolean }) {
    this.markDirty(path, options)
  }

  onWindowBlur() {
    if (this.pendingDirtyPaths.size === 0 || this.isAutoUpdating) {
      return
    }

    const elapsedSinceEdit =
      this.lastRelevantEditAt === null
        ? Number.POSITIVE_INFINITY
        : Date.now() - this.lastRelevantEditAt

    if (elapsedSinceEdit < RagAutoUpdateWorker.WINDOW_BLUR_GRACE_MS) {
      return
    }

    this.scheduleAutoUpdate(0)
  }

  /**
   * Accelerator (not a gate): when connectivity is restored, bring forward a
   * retry that is currently waiting out its transient-failure backoff. Does
   * nothing for ordinary edit-debounce timers. The SUCCESS_COOLDOWN check in
   * runAutoUpdate still applies, so a retry within 2 min of the failed run is
   * deferred until the cooldown elapses (acceptable).
   */
  onOnline() {
    if (!this.hasPendingTransientRetry || this.isAutoUpdating) {
      return
    }
    this.scheduleAutoUpdate(0)
  }

  private isAutoUpdateEnabled(settings: YoloSettings): boolean {
    if (
      !settings?.ragOptions?.enabled ||
      !settings?.ragOptions?.autoUpdateEnabled
    ) {
      return false
    }
    if (!this.deps.getKnowledgeBase()) return false
    // Skip auto-update when no valid embedding model is configured so that
    // fresh installations don't immediately surface a confusing error.
    const id = settings.embeddingModelId
    if (!id || !settings.embeddingModels.some((m) => m.id === id)) {
      return false
    }
    return true
  }

  private markDirty(path: string, options?: { requiresFullScan?: boolean }) {
    const settings = this.deps.getSettings()
    if (!this.isAutoUpdateEnabled(settings)) return
    if (this.deps.getRetryCount() >= MAX_AUTOMATIC_RETRIES) return
    if (!options?.requiresFullScan && !this.isPathSelected(path, settings)) {
      return
    }

    this.pendingDirtyPaths.add(path)
    this.lastRelevantEditAt = Date.now()
    this.lastRunError = null

    if (options?.requiresFullScan) {
      this.requiresFullScan = true
    }

    if (this.isAutoUpdating) {
      this.hasPendingChangesDuringRun = true
      return
    }

    this.scheduleAutoUpdate(RagAutoUpdateWorker.EDIT_IDLE_WINDOW_MS)
  }

  private isPathSelected(path: string, settings: YoloSettings): boolean {
    const lower = path.toLowerCase()
    const isMd = lower.endsWith('.md')
    const isPdf =
      lower.endsWith('.pdf') && (settings.ragOptions.indexPdf ?? true)
    if (!isMd && !isPdf) {
      return false
    }
    if (isWithinYoloBaseDir(path, settings)) {
      return false
    }
    const kb = this.deps.getKnowledgeBase()
    if (!kb) return false
    return matchesIncludeExcludeScope(path, kb.include, kb.exclude)
  }

  private scheduleAutoUpdate(delayMs: number) {
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer)
    }

    this.autoUpdateTimer = setTimeout(() => {
      this.autoUpdateTimer = null
      void this.runAutoUpdate()
    }, delayMs)
  }

  private async runAutoUpdate() {
    if (this.isAutoUpdating) return
    if (
      this.pendingDirtyPaths.size === 0 &&
      !this.requiresFullScan &&
      !this.hasRecoveredRetry
    ) {
      return
    }

    if (
      this.lastRunFinishedAt !== null &&
      Date.now() - this.lastRunFinishedAt <
        RagAutoUpdateWorker.SUCCESS_COOLDOWN_MS
    ) {
      this.scheduleAutoUpdate(
        RagAutoUpdateWorker.SUCCESS_COOLDOWN_MS -
          (Date.now() - this.lastRunFinishedAt),
      )
      return
    }

    this.isAutoUpdating = true
    // The run is now consuming any pending transient retry; clear the flag so a
    // later onOnline during an ordinary debounce timer doesn't fast-forward it.
    this.hasPendingTransientRetry = false
    const pendingSnapshot = new Set(this.pendingDirtyPaths)
    const requiresFullScanSnapshot = this.requiresFullScan
    const recoveredRetrySnapshot = this.hasRecoveredRetry
    let hasScheduledTransientRetry = false
    let shouldRescheduleDirtyWork = false

    try {
      this.pendingDirtyPaths.clear()
      this.requiresFullScan = false
      this.hasPendingChangesDuringRun = false
      this.hasRecoveredRetry = false
      await this.deps.clearRetryScheduled()
      const request: AutoUpdateRunRequest =
        requiresFullScanSnapshot || recoveredRetrySnapshot
          ? { kind: 'all' }
          : { kind: 'paths', paths: [...pendingSnapshot] }
      await this.deps.runIndex(request)
      const settings = this.deps.getSettings()
      await this.deps.setSettings({
        ...settings,
        ragOptions: {
          ...settings.ragOptions,
          lastAutoUpdateAt: Date.now(),
        },
      })
      this.lastRunFinishedAt = Date.now()
      this.lastRunError = null
    } catch (e) {
      console.error('Auto update index failed:', e)
      this.lastRunFinishedAt = Date.now()
      this.lastRunError = e instanceof Error ? e.message : String(e)
      for (const path of pendingSnapshot) {
        this.pendingDirtyPaths.add(path)
      }
      this.requiresFullScan = this.requiresFullScan || requiresFullScanSnapshot
      const failureKind = classifyRagIndexError(e)
      // Was this run a vault-wide ('all') reconcile? If so, the retry MUST stay
      // 'all' — degrading to paths-only would drop files that the full scan
      // (incl. transient rollbacks from VectorManager) touched but that aren't
      // in pendingSnapshot, stranding their 0-row state until the next edit.
      const wasAllScope = requiresFullScanSnapshot || recoveredRetrySnapshot

      if (failureKind === 'transient') {
        const nextRetry = this.isAutoUpdateEnabled(this.deps.getSettings())
          ? getNextAutomaticRetry(
              this.deps.getRetryCount(),
              RagAutoUpdateWorker.RETRY_SCHEDULE,
            )
          : null
        if (!nextRetry) {
          return
        }
        const retryAt = Date.now() + nextRetry.delayMs
        if (wasAllScope) {
          // Keep next run vault-wide. Reuse requiresFullScan when the original
          // 'all' came from a folder rename/delete; otherwise carry the
          // recovered-retry flag forward.
          if (requiresFullScanSnapshot) {
            this.requiresFullScan = true
          } else {
            this.hasRecoveredRetry = true
          }
        } else {
          // 'paths' scope: pendingSnapshot was already restored above.
          this.hasRecoveredRetry = false
        }
        await this.deps.markRetryScheduled({
          retryAt,
          retryCount: nextRetry.retryCount,
          failureMessage: this.lastRunError,
        })
        this.scheduleAutoUpdate(nextRetry.delayMs)
        hasScheduledTransientRetry = true
        this.hasPendingTransientRetry = true
      } else if (failureKind === 'aborted') {
        shouldRescheduleDirtyWork = true
      } else {
        // Permanent / unknown failures are terminal until the user retries.
      }
    } finally {
      this.isAutoUpdating = false
      if (!hasScheduledTransientRetry) {
        this.autoUpdateTimer = null
      }
      if (
        !hasScheduledTransientRetry &&
        (shouldRescheduleDirtyWork || this.hasPendingChangesDuringRun)
      ) {
        this.scheduleAutoUpdate(RagAutoUpdateWorker.EDIT_IDLE_WINDOW_MS)
      }
    }
  }
}

type RagAutoUpdateServiceDeps = {
  getSettings: () => YoloSettings
  setSettings: (settings: YoloSettings) => Promise<boolean>
  runIndex: (kbId: string, request: AutoUpdateRunRequest) => Promise<void>
  getRetryCount: (kbId: string) => number
  markRetryScheduled: (
    kbId: string,
    input: { retryAt: number; retryCount: number; failureMessage?: string },
  ) => Promise<void>
  clearRetryScheduled: (kbId: string) => Promise<void>
}

/**
 * Fans every vault-change/lifecycle event out to one `RagAutoUpdateWorker`
 * per configured knowledge base — each base debounces, retries, and cools
 * down entirely independently, since each has its own include/exclude scope
 * and its own index run queue slot (`RagIndexService`'s FIFO still ensures
 * only one base's *index run* executes at a time; the workers here only
 * decide *when to ask* for one).
 */
export class RagAutoUpdateService {
  private readonly deps: RagAutoUpdateServiceDeps
  private readonly workers = new Map<string, RagAutoUpdateWorker>()

  constructor(deps: RagAutoUpdateServiceDeps) {
    this.deps = deps
  }

  private getOrCreateWorker(kbId: string): RagAutoUpdateWorker {
    const existing = this.workers.get(kbId)
    if (existing) return existing
    const worker = new RagAutoUpdateWorker({
      kbId,
      getKnowledgeBase: () =>
        this.deps.getSettings().knowledgeBases.find((kb) => kb.id === kbId),
      getSettings: this.deps.getSettings,
      setSettings: this.deps.setSettings,
      runIndex: (request) => this.deps.runIndex(kbId, request),
      getRetryCount: () => this.deps.getRetryCount(kbId),
      markRetryScheduled: (input) => this.deps.markRetryScheduled(kbId, input),
      clearRetryScheduled: () => this.deps.clearRetryScheduled(kbId),
    })
    this.workers.set(kbId, worker)
    return worker
  }

  /** Prunes workers for knowledge bases no longer in settings and lazily
   * creates workers for newly-added ones. Called before any fan-out so the
   * worker set always matches current settings. */
  private syncWorkers(): void {
    const currentIds = new Set(
      this.deps.getSettings().knowledgeBases.map((kb) => kb.id),
    )
    for (const [kbId, worker] of this.workers) {
      if (!currentIds.has(kbId)) {
        worker.cleanup()
        this.workers.delete(kbId)
      }
    }
    for (const kbId of currentIds) {
      this.getOrCreateWorker(kbId)
    }
  }

  cleanup() {
    for (const worker of this.workers.values()) {
      worker.cleanup()
    }
    this.workers.clear()
  }

  /** Called once per knowledge base at startup, from the persisted index-run
   * snapshot's own `retryAt`/`trigger` for that base. */
  restoreRetryScheduled(kbId: string, retryAt?: number, minDelayMs = 0): void {
    this.getOrCreateWorker(kbId).restoreRetryScheduled(retryAt, minDelayMs)
  }

  onVaultFileChanged(
    file: TAbstractFile,
    changeType: 'create' | 'modify' | 'delete' | 'rename' = 'modify',
  ) {
    this.syncWorkers()
    for (const worker of this.workers.values()) {
      worker.onVaultFileChanged(file, changeType)
    }
  }

  onVaultPathChanged(path: string, options?: { requiresFullScan?: boolean }) {
    this.syncWorkers()
    for (const worker of this.workers.values()) {
      worker.onVaultPathChanged(path, options)
    }
  }

  onWindowBlur() {
    for (const worker of this.workers.values()) {
      worker.onWindowBlur()
    }
  }

  onOnline() {
    for (const worker of this.workers.values()) {
      worker.onOnline()
    }
  }
}
