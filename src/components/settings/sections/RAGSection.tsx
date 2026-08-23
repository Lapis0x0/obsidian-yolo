import { App, Notice } from 'obsidian'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { RECOMMENDED_MODELS_FOR_EMBEDDING } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { getYoloBaseDir } from '../../../core/paths/yoloPaths'
import {
  RagIndexBusyError,
  type RagIndexRunSnapshot,
} from '../../../core/rag/ragIndexService'
import YoloPlugin from '../../../main'
import { IndexProgress } from '../../chat-view/QueryProgress'
import { ObsidianButton } from '../../common/ObsidianButton'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { IndexProgressRing } from '../IndexProgressRing'
import { EmbeddingDbManageModal } from '../modals/EmbeddingDbManageModal'
import {
  type ScopeRule,
  defaultRagScopeRules,
  ragOptionsFromRules,
  rulesFromRagOptions,
} from '../scope/scopeRules'
import { ScopeSummary } from '../scope/ScopeSummary'
import { collectScopeCandidateFiles } from '../scope/scopeVault'

type RAGSectionProps = {
  app: App
  plugin: YoloPlugin
}

type IndexJob = {
  mode: 'rebuild' | 'sync'
  successNotice?: string
  failureNotice: string
}

const snapshotToProgress = (
  snapshot: RagIndexRunSnapshot,
): IndexProgress | null => {
  if (
    snapshot.totalFiles === undefined &&
    snapshot.totalChunks === undefined &&
    !snapshot.currentFile
  ) {
    return null
  }

  return {
    completedChunks: snapshot.completedChunks ?? 0,
    totalChunks: snapshot.totalChunks ?? 0,
    totalFiles: snapshot.totalFiles ?? 0,
    completedFiles: snapshot.completedFiles ?? 0,
    currentFile: snapshot.currentFile,
    waitingForRateLimit: snapshot.waitingForRateLimit,
  }
}

function RAGCard({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="yolo-rag-card">
      <div className="yolo-rag-card-header">
        <div className="yolo-rag-card-header-copy">
          <div className="yolo-rag-card-title">{title}</div>
          {description ? (
            <div className="yolo-rag-card-description">{description}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="yolo-rag-card-actions">{actions}</div>
        ) : null}
      </div>
      <div className="yolo-rag-card-body">{children}</div>
    </section>
  )
}

