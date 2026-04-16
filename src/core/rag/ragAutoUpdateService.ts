import { minimatch } from 'minimatch'
import { TAbstractFile, TFile, TFolder } from 'obsidian'

import { SmartComposerSettings } from '../../settings/schema/setting.types'
import { classifyRagIndexError } from './ragIndexErrors'

type RagAutoUpdateServiceDeps = {
  getSettings: () => SmartComposerSettings
  setSettings: (settings: SmartComposerSettings) => Promise<void>
  runIndex: () => Promise<void>
  markRetryScheduled: (input: {
    retryAt: number
    failureMessage?: string
  }) => Promise<void>
  clearRetryScheduled: () => Promise<void>
}

export class RagAutoUpdateService {
  private static readonly EDIT_IDLE_WINDOW_MS = 5 * 60 * 1000
  private static readonly WINDOW_BLUR_GRACE_MS = 15 * 1000
  private static readonly SUCCESS_COOLDOWN_MS = 2 * 60 * 1000
  private static readonly FAILURE_RETRY_DELAY_MS = 5 * 60 * 1000

  private readonly getSettings: () => SmartComposerSettings
  private readonly setSettings: (
    settings: SmartComposerSettings,
  ) => Promise<void>
  private readonly runIndex: () => Promise<void>
  private readonly markRetryScheduled: (
    input: { retryAt: number; failureMessage?: string },
  ) => Promise<void>
  private readonly clearRetryScheduled: () => Promise<void>

  private autoUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private isAutoUpdating = false
  private pendingDirtyPaths = new Set<string>()
  private hasPendingChangesDuringRun = false
  private hasRecoveredRetry = false
  private requiresFullScan = false
  private lastRelevantEditAt: number | null = null
  private lastRunFinishedAt: number | null = null
  private lastRunError: string | null = null

  constructor(deps: RagAutoUpdateServiceDeps) {
    this.getSettings = deps.getSettings
    this.setSettings = deps.setSettings
    this.runIndex = deps.runIndex
    this.markRetryScheduled = deps.markRetryScheduled
    this.clearRetryScheduled = deps.clearRetryScheduled
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
  }

  restoreRetryScheduled(retryAt?: number): void {
    const settings = this.getSettings()
    if (!this.isAutoUpdateEnabled(settings)) return

    this.hasRecoveredRetry = true
    const delayMs =
      retryAt === undefined ? 0 : Math.max(0, retryAt - Date.now())
    this.scheduleAutoUpdate(delayMs)
  }

  onVaultFileChanged(
    file: TAbstractFile,
    changeType: 'create' | 'modify' | 'delete' | 'rename' = 'modify',
  ) {
    try {
      if (file instanceof TFile) {
        if (file.extension !== 'md') {
          return
        }
        this.markDirty(file.path)
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

    if (elapsedSinceEdit < RagAutoUpdateService.WINDOW_BLUR_GRACE_MS) {
      return
    }

    this.scheduleAutoUpdate(0)
  }

  private isAutoUpdateEnabled(settings: SmartComposerSettings): boolean {
    if (!settings?.ragOptions?.enabled || !settings?.ragOptions?.autoUpdateEnabled) {
      return false
    }
    // Skip auto-update when no valid embedding model is configured so that
    // fresh installations don't immediately surface a confusing error.
    const id = settings.embeddingModelId
    if (!id || !settings.embeddingModels.some((m) => m.id === id)) {
      return false
    }
    return true
  }

  private markDirty(path: string, options?: { requiresFullScan?: boolean }) {
    const settings = this.getSettings()
    if (!this.isAutoUpdateEnabled(settings)) return
    if (
      !options?.requiresFullScan &&
      !this.isPathSelectedByIncludeExclude(path, settings)
    ) {
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

    this.scheduleAutoUpdate(RagAutoUpdateService.EDIT_IDLE_WINDOW_MS)
  }

  private isPathSelectedByIncludeExclude(
    path: string,
    settings: SmartComposerSettings,
  ): boolean {
    if (!path.toLowerCase().endsWith('.md')) {
      return false
    }
    const { includePatterns = [], excludePatterns = [] } =
      settings?.ragOptions ?? {}
    if (excludePatterns.some((p) => minimatch(path, p))) return false
    if (!includePatterns || includePatterns.length === 0) return true
    return includePatterns.some((p) => minimatch(path, p))
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
        RagAutoUpdateService.SUCCESS_COOLDOWN_MS
    ) {
      this.scheduleAutoUpdate(
        RagAutoUpdateService.SUCCESS_COOLDOWN_MS -
          (Date.now() - this.lastRunFinishedAt),
      )
      return
    }

    this.isAutoUpdating = true
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
      await this.clearRetryScheduled()
      await this.runIndex()
      const settings = this.getSettings()
      await this.setSettings({
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

      if (failureKind === 'transient') {
        const retryAt = Date.now() + RagAutoUpdateService.FAILURE_RETRY_DELAY_MS
        this.hasRecoveredRetry =
          recoveredRetrySnapshot &&
          pendingSnapshot.size === 0 &&
          !requiresFullScanSnapshot
        await this.markRetryScheduled({
          retryAt,
          failureMessage: this.lastRunError,
        })
        this.scheduleAutoUpdate(RagAutoUpdateService.FAILURE_RETRY_DELAY_MS)
        hasScheduledTransientRetry = true
      } else if (failureKind === 'aborted') {
        shouldRescheduleDirtyWork = true
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
        this.scheduleAutoUpdate(RagAutoUpdateService.EDIT_IDLE_WINDOW_MS)
      }
    }
  }
}
