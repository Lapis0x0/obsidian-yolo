import { minimatch } from 'minimatch'
import { TAbstractFile, TFile, TFolder } from 'obsidian'

import {
  BackgroundActivityRegistry,
  type BackgroundActivityStatus,
} from '../background/backgroundActivityRegistry'
import { SmartComposerSettings } from '../../settings/schema/setting.types'

import { RAGEngine } from './ragEngine'

type RagAutoUpdateServiceDeps = {
  getSettings: () => SmartComposerSettings
  setSettings: (settings: SmartComposerSettings) => Promise<void>
  getRagEngine: () => Promise<RAGEngine>
  t: (key: string, fallback?: string) => string
  activityRegistry: BackgroundActivityRegistry
}

export class RagAutoUpdateService {
  private static readonly EDIT_IDLE_WINDOW_MS = 5 * 60 * 1000
  private static readonly WINDOW_BLUR_GRACE_MS = 15 * 1000
  private static readonly SUCCESS_COOLDOWN_MS = 2 * 60 * 1000
  private static readonly ACTIVITY_ID = 'rag:auto-update'

  private readonly getSettings: () => SmartComposerSettings
  private readonly setSettings: (
    settings: SmartComposerSettings,
  ) => Promise<void>
  private readonly getRagEngine: () => Promise<RAGEngine>
  private readonly t: (key: string, fallback?: string) => string
  private readonly activityRegistry: BackgroundActivityRegistry

  private autoUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private isAutoUpdating = false
  private pendingDirtyPaths = new Set<string>()
  private hasPendingChangesDuringRun = false
  private requiresFullScan = false
  private lastRelevantEditAt: number | null = null
  private lastRunFinishedAt: number | null = null
  private lastRunError: string | null = null

  constructor(deps: RagAutoUpdateServiceDeps) {
    this.getSettings = deps.getSettings
    this.setSettings = deps.setSettings
    this.getRagEngine = deps.getRagEngine
    this.t = deps.t
    this.activityRegistry = deps.activityRegistry
  }

  cleanup() {
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer)
      this.autoUpdateTimer = null
    }
    this.pendingDirtyPaths.clear()
    this.hasPendingChangesDuringRun = false
    this.requiresFullScan = false
    this.activityRegistry.remove(RagAutoUpdateService.ACTIVITY_ID)
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

  private markDirty(path: string, options?: { requiresFullScan?: boolean }) {
    const settings = this.getSettings()
    if (!settings?.ragOptions?.enabled) return
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
    if (this.pendingDirtyPaths.size === 0 && !this.requiresFullScan) {
      this.activityRegistry.remove(RagAutoUpdateService.ACTIVITY_ID)
      return
    }

    if (
      this.lastRunFinishedAt !== null &&
      Date.now() - this.lastRunFinishedAt < RagAutoUpdateService.SUCCESS_COOLDOWN_MS
    ) {
      this.scheduleAutoUpdate(
        RagAutoUpdateService.SUCCESS_COOLDOWN_MS -
          (Date.now() - this.lastRunFinishedAt),
      )
      return
    }

    this.isAutoUpdating = true
    this.publishActivity('running')

    try {
      this.pendingDirtyPaths.clear()
      this.requiresFullScan = false
      this.hasPendingChangesDuringRun = false
      const ragEngine = await this.getRagEngine()
      await ragEngine.updateVaultIndex({ reindexAll: false }, undefined)
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
      this.activityRegistry.remove(RagAutoUpdateService.ACTIVITY_ID)
    } catch (e) {
      console.error('Auto update index failed:', e)
      this.lastRunFinishedAt = Date.now()
      this.lastRunError = e instanceof Error ? e.message : String(e)
      this.publishActivity('failed')
    } finally {
      this.isAutoUpdating = false
      this.autoUpdateTimer = null
      if (
        this.hasPendingChangesDuringRun ||
        this.pendingDirtyPaths.size > 0 ||
        this.requiresFullScan
      ) {
        this.scheduleAutoUpdate(RagAutoUpdateService.EDIT_IDLE_WINDOW_MS)
      }
    }
  }

  private publishActivity(status: BackgroundActivityStatus) {
    const title =
      status === 'failed'
        ? this.t('statusBar.ragAutoUpdateFailed', '知识库自动更新失败')
        : this.t('statusBar.ragAutoUpdateRunning', '知识库正在后台更新')

    const detail =
      status === 'failed'
          ? this.lastRunError ??
            this.t(
              'statusBar.ragAutoUpdateFailedDetail',
              '最近一次后台同步失败，请稍后重试。',
            )
          : this.t(
              'statusBar.ragAutoUpdateRunningDetail',
              '正在增量同步知识库索引。',
            )

    this.activityRegistry.upsert({
      id: RagAutoUpdateService.ACTIVITY_ID,
      kind: 'rag-index',
      title,
      detail,
      status,
      updatedAt: Date.now(),
      action: { type: 'open-knowledge-settings' },
    })
  }
}
