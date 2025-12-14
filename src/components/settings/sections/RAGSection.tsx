import { ChevronDown, ChevronRight } from 'lucide-react'
import { App, Notice } from 'obsidian'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { RECOMMENDED_MODELS_FOR_EMBEDDING } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
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
  const { loadLocalStorage } = app as AppWithLocalStorage
  if (typeof loadLocalStorage === 'function') {
    const result = loadLocalStorage.call(app, key)
    return isPromiseLike(result) ? await result : result
  }
  return null
}

const saveAppLocalStorage = async (
  app: App,
  key: string,
  value: string,
): Promise<void> => {
  const { saveLocalStorage } = app as AppWithLocalStorage
  if (typeof saveLocalStorage === 'function') {
    const result = saveLocalStorage.call(app, key, value)
    if (isPromiseLike(result)) {
      await result
    }
  }
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
  const isRagEnabled = settings.ragOptions.enabled ?? true
  const effectiveProgress = indexProgress ?? persistedProgress
  const ragUpdateError = 'Failed to update RAG settings.'

  const applySettingsUpdate = useCallback(
    (nextSettings: typeof settings, errorMessage: string = ragUpdateError) => {
      void (async () => {
        try {
          await setSettings(nextSettings)
        } catch (error: unknown) {
          console.error('[Smart Composer] ' + errorMessage, error)
          new Notice(errorMessage)
        }
      })()
    },
    [ragUpdateError, setSettings],
  )

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

  // 处理索引进度更新
  const handleIndexProgress = useCallback((progress: IndexProgress) => {
    setIndexProgress(progress)
  }, [])

  // Minimal conflict detection (exclude overrides include)
  const conflictInfo = useMemo(() => {
    const inc = includeFolders
    const exc = excludeFolders
    const isParentOrSame = (parent: string, child: string) => {
      if (parent === '') return true // root covers all
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

      <ObsidianSetting
        name={t('settings.rag.enableRag')}
        desc={t('settings.rag.enableRagDesc')}
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
        <>
          <ObsidianSetting
            name={t('settings.rag.embeddingModel')}
            desc={t('settings.rag.embeddingModelDesc')}
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

          <ObsidianSetting
            name={t('settings.rag.includePatterns')}
            desc={t('settings.rag.includePatternsDesc')}
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
                  new IncludedFilesModal(app, includedFiles, patterns).open()
                })().catch((error) => {
                  console.error('Failed to test include patterns', error)
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting>
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

          <ObsidianSetting>
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

          <ObsidianSetting
            name={t('settings.rag.chunkSize')}
            desc={t('settings.rag.chunkSizeDesc')}
          >
            <ObsidianTextInput
              value={String(settings.ragOptions.chunkSize)}
              placeholder="1000"
              onChange={(value) => {
                const chunkSize = parseInt(value, 10)
                if (!isNaN(chunkSize)) {
                  applySettingsUpdate({
                    ...settings,
                    ragOptions: {
                      ...settings.ragOptions,
                      chunkSize,
                    },
                  })
                }
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.thresholdTokens')}
            desc={t('settings.rag.thresholdTokensDesc')}
          >
            <ObsidianTextInput
              value={String(settings.ragOptions.thresholdTokens)}
              placeholder="8192"
              onChange={(value) => {
                const thresholdTokens = parseInt(value, 10)
                if (!isNaN(thresholdTokens)) {
                  applySettingsUpdate({
                    ...settings,
                    ragOptions: {
                      ...settings.ragOptions,
                      thresholdTokens,
                    },
                  })
                }
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.minSimilarity')}
            desc={t('settings.rag.minSimilarityDesc')}
          >
            <ObsidianTextInput
              value={String(settings.ragOptions.minSimilarity)}
              placeholder="0.0"
              onChange={(value) => {
                // Allow decimal point and numbers only
                if (!/^[0-9.]*$/.test(value)) return

                // Ignore typing decimal point to prevent interference with the input
                if (value === '.' || value.endsWith('.')) return

                const minSimilarity = parseFloat(value)
                if (!isNaN(minSimilarity)) {
                  applySettingsUpdate({
                    ...settings,
                    ragOptions: {
                      ...settings.ragOptions,
                      minSimilarity,
                    },
                  })
                }
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.limit')}
            desc={t('settings.rag.limitDesc')}
          >
            <ObsidianTextInput
              value={String(settings.ragOptions.limit)}
              placeholder="10"
              onChange={(value) => {
                const limit = parseInt(value, 10)
                if (!isNaN(limit)) {
                  applySettingsUpdate({
                    ...settings,
                    ragOptions: {
                      ...settings.ragOptions,
                      limit,
                    },
                  })
                }
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.autoUpdate', '自动更新索引')}
            desc={t(
              'settings.rag.autoUpdateDesc',
              '当包含模式下的文件夹内容有变化时，按设定的最小间隔自动执行增量更新；默认每日一次。',
            )}
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
            name={t('settings.rag.autoUpdateInterval', '最小间隔(小时)')}
            desc={t(
              'settings.rag.autoUpdateIntervalDesc',
              '到达该间隔才会触发自动更新；用于避免频繁重建。',
            )}
          >
            <ObsidianTextInput
              value={String(settings.ragOptions.autoUpdateIntervalHours ?? 24)}
              placeholder="24"
              onChange={(v) => {
                const n = parseInt(v, 10)
                if (!isNaN(n) && n > 0) {
                  applySettingsUpdate({
                    ...settings,
                    ragOptions: {
                      ...settings.ragOptions,
                      autoUpdateIntervalHours: n,
                    },
                  })
                }
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.manualUpdateNow', '立即更新索引')}
            desc={t(
              'settings.rag.manualUpdateNowDesc',
              '手动执行一次增量更新，并记录最近更新时间。',
            )}
          >
            <ObsidianButton
              text={t('settings.rag.manualUpdateNow', '立即更新')}
              disabled={isIndexing}
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
                    // 记录更新时间
                    await plugin.setSettings({
                      ...plugin.settings,
                      ragOptions: {
                        ...plugin.settings.ragOptions,
                        lastAutoUpdateAt: Date.now(),
                      },
                    })
                    // i18n notice
                    new Notice(t('notices.indexUpdated'))
                  } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') {
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

          <ObsidianSetting name={t('settings.rag.manageEmbeddingDatabase')}>
            <div className="smtcmp-flex-row-gap-8">
              <ObsidianButton
                text={t('settings.rag.manage')}
                onClick={() => {
                  new EmbeddingDbManageModal(app, plugin).open()
                }}
              />
              <ObsidianButton
                text={t('settings.rag.rebuildIndex', '重建索引')}
                disabled={isIndexing}
                onClick={() => {
                  void (async () => {
                    // 预检查 PGlite 资源
                    try {
                      const dbManager = await plugin.getDbManager()
                      const resourceCheck =
                        await dbManager.checkPGliteResources()

                      if (!resourceCheck.available) {
                        new Notice(
                          t(
                            'notices.pgliteUnavailable',
                            'PGlite resources unavailable. Please check your network connection.',
                          ),
                          5000,
                        )
                        return
                      }

                      if (
                        resourceCheck.needsDownload &&
                        resourceCheck.fromCDN
                      ) {
                        new Notice(
                          t(
                            'notices.downloadingPglite',
                            'Downloading PGlite dependencies (~20MB). This may take a moment...',
                          ),
                          5000,
                        )
                      }
                    } catch (error) {
                      console.warn('Failed to check PGlite resources:', error)
                      // 继续执行，让实际的加载逻辑处理错误
                    }

                    const abortController = new AbortController()
                    setIndexAbortController(abortController)
                    setIsIndexing(true)
                    setIndexProgress(null)
                    try {
                      const ragEngine = await plugin.getRAGEngine()
                      await ragEngine.updateVaultIndex(
                        { reindexAll: true, signal: abortController.signal },
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
                      if (error instanceof DOMException && error.name === 'AbortError') {
                        new Notice(t('notices.indexCancelled', '索引已取消'))
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
                    console.log('[YOLO] Cancel button clicked')
                    indexAbortController.abort()
                    // 立即更新 UI 状态，不等待异步操作完成
                    new Notice(t('notices.indexCancelling', '正在取消索引...'))
                  }}
                />
              )}
            </div>
          </ObsidianSetting>

          {/* 折叠：RAG 索引进度（复用 Provider 折叠样式） */}
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
                  {t('settings.rag.indexProgressTitle', 'RAG Index Progress')}
                </span>
                {headerPercent !== null ? (
                  <span className="smtcmp-provider-type">{headerPercent}%</span>
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
                      // 根目录：只返回位于根的文件（无斜杠）
                      return paths.filter((p) => !p.includes('/'))
                    }
                    const prefix = folderPath + '/'
                    // 仅返回该文件夹的直接子文件（非递归）
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
        </>
      )}
    </div>
  )
}