export function RAGSection({ app, plugin }: RAGSectionProps) {
  const FILE_SWITCH_ANIMATION_MS = 120
  const FILE_SWITCH_MIN_INTERVAL_MS = 90
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [indexRunSnapshot, setIndexRunSnapshot] = useState<RagIndexRunSnapshot>(
    () => plugin.getRagIndexSnapshot(),
  )
  const [displayedCurrentFile, setDisplayedCurrentFile] = useState<
    string | null
  >(null)
  const [leavingCurrentFile, setLeavingCurrentFile] = useState<string | null>(
    null,
  )
  const [fileAnimationKey, setFileAnimationKey] = useState(0)
  const isRagEnabled = settings.ragOptions.enabled ?? true
  const isAutoUpdateEnabled = settings.ragOptions.autoUpdateEnabled ?? true
  const isIndexPdfEnabled = settings.ragOptions.indexPdf ?? true
  const isIndexing = indexRunSnapshot.status === 'running'
  const progressSource = useMemo(
    () => snapshotToProgress(indexRunSnapshot),
    [indexRunSnapshot],
  )
  const ragUpdateError = 'Failed to update RAG settings.'
  const [chunkSizeInput, setChunkSizeInput] = useState(
    String(settings.ragOptions.chunkSize),
  )
  const [minSimilarityInput, setMinSimilarityInput] = useState(
    String(settings.ragOptions.minSimilarity),
  )
  const [limitInput, setLimitInput] = useState(
    String(settings.ragOptions.limit),
  )
  const [embeddingConcurrencyInput, setEmbeddingConcurrencyInput] = useState(
    String(settings.ragOptions.embeddingConcurrency ?? 10),
  )
  const [showAdvancedRagSettings, setShowAdvancedRagSettings] = useState(false)
  const [permanentFailuresExpanded, setPermanentFailuresExpanded] =
    useState(false)
  const syncInputsRef = useRef<{
    enabled: boolean
    embeddingModelId: string
    chunkSize: number
    indexPdf: boolean
    includePatternsKey: string
    excludePatternsKey: string
    yoloExcludeKey: string
  } | null>(null)
  const scheduledIndexJobRef = useRef<IndexJob | null>(null)
  const queuedIndexJobRef = useRef<IndexJob | null>(null)
  const scheduledIndexJobTimerRef = useRef<number | null>(null)
  const fileAnimationTimerRef = useRef<number | null>(null)
  const fileSwitchTimerRef = useRef<number | null>(null)
  const pendingCurrentFileRef = useRef<string | null>(null)
  const lastFileSwitchAtRef = useRef(0)

  useEffect(() => {
    setChunkSizeInput(String(settings.ragOptions.chunkSize))
  }, [settings.ragOptions.chunkSize])

  useEffect(() => {
    setMinSimilarityInput(String(settings.ragOptions.minSimilarity))
  }, [settings.ragOptions.minSimilarity])

  useEffect(() => {
    setLimitInput(String(settings.ragOptions.limit))
  }, [settings.ragOptions.limit])

  useEffect(() => {
    setEmbeddingConcurrencyInput(
      String(settings.ragOptions.embeddingConcurrency ?? 10),
    )
  }, [settings.ragOptions.embeddingConcurrency])

  const applySettingsUpdate = useCallback(
    (nextSettings: typeof settings, errorMessage: string = ragUpdateError) => {
      void (async () => {
        try {
          await setSettings(nextSettings)
        } catch (error: unknown) {
          console.error('[YOLO] ' + errorMessage, error)
          new Notice(errorMessage)
        }
      })()
    },
    [setSettings],
  )

  const parseIntegerInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^\d+$/.test(trimmed)) return null
    return parseInt(trimmed, 10)
  }

  const parseFloatInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^\d*(?:[.,]\d*)?$/.test(trimmed)) return null
    if (
      trimmed === '.' ||
      trimmed === ',' ||
      trimmed.endsWith('.') ||
      trimmed.endsWith(',')
    ) {
      return null
    }
    const normalized = trimmed.includes(',')
      ? trimmed.split(',').join('.')
      : trimmed
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }

  useEffect(() => {
    return plugin.subscribeToRagIndexRuns((snapshot) => {
      setIndexRunSnapshot(snapshot)
    })
  }, [plugin])

  useEffect(() => {
    const applyDisplayedFile = (nextFile: string) => {
      if (fileAnimationTimerRef.current !== null) {
        window.clearTimeout(fileAnimationTimerRef.current)
        fileAnimationTimerRef.current = null
      }

      setLeavingCurrentFile(displayedCurrentFile)
      setDisplayedCurrentFile(nextFile)
      setFileAnimationKey((prev) => prev + 1)
      lastFileSwitchAtRef.current = Date.now()

      if (!displayedCurrentFile) {
        return
      }

      fileAnimationTimerRef.current = window.setTimeout(() => {
        fileAnimationTimerRef.current = null
        setLeavingCurrentFile(null)
      }, FILE_SWITCH_ANIMATION_MS)
    }

    if (!isIndexing) {
      if (fileAnimationTimerRef.current !== null) {
        window.clearTimeout(fileAnimationTimerRef.current)
        fileAnimationTimerRef.current = null
      }
      if (fileSwitchTimerRef.current !== null) {
        window.clearTimeout(fileSwitchTimerRef.current)
        fileSwitchTimerRef.current = null
      }
      pendingCurrentFileRef.current = null
      lastFileSwitchAtRef.current = 0
      setDisplayedCurrentFile(null)
      setLeavingCurrentFile(null)
      return
    }

    const nextFile = progressSource?.currentFile?.trim()
    if (!nextFile) {
      return
    }

    if (nextFile === displayedCurrentFile) {
      return
    }

    const elapsed = Date.now() - lastFileSwitchAtRef.current
    const shouldDelay =
      displayedCurrentFile !== null && elapsed < FILE_SWITCH_MIN_INTERVAL_MS

    if (shouldDelay) {
      pendingCurrentFileRef.current = nextFile
      if (fileSwitchTimerRef.current !== null) {
        return
      }
      fileSwitchTimerRef.current = window.setTimeout(() => {
        fileSwitchTimerRef.current = null
        const pendingFile = pendingCurrentFileRef.current
        pendingCurrentFileRef.current = null
        if (!pendingFile || pendingFile === displayedCurrentFile) {
          return
        }
        applyDisplayedFile(pendingFile)
      }, FILE_SWITCH_MIN_INTERVAL_MS - elapsed)
      return
    }

    pendingCurrentFileRef.current = null
    if (fileSwitchTimerRef.current !== null) {
      window.clearTimeout(fileSwitchTimerRef.current)
      fileSwitchTimerRef.current = null
    }
    applyDisplayedFile(nextFile)
  }, [
    FILE_SWITCH_ANIMATION_MS,
    FILE_SWITCH_MIN_INTERVAL_MS,
    displayedCurrentFile,
    isIndexing,
    progressSource,
  ])

  useEffect(() => {
    return () => {
      if (fileAnimationTimerRef.current !== null) {
        window.clearTimeout(fileAnimationTimerRef.current)
      }
      if (fileSwitchTimerRef.current !== null) {
        window.clearTimeout(fileSwitchTimerRef.current)
      }
    }
  }, [])

  const ringPercent = useMemo(() => {
    // After a sync that only deleted rows (e.g. user removed an include
    // folder), the run reports totalChunks=0 with status='completed'. Treat
    // that as 100% so the UI shows "索引已完成" instead of a stale 0%.
    if (
      !isIndexing &&
      indexRunSnapshot.status === 'completed' &&
      (progressSource?.totalChunks ?? 0) === 0
    ) {
      return 100
    }
    // Percent is file-based: totalFiles is known up front (unlike totalChunks,
    // which now only reflects chunks discovered so far and isn't a stable
    // denominator once reconcile streams by file batch). Fall back to the
    // chunk formula only when totalFiles is unavailable (e.g. legacy
    // snapshots without file counts).
    if (progressSource && (progressSource.totalFiles ?? 0) > 0) {
      const pct = Math.round(
        ((progressSource.completedFiles ?? 0) / progressSource.totalFiles) *
          100,
      )
      return Math.max(0, Math.min(100, pct))
    }
    if (!progressSource || progressSource.totalChunks <= 0) {
      return 0
    }
    const pct = Math.round(
      (progressSource.completedChunks / progressSource.totalChunks) * 100,
    )
    return Math.max(0, Math.min(100, pct))
  }, [indexRunSnapshot.status, isIndexing, progressSource])

  const maintenanceStatusLine = useMemo(() => {
    if (isIndexing) {
      if (!progressSource) {
        return t('settings.rag.preparingProgress', 'Preparing index...')
      }
      if (progressSource.waitingForRateLimit) {
        return t(
          'settings.rag.waitingRateLimit',
          'Waiting for rate limit to reset...',
        )
      }
      if (displayedCurrentFile) {
        return displayedCurrentFile
      }
      if (!progressSource.totalChunks) {
        return t('settings.rag.preparingProgress', 'Preparing index...')
      }
      return `${ringPercent}% ${t('settings.rag.indexing', 'Indexing...')}`
    }
    if (indexRunSnapshot.status === 'retry_scheduled') {
      const base = t('settings.rag.waitingRetry', '等待重试中...')
      return indexRunSnapshot.failureMessage
        ? `${base} · ${indexRunSnapshot.failureMessage}`
        : base
    }
    if (indexRunSnapshot.status === 'failed') {
      const prefix = indexRunSnapshot.failureHttpStatus
        ? `HTTP ${indexRunSnapshot.failureHttpStatus} · `
        : ''
      return (
        prefix +
        (indexRunSnapshot.failureMessage ??
          t('settings.rag.indexIncomplete', 'Last index did not finish'))
      )
    }
    // A completed run wins over the 0% fallback — covers the "deletion-only"
    // sync case where progressSource has totalChunks=0 but the run succeeded.
    if (indexRunSnapshot.status === 'completed') {
      return `100% ${t('settings.rag.indexComplete', 'Index complete')}`
    }
    if (!progressSource) {
      return t('settings.rag.notIndexedYet', 'Not indexed yet')
    }
    if (ringPercent >= 100) {
      return `${ringPercent}% ${t('settings.rag.indexComplete', 'Index complete')}`
    }
    if (ringPercent > 0) {
      return `${ringPercent}% ${t(
        'settings.rag.indexIncomplete',
        'Last index did not finish',
      )}`
    }
    return t('settings.rag.notIndexedYet', 'Not indexed yet')
  }, [
    indexRunSnapshot.failureHttpStatus,
    indexRunSnapshot.failureMessage,
    indexRunSnapshot.status,
    isIndexing,
    displayedCurrentFile,
    progressSource,
    ringPercent,
    t,
  ])

  const maintenanceStatusKey = useMemo(() => {
    if (isIndexing) {
      if (!progressSource) {
        return 'preparing'
      }
      if (progressSource.waitingForRateLimit) {
        return 'rate-limit'
      }
      if (displayedCurrentFile) {
        return displayedCurrentFile
      }
      return 'indexing'
    }
    if (indexRunSnapshot.status === 'retry_scheduled') {
      return 'retry-scheduled'
    }
    if (indexRunSnapshot.status === 'failed') {
      return 'failed'
    }
    return `idle-${ringPercent}`
  }, [
    indexRunSnapshot.status,
    isIndexing,
    displayedCurrentFile,
    progressSource,
    ringPercent,
  ])

  const isAnimatingCurrentFile = Boolean(isIndexing && displayedCurrentFile)
  const maintenanceStatusPrefix = isAnimatingCurrentFile
    ? `${ringPercent}%`
    : null

  // Files that completed but could not be indexed permanently. Surfaced as a
  // durable, expandable line under the maintenance status (no modal, no Notice
  // for the background path) until the next clean completion clears the field.
  const permanentFailedPaths = useMemo(
    () =>
      !isIndexing && indexRunSnapshot.status === 'completed'
        ? (indexRunSnapshot.permanentFailedPaths ?? [])
        : [],
    [
      isIndexing,
      indexRunSnapshot.status,
      indexRunSnapshot.permanentFailedPaths,
    ],
  )

  const yoloBaseDir = useMemo(() => getYoloBaseDir(settings), [settings])

  // The YOLO folder's dedicated flag is surfaced as an ordinary exclude rule,
  // so the editor only ever deals with one flat rule list.
  const scopeRules = useMemo(
    () => rulesFromRagOptions(settings.ragOptions, yoloBaseDir),
    [settings.ragOptions, yoloBaseDir],
  )
  const defaultScopeRules = useMemo(
    () => defaultRagScopeRules(yoloBaseDir),
    [yoloBaseDir],
  )

  const scopeCandidateFiles = useMemo(
    () =>
      collectScopeCandidateFiles(
        plugin.app.vault,
        isIndexPdfEnabled ? ['md', 'pdf'] : ['md'],
      ),
    [plugin.app.vault, isIndexPdfEnabled],
  )

  const handleScopeChange = useCallback(
    (nextRules: ScopeRule[]) => {
      applySettingsUpdate({
        ...settings,
        ragOptions: {
          ...settings.ragOptions,
          ...ragOptionsFromRules(nextRules, yoloBaseDir),
        },
      })
    },
    [applySettingsUpdate, settings, yoloBaseDir],
  )

  const runIndexJob = useCallback(
    async ({ mode, successNotice, failureNotice }: IndexJob) => {
      try {
        const result = await plugin.runRagIndex({
          mode,
          scope: { kind: 'all' },
          trigger: 'manual',
          // Both rebuild and sync get transient retry so an interrupted
          // resume can itself be resumed next launch.
          retryPolicy: 'transient',
        })
        await plugin.setSettings({
          ...plugin.settings,
          ragOptions: {
            ...plugin.settings.ragOptions,
            lastAutoUpdateAt: Date.now(),
          },
        })
        const skippedCount = result.permanentFailedPaths.length
        if (skippedCount > 0) {
          // Partial success: some files could never be embedded and were kept
          // with whatever indexed (they will not be retried). Surface it once
          // here instead of the plain success notice.
          new Notice(
            t(
              'notices.indexedWithSkipped',
              '索引完成，{{count}} 个文件无法索引',
            ).replace('{{count}}', String(skippedCount)),
          )
        } else if (successNotice) {
          new Notice(successNotice)
        }
      } catch (error) {
        if (error instanceof RagIndexBusyError) {
          new Notice(t('statusBar.ragAutoUpdateRunning', '知识库索引正在运行'))
        } else if (
          error instanceof DOMException &&
          error.name === 'AbortError'
        ) {
          new Notice(t('notices.indexCancelled', '索引已取消'))
        } else {
          console.error('Failed to update knowledge base index:', error)
          new Notice(failureNotice)
        }
      }
    },
    [plugin, t],
  )

  const scheduleIndexJob = useCallback(
    (job: IndexJob, delayMs = 800) => {
      scheduledIndexJobRef.current = job
      if (scheduledIndexJobTimerRef.current !== null) {
        window.clearTimeout(scheduledIndexJobTimerRef.current)
      }
      scheduledIndexJobTimerRef.current = window.setTimeout(() => {
        scheduledIndexJobTimerRef.current = null
        const scheduledJob = scheduledIndexJobRef.current
        scheduledIndexJobRef.current = null
        if (!scheduledJob) return
        if (isIndexing) {
          queuedIndexJobRef.current = scheduledJob
          return
        }
        void runIndexJob(scheduledJob)
      }, delayMs)
    },
    [isIndexing, runIndexJob],
  )

  useEffect(() => {
    return () => {
      if (scheduledIndexJobTimerRef.current !== null) {
        window.clearTimeout(scheduledIndexJobTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (isIndexing) return
    const queuedJob = queuedIndexJobRef.current
    if (!queuedJob) return
    queuedIndexJobRef.current = null
    void runIndexJob(queuedJob)
  }, [isIndexing, runIndexJob])

  useEffect(() => {
    const nextSyncInputs = {
      enabled: isRagEnabled,
      embeddingModelId: settings.embeddingModelId,
      chunkSize: settings.ragOptions.chunkSize,
      indexPdf: settings.ragOptions.indexPdf ?? true,
      includePatternsKey: JSON.stringify(settings.ragOptions.includePatterns),
      excludePatternsKey: JSON.stringify(settings.ragOptions.excludePatterns),
      // Treat the dynamic YOLO chip as part of the exclude config: toggling
      // the flag or moving `yolo.baseDir` shifts the indexable file set.
      yoloExcludeKey: settings.ragOptions.excludeYoloBaseDir ? yoloBaseDir : '',
    }
    const previousSyncInputs = syncInputsRef.current
    syncInputsRef.current = nextSyncInputs

    if (!previousSyncInputs) {
      return
    }

    if (!nextSyncInputs.enabled || !nextSyncInputs.embeddingModelId) {
      scheduledIndexJobRef.current = null
      queuedIndexJobRef.current = null
      if (scheduledIndexJobTimerRef.current !== null) {
        window.clearTimeout(scheduledIndexJobTimerRef.current)
        scheduledIndexJobTimerRef.current = null
      }
      return
    }

    // Any config change is handled by a single `sync` reconcile. The
    // reconciler computes desired vs. actual itself, so changes to patterns,
    // chunkSize, indexPdf, embeddingModel, or first-time enable all converge
    // through the same idempotent path — no special-casing per field.
    const changed =
      previousSyncInputs.enabled !== nextSyncInputs.enabled ||
      previousSyncInputs.embeddingModelId !== nextSyncInputs.embeddingModelId ||
      previousSyncInputs.chunkSize !== nextSyncInputs.chunkSize ||
      previousSyncInputs.indexPdf !== nextSyncInputs.indexPdf ||
      previousSyncInputs.includePatternsKey !==
        nextSyncInputs.includePatternsKey ||
      previousSyncInputs.excludePatternsKey !==
        nextSyncInputs.excludePatternsKey ||
      previousSyncInputs.yoloExcludeKey !== nextSyncInputs.yoloExcludeKey
    if (changed) {
      scheduleIndexJob({
        mode: 'sync',
        failureNotice: t('notices.indexUpdateFailed'),
      })
    }
  }, [
    isRagEnabled,
    scheduleIndexJob,
    settings.embeddingModelId,
    settings.ragOptions.chunkSize,
    settings.ragOptions.indexPdf,
    settings.ragOptions.excludePatterns,
    settings.ragOptions.includePatterns,
    settings.ragOptions.excludeYoloBaseDir,
    yoloBaseDir,
    t,
  ])

  const embeddingModelOptionGroups = useMemo<
    ObsidianDropdownOptionGroup[]
  >(() => {
    const providerOrder = settings.providers.map((p) => p.id)
    const providerIdsInModels = Array.from(
      new Set(settings.embeddingModels.map((model) => model.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]
    const recommendedBadge =
      t('settings.defaults.recommendedBadge') ?? '(Recommended)'

    return orderedProviderIds
      .map<ObsidianDropdownOptionGroup | null>((providerId) => {
        const groupModels = settings.embeddingModels.filter(
          (model) => model.providerId === providerId,
        )
        if (groupModels.length === 0) return null
        return {
          label: providerId,
          options: groupModels.map((model) => {
            const baseLabel = model.name || model.model || model.id
            const badge = RECOMMENDED_MODELS_FOR_EMBEDDING.includes(model.id)
              ? ` ${recommendedBadge}`
              : ''
            return {
              value: model.id,
              label: `${baseLabel}${badge}`.trim(),
            }
          }),
        }
      })
      .filter((group): group is ObsidianDropdownOptionGroup => group !== null)
  }, [settings.embeddingModels, settings.providers, t])

  return (
    <div className="yolo-settings-section">
      <div className="yolo-settings-header">
        {t('settings.rag.title', '知识库')}
      </div>
      <div className="yolo-settings-desc">
        {t(
          'settings.rag.desc',
          '管理知识库索引，当 Agent 使用「搜索」工具并选择混合 & RAG 模式时，会自动调用 RAG 能力。',
        )}
      </div>
      <div className="yolo-rag-layout">
        <RAGCard
          title={t('settings.rag.basicCardTitle', '知识库')}
          description={t(
            'settings.rag.basicCardDesc',
            '控制知识库索引的启用状态、嵌入模型与相关维护操作。',
          )}
        >
          <ObsidianSetting
            name={t('settings.rag.enableRag')}
            desc={t('settings.rag.enableRagDesc')}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={isRagEnabled}
              onChange={(value) => {
                if (value && !settings.embeddingModelId) {
                  new Notice(
                    t(
                      'settings.rag.selectEmbeddingModelFirst',
                      '请先选择嵌入模型，再启用知识库索引。',
                    ),
                  )
                  return
                }
                applySettingsUpdate({
                  ...settings,
                  ragOptions: {
                    ...settings.ragOptions,
                    enabled: value,
                  },
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.autoUpdate', '自动更新索引')}
            desc={t(
              'settings.rag.autoUpdateDesc',
              '开启后会在文档发生变化时于后台自动增量更新索引。',
            )}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={isAutoUpdateEnabled}
              onChange={(value) => {
                applySettingsUpdate({
                  ...settings,
                  ragOptions: {
                    ...settings.ragOptions,
                    autoUpdateEnabled: value,
                  },
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.indexPdf', '索引 PDF')}
            desc={t(
              'settings.rag.indexPdfDesc',
              '为知识库提取并索引 PDF 文本；首次全库重建可能较慢。大型仓库若不需要可关闭。',
            )}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={isIndexPdfEnabled}
              onChange={(value) => {
                applySettingsUpdate({
                  ...settings,
                  ragOptions: {
                    ...settings.ragOptions,
                    indexPdf: value,
                  },
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.embeddingModel')}
            desc={t('settings.rag.embeddingModelDesc')}
            className="yolo-settings-card"
          >
            <ObsidianDropdown
              value={settings.embeddingModelId}
              groupedOptions={embeddingModelOptionGroups}
              onChange={(value) => {
                applySettingsUpdate({
                  ...settings,
                  embeddingModelId: value,
                })
              }}
            />
          </ObsidianSetting>

          {isRagEnabled && (
            <>
              <ObsidianSetting
                name={t('settings.rag.maintenanceActions', '维护操作')}
                nameExtra={
                  <div className="yolo-index-inline-status">
                    <IndexProgressRing percent={ringPercent} />
                    {isAnimatingCurrentFile ? (
                      <span
                        className="yolo-index-current-file"
                        title={`${maintenanceStatusPrefix} ${maintenanceStatusLine}`}
                      >
                        <span className="yolo-index-current-file-prefix">
                          {maintenanceStatusPrefix}
                        </span>
                        <span className="yolo-index-current-file-viewport">
                          {leavingCurrentFile ? (
                            <span className="yolo-index-current-file-text is-leaving">
                              {leavingCurrentFile}
                            </span>
                          ) : null}
                          <span
                            key={fileAnimationKey}
                            className={`yolo-index-current-file-text${leavingCurrentFile ? ' is-entering' : ''}`}
                          >
                            {maintenanceStatusLine}
                          </span>
                        </span>
                      </span>
                    ) : (
                      <span
                        key={maintenanceStatusKey}
                        className="yolo-index-current-file"
                        title={maintenanceStatusLine}
                      >
                        {maintenanceStatusLine}
                      </span>
                    )}
                  </div>
                }
                className="yolo-settings-card yolo-rag-maintenance-setting"
              >
                <div className="yolo-flex-row-gap-8 yolo-rag-maintenance-actions">
                  <ObsidianButton
                    text={t('settings.rag.manage')}
                    onClick={() => {
                      new EmbeddingDbManageModal(app, plugin).open()
                    }}
                  />
                  {(() => {
                    const status = indexRunSnapshot.status
                    const isInterrupted =
                      status === 'retry_scheduled' || status === 'failed'
                    let primaryLabel: string
                    let primaryMode: 'rebuild' | 'sync'
                    let primarySuccess: string
                    let primaryFailure: string
                    if (status === 'retry_scheduled') {
                      primaryLabel = t(
                        'settings.rag.continueIndexNow',
                        '立即继续',
                      )
                      primaryMode = 'sync'
                      primarySuccess = t(
                        'notices.continueComplete',
                        '继续索引完成',
                      )
                      primaryFailure = t(
                        'notices.continueFailed',
                        '继续索引失败',
                      )
                    } else if (status === 'failed') {
                      primaryLabel = t('settings.rag.continueIndex', '继续索引')
                      primaryMode = 'sync'
                      primarySuccess = t(
                        'notices.continueComplete',
                        '继续索引完成',
                      )
                      primaryFailure = t(
                        'notices.continueFailed',
                        '继续索引失败',
                      )
                    } else {
                      primaryLabel = t('settings.rag.rebuildIndex', '重建索引')
                      primaryMode = 'rebuild'
                      primarySuccess = t('notices.rebuildComplete')
                      primaryFailure = t('notices.rebuildFailed')
                    }
                    return (
                      <>
                        <ObsidianButton
                          text={primaryLabel}
                          disabled={isIndexing}
                          onClick={() => {
                            void runIndexJob({
                              mode: primaryMode,
                              successNotice: primarySuccess,
                              failureNotice: primaryFailure,
                            })
                          }}
                        />
                        {isInterrupted && (
                          <ObsidianButton
                            text={t(
                              'settings.rag.rebuildFromScratch',
                              '从头重建',
                            )}
                            disabled={isIndexing}
                            onClick={() => {
                              new ConfirmModal(app, {
                                title: t(
                                  'settings.rag.rebuildFromScratch',
                                  '从头重建',
                                ),
                                message: t(
                                  'settings.rag.rebuildFromScratchConfirm',
                                  '将清空当前嵌入模型已有的全部向量并重新索引整个知识库，可能产生大量 embedding 调用。继续？',
                                ),
                                ctaText: t(
                                  'settings.rag.rebuildFromScratch',
                                  '从头重建',
                                ),
                                cancelText: t('common.cancel', '取消'),
                                onConfirm: () => {
                                  void runIndexJob({
                                    mode: 'rebuild',
                                    successNotice: t('notices.rebuildComplete'),
                                    failureNotice: t('notices.rebuildFailed'),
                                  })
                                },
                              }).open()
                            }}
                          />
                        )}
                      </>
                    )
                  })()}
                  {isIndexing && (
                    <ObsidianButton
                      text={t('settings.rag.cancelIndex', '取消')}
                      onClick={() => {
                        console.debug('[YOLO] Cancel button clicked')
                        plugin.cancelRagIndex()
                        new Notice(
                          t('notices.indexCancelling', '正在取消索引...'),
                        )
                      }}
                    />
                  )}
                </div>
              </ObsidianSetting>
              {permanentFailedPaths.length > 0 && (
                <div className="yolo-rag-permanent-failures">
                  <button
                    type="button"
                    className="yolo-rag-permanent-failures-summary"
                    onClick={() =>
                      setPermanentFailuresExpanded((prev) => !prev)
                    }
                    aria-expanded={permanentFailuresExpanded}
                  >
                    <span className="yolo-rag-permanent-failures-text">
                      {t(
                        'settings.rag.partialFailureSummary',
                        '完成 · {{count}} 个文件无法索引',
                      ).replace(
                        '{{count}}',
                        String(permanentFailedPaths.length),
                      )}
                    </span>
                    <span className="yolo-rag-permanent-failures-caret">
                      {permanentFailuresExpanded ? '▾' : '▸'}
                    </span>
                  </button>
                  {permanentFailuresExpanded && (
                    <ul className="yolo-rag-permanent-failures-list">
                      {permanentFailedPaths.map((path) => (
                        <li key={path} title={path}>
                          {path}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </RAGCard>

        {isRagEnabled && (
          <>
            <RAGCard
              title={t('settings.rag.scopeCardTitle', '索引范围')}
              description={t(
                'settings.rag.scopeCardDesc',
                '决定哪些文件夹会进入知识库索引。子文件夹默认跟随父级；排除优先于包含。',
              )}
            >
              <ScopeSummary
                app={app}
                vault={plugin.app.vault}
                rules={scopeRules}
                allowFiles={false}
                variant="rag"
                candidateFiles={scopeCandidateFiles}
                defaultRules={defaultScopeRules}
                onChange={handleScopeChange}
              />
            </RAGCard>

            <RAGCard title={t('settings.rag.advanced', '高级设置')}>
              <div
                className={`yolo-settings-advanced-toggle yolo-clickable${
                  showAdvancedRagSettings ? ' is-expanded' : ''
                }`}
                onClick={() => setShowAdvancedRagSettings((prev) => !prev)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setShowAdvancedRagSettings((prev) => !prev)
                  }
                }}
              >
                <span className="yolo-settings-advanced-toggle-icon">▶</span>
                {t('settings.rag.advanced', '高级设置')}
              </div>

              {showAdvancedRagSettings && (
                <>
                  <ObsidianSetting
                    name={t('settings.rag.chunkSize')}
                    desc={t('settings.rag.chunkSizeDesc')}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={chunkSizeInput}
                      placeholder="1000"
                      onChange={(value) => {
                        setChunkSizeInput(value)
                        const chunkSize = parseIntegerInput(value)
                        if (chunkSize !== null) {
                          applySettingsUpdate({
                            ...settings,
                            ragOptions: {
                              ...settings.ragOptions,
                              chunkSize,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const chunkSize = parseIntegerInput(chunkSizeInput)
                        if (chunkSize === null) {
                          setChunkSizeInput(
                            String(settings.ragOptions.chunkSize),
                          )
                        }
                      }}
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t('settings.rag.minSimilarity')}
                    desc={t('settings.rag.minSimilarityDesc')}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={minSimilarityInput}
                      placeholder="0.0"
                      onChange={(value) => {
                        setMinSimilarityInput(value)
                        const minSimilarity = parseFloatInput(value)
                        if (minSimilarity !== null) {
                          applySettingsUpdate({
                            ...settings,
                            ragOptions: {
                              ...settings.ragOptions,
                              minSimilarity,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const minSimilarity =
                          parseFloatInput(minSimilarityInput)
                        if (minSimilarity === null) {
                          setMinSimilarityInput(
                            String(settings.ragOptions.minSimilarity),
                          )
                        }
                      }}
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t('settings.rag.limit')}
                    desc={t('settings.rag.limitDesc')}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={limitInput}
                      placeholder="10"
                      onChange={(value) => {
                        setLimitInput(value)
                        const limit = parseIntegerInput(value)
                        if (limit !== null) {
                          applySettingsUpdate({
                            ...settings,
                            ragOptions: {
                              ...settings.ragOptions,
                              limit,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const limit = parseIntegerInput(limitInput)
                        if (limit === null) {
                          setLimitInput(String(settings.ragOptions.limit))
                        }
                      }}
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t('settings.rag.embeddingConcurrency')}
                    desc={t('settings.rag.embeddingConcurrencyDesc')}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={embeddingConcurrencyInput}
                      placeholder="10"
                      onChange={(value) => {
                        setEmbeddingConcurrencyInput(value)
                        const parsed = parseIntegerInput(value)
                        if (parsed !== null) {
                          const clamped = Math.max(1, Math.min(24, parsed))
                          applySettingsUpdate({
                            ...settings,
                            ragOptions: {
                              ...settings.ragOptions,
                              embeddingConcurrency: clamped,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const parsed = parseIntegerInput(
                          embeddingConcurrencyInput,
                        )
                        if (parsed === null) {
                          setEmbeddingConcurrencyInput(
                            String(
                              settings.ragOptions.embeddingConcurrency ?? 10,
                            ),
                          )
                          return
                        }
                        const clamped = Math.max(1, Math.min(24, parsed))
                        if (clamped !== parsed) {
                          setEmbeddingConcurrencyInput(String(clamped))
                        }
                      }}
                    />
                  </ObsidianSetting>
                </>
              )}
            </RAGCard>
          </>
        )}
      </div>
    </div>
  )
}
