import { App, Notice } from 'obsidian'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { RECOMMENDED_MODELS_FOR_EMBEDDING } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  RagIndexBusyError,
  type RagIndexRunSnapshot,
} from '../../../core/rag/ragIndexService'
import type { PGliteRuntimeStatus } from '../../../database/runtime/PGliteRuntimeManager'
import { PGLITE_RUNTIME_VERSION } from '../../../database/runtime/pgliteRuntimeMetadata'
import SmartComposerPlugin from '../../../main'
import { findFilesMatchingPatterns } from '../../../utils/glob-utils'
import {
  folderPathsToIncludePatterns,
  includePatternsToFolderPaths,
} from '../../../utils/rag-utils'
import { IndexProgress } from '../../chat-view/QueryProgress'
import { ObsidianButton } from '../../common/ObsidianButton'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { IndexProgressRing } from '../IndexProgressRing'
import { FolderSelectionList } from '../inputs/FolderSelectionList'
import { EmbeddingDbManageModal } from '../modals/EmbeddingDbManageModal'
import { ExcludedFilesModal } from '../modals/ExcludedFilesModal'
import { IncludedFilesModal } from '../modals/IncludedFilesModal'

type RAGSectionProps = {
  app: App
  plugin: SmartComposerPlugin
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
    <section className="smtcmp-rag-card">
      <div className="smtcmp-rag-card-header">
        <div className="smtcmp-rag-card-header-copy">
          <div className="smtcmp-rag-card-title">{title}</div>
          {description ? (
            <div className="smtcmp-rag-card-description">{description}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="smtcmp-rag-card-actions">{actions}</div>
        ) : null}
      </div>
      <div className="smtcmp-rag-card-body">{children}</div>
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
  const [isCheckingPgliteResources, setIsCheckingPgliteResources] =
    useState(false)
  const [isRunningPgliteAction, setIsRunningPgliteAction] = useState(false)
  const [isVerifyingIntegrity, setIsVerifyingIntegrity] = useState(false)
  const [pgliteResourceStatus, setPgliteResourceStatus] =
    useState<PGliteRuntimeStatus | null>(null)
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
  const [showAdvancedRagSettings, setShowAdvancedRagSettings] = useState(false)
  const syncInputsRef = useRef<{
    enabled: boolean
    embeddingModelId: string
    chunkSize: number
    indexPdf: boolean
    includePatternsKey: string
    excludePatternsKey: string
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

  const refreshPgliteResourceStatus = useCallback(async () => {
    setIsCheckingPgliteResources(true)

    try {
      // Must stay lightweight: getStatus uses readCurrentFile (small JSON) +
      // hasAllRuntimeFiles (exists() only). Do NOT introduce readBinary / SHA here.
      const result = await plugin.getPGliteRuntimeManager().getStatus()
      setPgliteResourceStatus(result)
    } catch (error: unknown) {
      console.error('Failed to inspect PGlite resources', error)
      setPgliteResourceStatus({
        kind: 'failed',
        expectedVersion: PGLITE_RUNTIME_VERSION,
        dir: plugin.getPGliteRuntimeManager().getRuntimeRootDir(),
        checkedAt: Date.now(),
        reason: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setIsCheckingPgliteResources(false)
    }
  }, [plugin])

  useEffect(() => {
    void refreshPgliteResourceStatus()
  }, [refreshPgliteResourceStatus])

  useEffect(() => {
    if (
      pgliteResourceStatus?.kind !== 'downloading' &&
      !isRunningPgliteAction
    ) {
      return
    }

    const intervalId = window.setInterval(() => {
      void refreshPgliteResourceStatus()
    }, 500)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [
    isRunningPgliteAction,
    pgliteResourceStatus?.kind,
    refreshPgliteResourceStatus,
  ])

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

  const includeFolders = useMemo(
    () => includePatternsToFolderPaths(settings.ragOptions.includePatterns),
    [settings.ragOptions.includePatterns],
  )

  const excludeFolders = useMemo(
    () => includePatternsToFolderPaths(settings.ragOptions.excludePatterns),
    [settings.ragOptions.excludePatterns],
  )

  const pgliteStatusLabel = useMemo(() => {
    if (isCheckingPgliteResources && pgliteResourceStatus === null) {
      return t('settings.rag.pgliteStateChecking', 'Checking')
    }
    switch (pgliteResourceStatus?.kind) {
      case 'missing':
        return t('settings.rag.pgliteStateMissing', 'Not downloaded')
      case 'downloading':
        return t('settings.rag.pgliteStateDownloading', 'Downloading')
      case 'ready':
        return t('settings.rag.pgliteStateReady', 'Ready')
      case 'failed':
        return t('settings.rag.pgliteStateFailed', 'Failed')
      default:
        return t('settings.rag.pgliteStateUnchecked', 'Not recorded')
    }
  }, [isCheckingPgliteResources, pgliteResourceStatus, t])

  const pgliteStatusTone =
    pgliteResourceStatus?.kind === 'ready'
      ? 'is-ready'
      : pgliteResourceStatus?.kind === 'missing' ||
          pgliteResourceStatus?.kind === 'downloading'
        ? 'is-warning'
        : 'is-danger'

  const canUseIndexMaintenance = pgliteResourceStatus?.kind === 'ready'
  const pglitePrimaryActionLabel =
    pgliteResourceStatus?.kind === 'ready'
      ? t('settings.rag.pgliteRedownload', 'Download again')
      : t('settings.rag.pgliteDownload', 'Download resources')
  const pgliteSummaryText =
    pgliteResourceStatus?.kind === 'ready'
      ? t(
          'settings.rag.pgliteSummaryReady',
          'PGlite runtime resources are ready and can be used for indexing and embedding database management.',
        )
      : pgliteResourceStatus?.kind === 'downloading'
        ? t(
            'settings.rag.pgliteSummaryDownloading',
            'PGlite runtime resources are being prepared. Once the download finishes, indexing and embedding database management will become available.',
          )
        : pgliteResourceStatus?.kind === 'failed'
          ? t(
              'settings.rag.pgliteSummaryFailed',
              'PGlite runtime preparation failed. Retry downloading or remove the local cache before using knowledge base features again.',
            )
          : t(
              'settings.rag.pgliteSummaryMissing',
              'PGlite runtime resources have not been prepared yet. The plugin will auto-download them on first knowledge base use, and you can also prepare them here manually.',
            )
  const pgliteDownloadProgress =
    pgliteResourceStatus?.kind === 'downloading' &&
    pgliteResourceStatus.totalFiles > 0
      ? Math.round(
          (Math.max(0, pgliteResourceStatus.currentFileIndex - 1) /
            pgliteResourceStatus.totalFiles) *
            100,
        )
      : null
  const pgliteDownloadDetail =
    pgliteResourceStatus?.kind === 'downloading'
      ? `${t('settings.rag.pgliteDownloadingFile', 'Downloading')}: ${
          pgliteResourceStatus.currentFile ??
          t('settings.rag.pgliteDownloadingUnknownFile', 'runtime file')
        } (${pgliteResourceStatus.currentFileIndex}/${
          pgliteResourceStatus.totalFiles
        })`
      : null
  const pgliteFailureReason =
    pgliteResourceStatus?.kind === 'failed' ? pgliteResourceStatus.reason : null
  const runPgliteAction = useCallback(() => {
    setIsRunningPgliteAction(true)

    void (async () => {
      try {
        const runtimeManager = plugin.getPGliteRuntimeManager()
        if (pgliteResourceStatus?.kind === 'ready') {
          new Notice(
            t(
              'notices.downloadingPglite',
              'Downloading PGlite runtime assets. This may take a moment...',
            ),
          )
          await runtimeManager.redownload()
        } else {
          await refreshPgliteResourceStatus()
          new Notice(
            t(
              'notices.downloadingPglite',
              'Downloading PGlite runtime assets. This may take a moment...',
            ),
          )
          await runtimeManager.ensureReady()
        }
        await refreshPgliteResourceStatus()
      } catch (error: unknown) {
        console.error('Failed to run PGlite runtime action', error)
        new Notice(
          error instanceof Error
            ? error.message
            : t(
                'notices.pgliteUnavailable',
                'PGlite runtime is unavailable. Please retry downloading the runtime assets.',
              ),
          5000,
        )
        await refreshPgliteResourceStatus()
      } finally {
        setIsRunningPgliteAction(false)
      }
    })()
  }, [pgliteResourceStatus?.kind, plugin, refreshPgliteResourceStatus, t])

  const runVerifyIntegrity = useCallback(() => {
    if (pgliteResourceStatus?.kind !== 'ready') return
    const versionDir = pgliteResourceStatus.dir
    setIsVerifyingIntegrity(true)
    void (async () => {
      try {
        await plugin.getPGliteRuntimeManager().verifyIntegrity(versionDir)
        new Notice(
          t(
            'settings.rag.pgliteIntegrityOk',
            'PGlite runtime integrity check passed.',
          ),
        )
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        new Notice(
          `${t('settings.rag.pgliteIntegrityFailed', 'Integrity check failed')}: ${reason}. ${t('settings.rag.pgliteIntegrityFailedHint', 'Please re-download the runtime.')}`,
          8000,
        )
      } finally {
        setIsVerifyingIntegrity(false)
      }
    })()
  }, [pgliteResourceStatus, plugin, t])

  const runIndexJob = useCallback(
    async ({ mode, successNotice, failureNotice }: IndexJob) => {
      try {
        await plugin.runRagIndex({
          mode,
          scope: { kind: 'all' },
          trigger: 'manual',
          retryPolicy: mode === 'rebuild' ? 'transient' : 'none',
        })
        await plugin.setSettings({
          ...plugin.settings,
          ragOptions: {
            ...plugin.settings.ragOptions,
            lastAutoUpdateAt: Date.now(),
          },
        })
        if (successNotice) {
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
        nextSyncInputs.excludePatternsKey
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
    t,
  ])

  const conflictInfo = useMemo(() => {
    const inc = includeFolders
    const exc = excludeFolders
    const isParentOrSame = (parent: string, child: string) => {
      if (parent === '') return true
      if (child === parent) return true
      return child.startsWith(parent + '/')
    }
    const exactConflicts = inc.filter((f) => exc.includes(f))
    const includeUnderExcluded = inc
      .filter((f) => exc.some((e) => isParentOrSame(e, f)))
      .filter((f) => !exactConflicts.includes(f))
    const excludeWithinIncluded = exc
      .filter((e) => inc.some((f) => isParentOrSame(f, e)))
      .filter((e) => !exactConflicts.includes(e))
    return { exactConflicts, includeUnderExcluded, excludeWithinIncluded }
  }, [includeFolders, excludeFolders])

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
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-header">
        {t('settings.rag.title', '知识库')}
      </div>
      <div className="smtcmp-settings-desc">
        {t(
          'settings.rag.desc',
          '管理知识库索引，当 Agent 使用「搜索」工具并选择混合 & RAG 模式时，会自动调用 RAG 能力。',
        )}
      </div>
      <div className="smtcmp-rag-layout">
        <RAGCard
          title={t('settings.rag.resourceCardTitle', 'PGlite 资源')}
          description={t(
            'settings.rag.resourceCardDesc',
            '管理知识库运行所需的数据库运行时资源。',
          )}
          actions={
            <>
              {pgliteResourceStatus?.kind === 'ready' && (
                <ObsidianButton
                  text={
                    isVerifyingIntegrity
                      ? t('settings.rag.pgliteVerifyingIntegrity', 'Verifying…')
                      : t(
                          'settings.rag.pgliteVerifyIntegrity',
                          'Verify integrity',
                        )
                  }
                  onClick={() => runVerifyIntegrity()}
                  disabled={isVerifyingIntegrity || isRunningPgliteAction}
                />
              )}
              <ObsidianButton
                text={pglitePrimaryActionLabel}
                onClick={() => runPgliteAction()}
                disabled={
                  isCheckingPgliteResources ||
                  isRunningPgliteAction ||
                  isVerifyingIntegrity ||
                  pgliteResourceStatus?.kind === 'downloading'
                }
              />
            </>
          }
        >
          <div className="smtcmp-rag-resource-summary">
            <span className={`smtcmp-rag-status-pill ${pgliteStatusTone}`}>
              {pgliteStatusLabel}
            </span>
          </div>

          {pgliteDownloadDetail ? (
            <div className="smtcmp-rag-inline-status">
              <div className="smtcmp-rag-inline-status-text">
                {pgliteDownloadDetail}
              </div>
              <div className="smtcmp-rag-inline-progress" aria-hidden="true">
                <div
                  className="smtcmp-rag-inline-progress-bar"
                  style={{ width: `${pgliteDownloadProgress ?? 0}%` }}
                />
              </div>
            </div>
          ) : null}

          {pgliteFailureReason ? (
            <div className="smtcmp-rag-inline-status smtcmp-rag-inline-status--error">
              <div className="smtcmp-rag-inline-status-title">
                {t('settings.rag.pgliteInlineErrorTitle', '下载失败')}
              </div>
              <div className="smtcmp-rag-inline-status-text">
                {pgliteFailureReason}
              </div>
            </div>
          ) : null}

          <div className="smtcmp-muted-note">{pgliteSummaryText}</div>
        </RAGCard>

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
            className="smtcmp-settings-card"
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
            className="smtcmp-settings-card"
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
            className="smtcmp-settings-card"
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
            className="smtcmp-settings-card"
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

          {!canUseIndexMaintenance && isRagEnabled && (
            <div className="smtcmp-muted-note">
              {t(
                'settings.rag.maintenanceUnavailableHint',
                '请先在上方准备好 PGlite 资源，再执行索引维护或嵌入数据库管理。',
              )}
            </div>
          )}

          {isRagEnabled && (
            <>
              <ObsidianSetting
                name={t('settings.rag.maintenanceActions', '维护操作')}
                nameExtra={
                  <div className="smtcmp-index-inline-status">
                    <IndexProgressRing percent={ringPercent} />
                    {isAnimatingCurrentFile ? (
                      <span
                        className="smtcmp-index-current-file"
                        title={`${maintenanceStatusPrefix} ${maintenanceStatusLine}`}
                      >
                        <span className="smtcmp-index-current-file-prefix">
                          {maintenanceStatusPrefix}
                        </span>
                        <span className="smtcmp-index-current-file-viewport">
                          {leavingCurrentFile ? (
                            <span className="smtcmp-index-current-file-text is-leaving">
                              {leavingCurrentFile}
                            </span>
                          ) : null}
                          <span
                            key={fileAnimationKey}
                            className={`smtcmp-index-current-file-text${leavingCurrentFile ? ' is-entering' : ''}`}
                          >
                            {maintenanceStatusLine}
                          </span>
                        </span>
                      </span>
                    ) : (
                      <span
                        key={maintenanceStatusKey}
                        className="smtcmp-index-current-file"
                        title={maintenanceStatusLine}
                      >
                        {maintenanceStatusLine}
                      </span>
                    )}
                  </div>
                }
                className="smtcmp-settings-card smtcmp-rag-maintenance-setting"
              >
                <div className="smtcmp-flex-row-gap-8 smtcmp-rag-maintenance-actions">
                  <ObsidianButton
                    text={t('settings.rag.manage')}
                    disabled={!canUseIndexMaintenance}
                    onClick={() => {
                      new EmbeddingDbManageModal(app, plugin).open()
                    }}
                  />
                  {(() => {
                    const status = indexRunSnapshot.status
                    let label: string
                    if (status === 'retry_scheduled') {
                      label = t('settings.rag.retryNow', '立即重试')
                    } else if (status === 'failed') {
                      label = t('common.retry', '重试')
                    } else {
                      label = t('settings.rag.rebuildIndex', '重建索引')
                    }
                    return (
                      <ObsidianButton
                        text={label}
                        disabled={isIndexing || !canUseIndexMaintenance}
                        onClick={() => {
                          void runIndexJob({
                            mode: 'rebuild',
                            successNotice: t('notices.rebuildComplete'),
                            failureNotice: t('notices.rebuildFailed'),
                          })
                        }}
                      />
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
            </>
          )}
        </RAGCard>

        {isRagEnabled && (
          <>
            <RAGCard
              title={t('settings.rag.scopeCardTitle', '索引范围')}
              description={t(
                'settings.rag.scopeCardDesc',
                '选择哪些文件夹应参与知识库索引，哪些应被排除。',
              )}
            >
              <div className="smtcmp-rag-scope-group">
                <ObsidianSetting
                  name={t('settings.rag.includePatterns')}
                  desc={t('settings.rag.includePatternsDesc')}
                  className="smtcmp-rag-scope-group-setting"
                >
                  <ObsidianButton
                    text={t('settings.rag.testPatterns')}
                    onClick={() => {
                      void (async () => {
                        const patterns = settings.ragOptions.includePatterns
                        const includedFiles = await findFilesMatchingPatterns(
                          patterns,
                          plugin.app.vault,
                        )
                        new IncludedFilesModal(
                          app,
                          includedFiles,
                          patterns,
                        ).open()
                      })().catch((error) => {
                        console.error('Failed to test include patterns', error)
                      })
                    }}
                  />
                </ObsidianSetting>

                <div className="smtcmp-rag-scope-group-body">
                  <FolderSelectionList
                    app={app}
                    vault={plugin.app.vault}
                    title={t('settings.rag.selectedFolders', '已选择的文件夹')}
                    value={includeFolders}
                    onChange={(folders: string[]) => {
                      const patterns = folderPathsToIncludePatterns(folders)
                      applySettingsUpdate({
                        ...settings,
                        ragOptions: {
                          ...settings.ragOptions,
                          includePatterns: patterns,
                        },
                      })
                    }}
                  />
                </div>
              </div>

              <div className="smtcmp-rag-scope-group">
                <ObsidianSetting
                  name={t('settings.rag.excludePatterns')}
                  desc={t('settings.rag.excludePatternsDesc')}
                  className="smtcmp-rag-scope-group-setting"
                >
                  <ObsidianButton
                    text={t('settings.rag.testPatterns')}
                    onClick={() => {
                      void (async () => {
                        const patterns = settings.ragOptions.excludePatterns
                        const excludedFiles = await findFilesMatchingPatterns(
                          patterns,
                          plugin.app.vault,
                        )
                        new ExcludedFilesModal(app, excludedFiles).open()
                      })().catch((error) => {
                        console.error('Failed to test exclude patterns', error)
                      })
                    }}
                  />
                </ObsidianSetting>

                <div className="smtcmp-rag-scope-group-body">
                  <FolderSelectionList
                    app={app}
                    vault={plugin.app.vault}
                    title={t('settings.rag.excludedFolders', '已排除的文件夹')}
                    placeholder={t(
                      'settings.rag.selectExcludeFoldersPlaceholder',
                      '点击此处选择要排除的文件夹（留空则不排除）',
                    )}
                    value={excludeFolders}
                    onChange={(folders: string[]) => {
                      const patterns = folderPathsToIncludePatterns(folders)
                      applySettingsUpdate({
                        ...settings,
                        ragOptions: {
                          ...settings.ragOptions,
                          excludePatterns: patterns,
                        },
                      })
                    }}
                  />
                </div>
              </div>

              {(includeFolders.length === 0 ||
                conflictInfo.exactConflicts.length > 0 ||
                conflictInfo.includeUnderExcluded.length > 0 ||
                conflictInfo.excludeWithinIncluded.length > 0) && (
                <div className="smtcmp-muted-note">
                  {includeFolders.length === 0 && (
                    <div>
                      {t(
                        'settings.rag.conflictNoteDefaultInclude',
                        '提示：当前未选择包含文件夹，默认包含全部。若设置了排除文件夹，则排除将优先生效。',
                      )}
                    </div>
                  )}
                  {conflictInfo.exactConflicts.length > 0 && (
                    <div>
                      {t(
                        'settings.rag.conflictExact',
                        '以下文件夹同时被包含与排除，最终将被排除：',
                      )}{' '}
                      {conflictInfo.exactConflicts
                        .map((f) => (f === '' ? '/' : f))
                        .join(', ')}
                    </div>
                  )}
                  {conflictInfo.includeUnderExcluded.length > 0 && (
                    <div>
                      {t(
                        'settings.rag.conflictParentExclude',
                        '以下包含的文件夹位于已排除的上级之下，最终将被排除：',
                      )}{' '}
                      {conflictInfo.includeUnderExcluded
                        .map((f) => (f === '' ? '/' : f))
                        .join(', ')}
                    </div>
                  )}
                  {conflictInfo.excludeWithinIncluded.length > 0 && (
                    <div>
                      {t(
                        'settings.rag.conflictChildExclude',
                        '以下排除的子文件夹位于包含文件夹之下（局部排除将生效）：',
                      )}{' '}
                      {conflictInfo.excludeWithinIncluded
                        .map((f) => (f === '' ? '/' : f))
                        .join(', ')}
                    </div>
                  )}
                  <div>
                    {t(
                      'settings.rag.conflictRule',
                      '当包含与排除重叠时，以排除为准。',
                    )}
                  </div>
                </div>
              )}
            </RAGCard>

            <RAGCard title={t('settings.rag.advanced', '高级设置')}>
              <div
                className={`smtcmp-settings-advanced-toggle smtcmp-clickable${
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
                <span className="smtcmp-settings-advanced-toggle-icon">▶</span>
                {t('settings.rag.advanced', '高级设置')}
              </div>

              {showAdvancedRagSettings && (
                <>
                  <ObsidianSetting
                    name={t('settings.rag.chunkSize')}
                    desc={t('settings.rag.chunkSizeDesc')}
                    className="smtcmp-settings-card"
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
                    className="smtcmp-settings-card"
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
                    className="smtcmp-settings-card"
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
                </>
              )}
            </RAGCard>
          </>
        )}
      </div>
    </div>
  )
}
