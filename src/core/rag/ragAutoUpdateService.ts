import { minimatch } from 'minimatch'
import { Notice, TAbstractFile, TFile, TFolder } from 'obsidian'

import { SmartComposerSettings } from '../../settings/schema/setting.types'

import { RAGEngine } from './ragEngine'

type RagAutoUpdateServiceDeps = {
  getSettings: () => SmartComposerSettings
  setSettings: (settings: SmartComposerSettings) => Promise<void>
  getRagEngine: () => Promise<RAGEngine>
  t: (key: string, fallback?: string) => string
}

export class RagAutoUpdateService {
  private static readonly EDIT_IDLE_WINDOW_MS = 60 * 1000

  private readonly getSettings: () => SmartComposerSettings
  private readonly setSettings: (
    settings: SmartComposerSettings,
  ) => Promise<void>
  private readonly getRagEngine: () => Promise<RAGEngine>
  private readonly t: (key: string, fallback?: string) => string

  private autoUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private isAutoUpdating = false
  private pendingDirtyPaths = new Set<string>()

  constructor(deps: RagAutoUpdateServiceDeps) {
    this.getSettings = deps.getSettings
    this.setSettings = deps.setSettings
    this.getRagEngine = deps.getRagEngine
    this.t = deps.t
  }

  cleanup() {
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer)
      this.autoUpdateTimer = null
    }
    this.pendingDirtyPaths.clear()
  }

  onVaultFileChanged(file: TAbstractFile) {
    try {
      if (file instanceof TFile || file instanceof TFolder) {
        this.onVaultPathChanged(file.path)
      }
    } catch {
      // Ignore unexpected file type changes during event handling.
    }
  }

  onVaultPathChanged(path: string) {
    const settings = this.getSettings()
    if (!settings?.ragOptions?.enabled) return
    if (!this.isPathSelectedByIncludeExclude(path, settings)) return
    this.pendingDirtyPaths.add(path)

    if (this.autoUpdateTimer) clearTimeout(this.autoUpdateTimer)
    this.autoUpdateTimer = setTimeout(
      () => void this.runAutoUpdate(),
      RagAutoUpdateService.EDIT_IDLE_WINDOW_MS,
    )
  }

  private isPathSelectedByIncludeExclude(
    path: string,
    settings: SmartComposerSettings,
  ): boolean {
    const { includePatterns = [], excludePatterns = [] } =
      settings?.ragOptions ?? {}
    if (excludePatterns.some((p) => minimatch(path, p))) return false
    if (!includePatterns || includePatterns.length === 0) return true
    return includePatterns.some((p) => minimatch(path, p))
  }

  private async runAutoUpdate() {
    if (this.isAutoUpdating) return
    if (this.pendingDirtyPaths.size === 0) return
    this.isAutoUpdating = true
    try {
      this.pendingDirtyPaths.clear()
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
      new Notice(this.t('notices.indexUpdated'))
    } catch (e) {
      console.error('Auto update index failed:', e)
      new Notice(this.t('notices.indexUpdateFailed'))
    } finally {
      this.isAutoUpdating = false
      this.autoUpdateTimer = null
      if (this.pendingDirtyPaths.size > 0) {
        this.autoUpdateTimer = setTimeout(
          () => void this.runAutoUpdate(),
          RagAutoUpdateService.EDIT_IDLE_WINDOW_MS,
        )
      }
    }
  }
}
