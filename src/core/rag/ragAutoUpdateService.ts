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
  private readonly getSettings: () => SmartComposerSettings
  private readonly setSettings: (
    settings: SmartComposerSettings,
  ) => Promise<void>
  private readonly getRagEngine: () => Promise<RAGEngine>
  private readonly t: (key: string, fallback?: string) => string

  private autoUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private isAutoUpdating = false

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
    if (!settings?.ragOptions?.autoUpdateEnabled) return
    if (!this.isPathSelectedByIncludeExclude(path, settings)) return

    const intervalMs =
      (settings.ragOptions.autoUpdateIntervalHours ?? 24) * 60 * 60 * 1000
    const last = settings.ragOptions.lastAutoUpdateAt ?? 0
    const now = Date.now()
    if (now - last < intervalMs) {
      return
    }

    if (this.autoUpdateTimer) clearTimeout(this.autoUpdateTimer)
    this.autoUpdateTimer = setTimeout(() => void this.runAutoUpdate(), 3000)
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
    this.isAutoUpdating = true
    try {
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
    }
  }
}
