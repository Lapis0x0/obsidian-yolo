import { ChevronDown, ChevronRight } from 'lucide-react'
import { App, Notice } from 'obsidian'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { RECOMMENDED_MODELS_FOR_EMBEDDING } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
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
import { FolderSelectionList } from '../inputs/FolderSelectionList'
import { EmbeddingDbManageModal } from '../modals/EmbeddingDbManageModal'
import { ExcludedFilesModal } from '../modals/ExcludedFilesModal'
import { IncludedFilesModal } from '../modals/IncludedFilesModal'
import { RAGIndexProgress } from '../RAGIndexProgress'

type RAGSectionProps = {
  app: App
  plugin: SmartComposerPlugin
}

type AppWithLocalStorage = App & {
  loadLocalStorage?: (key: string) => string | null | Promise<string | null>
  saveLocalStorage?: (key: string, value: string) => void | Promise<void>
}

const isPromiseLike = <T,>(value: T | Promise<T>): value is Promise<T> =>
  typeof value === 'object' &&
  value !== null &&
  'then' in (value as Record<string, unknown>) &&
  typeof (value as { then?: unknown }).then === 'function'

const loadAppLocalStorage = async (
  app: App,
  key: string,
): Promise<string | null> => {
  const appWithLocalStorage = app as AppWithLocalStorage
  if (typeof appWithLocalStorage.loadLocalStorage === 'function') {
    const result = appWithLocalStorage.loadLocalStorage(key)
    return isPromiseLike(result) ? await result : result
  }
  return null
}

const saveAppLocalStorage = async (
  app: App,
  key: string,
  value: string,
): Promise<void> => {
  const appWithLocalStorage = app as AppWithLocalStorage
  if (typeof appWithLocalStorage.saveLocalStorage === 'function') {
    const result = appWithLocalStorage.saveLocalStorage(key, value)
    if (isPromiseLike(result)) {
      await result
    }
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
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null)
  const [persistedProgress, setPersistedProgress] =
    useState<IndexProgress | null>(null)
  const [isIndexing, setIsIndexing] = useState(false)
  const [isProgressOpen, setIsProgressOpen] = useState(false)
  const [indexAbortController, setIndexAbortController] =
    useState<AbortController | null>(null)
  const [isCheckingPgliteResources, setIsCheckingPgliteResources] =
    useState(false)
  const [isRunningPgliteAction, setIsRunningPgliteAction] = useState(false)
  const [pgliteResourceStatus, setPgliteResourceStatus] =
    useState<PGliteRuntimeStatus | null>(null)
  const isRagEnabled = settings.ragOptions.enabled ?? true
  const effectiveProgress = indexProgress ?? persistedProgress
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
  const [autoUpdateIntervalInput, setAutoUpdateIntervalInput] = useState(
    String(settings.ragOptions.autoUpdateIntervalHours ?? 0),
  )
  const [showAdvancedRagSettings, setShowAdvancedRagSettings] = useState(false)

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
    setAutoUpdateIntervalInput(
      String(settings.ragOptions.autoUpdateIntervalHours ?? 0),
    )
  }, [settings.ragOptions.autoUpdateIntervalHours])

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
    let cancelled = false

    void (async () => {
      try {
        const raw = await loadAppLocalStorage(app, 'smtcmp_rag_last_progress')
        if (!raw || cancelled) return
        const parsed = JSON.parse(raw) as IndexProgress
        setPersistedProgress(parsed)
      } catch (error: unknown) {
        console.warn('Failed to load cached RAG progress', error)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [app])

  useEffect(() => {
    if (!indexProgress) return
    const json = JSON.stringify(indexProgress)
    void saveAppLocalStorage(app, 'smtcmp_rag_last_progress', json).catch(
      (error: unknown) => {
        console.warn('Failed to persist RAG progress', error)
      },
    )
    setPersistedProgress(indexProgress)
  }, [app, indexProgress])

  const headerPercent = useMemo(() => {
    if (effectiveProgress && effectiveProgress.totalChunks > 0) {
      const pct = Math.round(
        (effectiveProgress.completedChunks / effectiveProgress.totalChunks) *
          100,
      )
      return Math.max(0, Math.min(100, pct))
    }
    return null
  }, [effectiveProgress])

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

  const handleIndexProgress = useCallback((progress: IndexProgress) => {
    setIndexProgress(progress)
  }, [])

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
      <div className="smtcmp-settings-header">{t('settings.rag.title')}</div>

      <div className="smtcmp-rag-layout">
        <RAGCard
          title={t('settings.rag.basicCardTitle', 'RAG Basics')}
          description={t(
            'settings.rag.basicCardDesc',
            'Control the retrieval entry point and base embedding model.',
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

          {isRagEnabled && (
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
          )}
        </RAGCard>

        {isRagEnabled && (
          <>
            <RAGCard
              title={t('settings.rag.resourceCardTitle', 'PGlite Resources')}
              description={t(
                'settings.rag.resourceCardDesc',
                'Manage the database runtime resources required by the knowledge base.',
              )}
              actions={
                <>
                  <ObsidianButton
                    text={pglitePrimaryActionLabel}
                    onClick={() => runPgliteAction()}
                    disabled={
                      isCheckingPgliteResources ||
                      isRunningPgliteAction ||
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
                  <div
                    className="smtcmp-rag-inline-progress"
                    aria-hidden="true"
                  >
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
                    {t(
                      'settings.rag.pgliteInlineErrorTitle',
                      'Download failed',
                    )}
                  </div>
                  <div className="smtcmp-rag-inline-status-text">
                    {pgliteFailureReason}
                  </div>
                </div>
              ) : null}

              <div className="smtcmp-muted-note">{pgliteSummaryText}</div>
            </RAGCard>

            <RAGCard
              title={t('settings.rag.scopeCardTitle', 'Retrieval Scope')}
              description={t(
                'settings.rag.scopeCardDesc',
                'Choose which folders should be included in or excluded from indexing.',
              )}
            >
              <ObsidianSetting
                name={t('settings.rag.includePatterns')}
                desc={t('settings.rag.includePatternsDesc')}
                className="smtcmp-settings-card"
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

              <ObsidianSetting className="smtcmp-settings-plain">
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
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.rag.excludePatterns')}
                desc={t('settings.rag.excludePatternsDesc')}
                className="smtcmp-settings-card"
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

              <ObsidianSetting className="smtcmp-settings-plain">
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
              </ObsidianSetting>

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

            <RAGCard
              title={t(
                'settings.rag.maintenanceCardTitle',
                'Index Maintenance',
              )}
              description={t(
                'settings.rag.maintenanceCardDesc',
                'Manage auto updates, incremental updates, rebuilds, and index progress.',
              )}
            >
              {!canUseIndexMaintenance && (
                <div className="smtcmp-muted-note">
                  {t(
                    'settings.rag.maintenanceUnavailableHint',
                    'Prepare PGlite resources above before running index maintenance or embedding database management.',
                  )}
                </div>
              )}

              <ObsidianSetting
                name={t('settings.rag.autoUpdate', '自动更新索引')}
                desc={t(
                  'settings.rag.autoUpdateDesc',
                  '当包含模式下的文件夹内容有变化时，按设定的最小间隔自动执行增量更新；默认每日一次。',
                )}
                className="smtcmp-settings-card"
              >
                <ObsidianToggle
                  value={!!settings.ragOptions.autoUpdateEnabled}
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
                name={t('settings.rag.manualUpdateNow', '立即更新索引')}
                desc={t(
                  'settings.rag.manualUpdateNowDesc',
                  '手动执行一次增量更新，并记录最近更新时间。',
                )}
                className="smtcmp-settings-card"
              >
                <ObsidianButton
                  text={t('settings.rag.manualUpdateNow', '立即更新')}
                  disabled={isIndexing || !canUseIndexMaintenance}
                  onClick={() => {
                    void (async () => {
                      const abortController = new AbortController()
                      setIndexAbortController(abortController)
                      setIsIndexing(true)
                      setIndexProgress(null)
                      try {
                        const ragEngine = await plugin.getRAGEngine()
                        await ragEngine.updateVaultIndex(
                          { reindexAll: false, signal: abortController.signal },
                          (queryProgress) => {
                            if (queryProgress.type === 'indexing') {
                              handleIndexProgress(queryProgress.indexProgress)
                            }
                          },
                        )
                        await plugin.setSettings({
                          ...plugin.settings,
                          ragOptions: {
                            ...plugin.settings.ragOptions,
                            lastAutoUpdateAt: Date.now(),
                          },
                        })
                        new Notice(t('notices.indexUpdated'))
                      } catch (error) {
                        if (
                          error instanceof DOMException &&
                          error.name === 'AbortError'
                        ) {
                          new Notice(t('notices.indexCancelled', '索引已取消'))
                        } else {
                          console.error('Failed to update index:', error)
                          new Notice(t('notices.indexUpdateFailed'))
                        }
                      } finally {
                        setIsIndexing(false)
                        setIndexAbortController(null)
                        setTimeout(() => setIndexProgress(null), 3000)
                      }
                    })()
                  }}
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.rag.manageEmbeddingDatabase')}
                className="smtcmp-settings-card"
              >
                <div className="smtcmp-flex-row-gap-8">
                  <ObsidianButton
                    text={t('settings.rag.manage')}
                    disabled={!canUseIndexMaintenance}
                    onClick={() => {
                      new EmbeddingDbManageModal(app, plugin).open()
                    }}
                  />
                  <ObsidianButton
                    text={t('settings.rag.rebuildIndex', '重建索引')}
                    disabled={isIndexing || !canUseIndexMaintenance}
                    onClick={() => {
                      void (async () => {
                        const abortController = new AbortController()
                        setIndexAbortController(abortController)
                        setIsIndexing(true)
                        setIndexProgress(null)
                        try {
                          const ragEngine = await plugin.getRAGEngine()
                          await ragEngine.updateVaultIndex(
                            {
                              reindexAll: true,
                              signal: abortController.signal,
                            },
                            (queryProgress) => {
                              if (queryProgress.type === 'indexing') {
                                handleIndexProgress(queryProgress.indexProgress)
                              }
                            },
                          )
                          new Notice(t('notices.rebuildComplete'))
                          await plugin.setSettings({
                            ...plugin.settings,
                            ragOptions: {
                              ...plugin.settings.ragOptions,
                              lastAutoUpdateAt: Date.now(),
                            },
                          })
                        } catch (error) {
                          if (
                            error instanceof DOMException &&
                            error.name === 'AbortError'
                          ) {
                            new Notice(
                              t('notices.indexCancelled', '索引已取消'),
                            )
                          } else {
                            console.error('Failed to rebuild index:', error)
                            new Notice(t('notices.rebuildFailed'))
                          }
                        } finally {
                          setIsIndexing(false)
                          setIndexAbortController(null)
                          setTimeout(() => setIndexProgress(null), 3000)
                        }
                      })()
                    }}
                  />
                  {isIndexing && indexAbortController && (
                    <ObsidianButton
                      text={t('settings.rag.cancelIndex', '取消')}
                      onClick={() => {
                        console.debug('[YOLO] Cancel button clicked')
                        indexAbortController.abort()
                        new Notice(
                          t('notices.indexCancelling', '正在取消索引...'),
                        )
                      }}
                    />
                  )}
                </div>
              </ObsidianSetting>

              <div className="smtcmp-provider-section">
                <div
                  className="smtcmp-provider-header smtcmp-clickable"
                  onClick={() => setIsProgressOpen((v) => !v)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setIsProgressOpen((v) => !v)
                    }
                  }}
                >
                  <div className="smtcmp-provider-expand-btn">
                    {isProgressOpen ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                  </div>

                  <div className="smtcmp-provider-info">
                    <span className="smtcmp-provider-id">
                      {t(
                        'settings.rag.indexProgressTitle',
                        'RAG Index Progress',
                      )}
                    </span>
                    {headerPercent !== null ? (
                      <span className="smtcmp-provider-type">
                        {headerPercent}%
                      </span>
                    ) : (
                      <span className="smtcmp-provider-type">
                        {isIndexing
                          ? t('settings.rag.indexing', 'In progress')
                          : t('settings.rag.notStarted', 'Not started')}
                      </span>
                    )}
                  </div>
                </div>

                {isProgressOpen && (
                  <div className="smtcmp-provider-models">
                    <RAGIndexProgress
                      progress={effectiveProgress}
                      isIndexing={isIndexing}
                      getMarkdownFilesInFolder={(folderPath: string) => {
                        const files = plugin.app.vault.getMarkdownFiles()
                        const paths = files.map((f) => f.path)
                        if (folderPath === '') {
                          return paths.filter((p) => !p.includes('/'))
                        }
                        const prefix = folderPath + '/'
                        return paths.filter(
                          (p) =>
                            p.startsWith(prefix) &&
                            !p.slice(prefix.length).includes('/'),
                        )
                      }}
                    />
                  </div>
                )}
              </div>
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

                  <ObsidianSetting
                    name={t(
                      'settings.rag.autoUpdateInterval',
                      '最小间隔(小时)',
                    )}
                    desc={t(
                      'settings.rag.autoUpdateIntervalDesc',
                      '到达该间隔才会触发自动更新；用于避免频繁重建。',
                    )}
                    className="smtcmp-settings-card"
                  >
                    <ObsidianTextInput
                      value={autoUpdateIntervalInput}
                      placeholder="24"
                      onChange={(value) => {
                        setAutoUpdateIntervalInput(value)
                        const intervalHours = parseIntegerInput(value)
                        if (intervalHours !== null && intervalHours > 0) {
                          applySettingsUpdate({
                            ...settings,
                            ragOptions: {
                              ...settings.ragOptions,
                              autoUpdateIntervalHours: intervalHours,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const intervalHours = parseIntegerInput(
                          autoUpdateIntervalInput,
                        )
                        if (intervalHours === null || intervalHours <= 0) {
                          setAutoUpdateIntervalInput(
                            String(
                              settings.ragOptions.autoUpdateIntervalHours ?? 0,
                            ),
                          )
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
