import { Notice } from 'obsidian'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { RECOMMENDED_MODELS_FOR_EMBEDDING } from '../../constants'
import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import {
  DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_TRIGGERS,
  type TabCompletionTrigger,
} from '../../settings/schema/setting.types'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import { findFilesMatchingPatterns } from '../../utils/glob-utils'
import { getModelDisplayName } from '../../utils/model-id-utils'
import {
  folderPathsToIncludePatterns,
  includePatternsToFolderPaths,
} from '../../utils/rag-utils'
import { ObsidianButton } from '../common/ObsidianButton'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../common/ObsidianDropdown'
import { ObsidianTextArea } from '../common/ObsidianTextArea'
import { ObsidianTextInput } from '../common/ObsidianTextInput'
import { ObsidianToggle } from '../common/ObsidianToggle'
import { SimpleSelect } from '../common/SimpleSelect'
import { FolderSelectionList } from '../settings/inputs/FolderSelectionList'
import { EmbeddingDbManageModal } from '../settings/modals/EmbeddingDbManageModal'
import { ExcludedFilesModal } from '../settings/modals/ExcludedFilesModal'
import { IncludedFilesModal } from '../settings/modals/IncludedFilesModal'
import { SmartSpaceQuickActionsSettings } from '../settings/SmartSpaceQuickActionsSettings'

type ComposerProps = {
  onNavigateChat?: () => void
}

type SparkleTab = 'smart-space' | 'quick-ask' | 'tab-completion'

type NumberInputState = {
  [key: string]: string
}

const Composer: React.FC<ComposerProps> = (_props) => {
  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const composerRef = useRef<HTMLDivElement>(null)

  const [activeTab, setActiveTab] = useState<SparkleTab>('smart-space')
  const [showRagAdvanced, setShowRagAdvanced] = useState(false)
  const [showTabAdvanced, setShowTabAdvanced] = useState(false)
  const [isIndexing, setIsIndexing] = useState(false)
  const [indexAbortController, setIndexAbortController] =
    useState<AbortController | null>(null)

  const orderedEnabledModels = useMemo(() => {
    const enabledModels = settings.chatModels.filter(
      ({ enable }) => enable ?? true,
    )
    const providerOrder = settings.providers.map((p) => p.id)
    const providerIdsInModels = Array.from(
      new Set(enabledModels.map((m) => m.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]
    return orderedProviderIds.flatMap((pid) =>
      enabledModels.filter((m) => m.providerId === pid),
    )
  }, [settings.chatModels, settings.providers])

  const tabCompletionOptionGroups = useMemo(() => {
    const providerOrder = settings.providers.map((p) => p.id)
    const providerIdsInModels = Array.from(
      new Set(orderedEnabledModels.map((model) => model.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]

    return orderedProviderIds
      .map((providerId) => {
        const models = orderedEnabledModels.filter(
          (model) => model.providerId === providerId,
        )
        if (models.length === 0) return null
        return {
          label: providerId,
          options: models.map((model) => ({
            value: model.id,
            label: model.name?.trim()
              ? model.name.trim()
              : model.model || getModelDisplayName(model.id),
          })),
        }
      })
      .filter(
        (
          group,
        ): group is {
          label: string
          options: { value: string; label: string }[]
        } => group !== null,
      )
  }, [orderedEnabledModels, settings.providers])

  const updateContinuationOptions = useCallback(
    (updates: Partial<SmartComposerSettings['continuationOptions']>) => {
      void setSettings({
        ...settings,
        continuationOptions: {
          ...settings.continuationOptions,
          ...updates,
        },
      })
    },
    [setSettings, settings],
  )

  const applySettingsUpdate = useCallback(
    (nextSettings: SmartComposerSettings, errorMessage: string) => {
      void (async () => {
        try {
          await setSettings(nextSettings)
        } catch (error: unknown) {
          console.error('[Sparkle] ' + errorMessage, error)
          new Notice(errorMessage)
        }
      })()
    },
    [setSettings],
  )

  const isRagEnabled = settings.ragOptions.enabled ?? true
  const includeFolders = useMemo(
    () => includePatternsToFolderPaths(settings.ragOptions.includePatterns),
    [settings.ragOptions.includePatterns],
  )
  const excludeFolders = useMemo(
    () => includePatternsToFolderPaths(settings.ragOptions.excludePatterns),
    [settings.ragOptions.excludePatterns],
  )

  const parseIntegerInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^-?\d+$/.test(trimmed)) return null
    return parseInt(trimmed, 10)
  }

  const parseFloatInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^-?\d*(?:\.\d*)?$/.test(trimmed)) return null
    if (
      trimmed === '-' ||
      trimmed === '.' ||
      trimmed === '-.' ||
      trimmed.endsWith('.')
    ) {
      return null
    }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  const [ragNumberInputs, setRagNumberInputs] = useState<NumberInputState>({
    chunkSize: String(settings.ragOptions.chunkSize),
    thresholdTokens: String(settings.ragOptions.thresholdTokens),
    minSimilarity: String(settings.ragOptions.minSimilarity),
    limit: String(settings.ragOptions.limit),
    autoUpdateIntervalHours: String(
      settings.ragOptions.autoUpdateIntervalHours ?? 24,
    ),
  })

  useEffect(() => {
    setRagNumberInputs((prev) => ({
      ...prev,
      chunkSize: String(settings.ragOptions.chunkSize),
      thresholdTokens: String(settings.ragOptions.thresholdTokens),
      minSimilarity: String(settings.ragOptions.minSimilarity),
      limit: String(settings.ragOptions.limit),
      autoUpdateIntervalHours: String(
        settings.ragOptions.autoUpdateIntervalHours ?? 24,
      ),
    }))
  }, [
    settings.ragOptions.chunkSize,
    settings.ragOptions.thresholdTokens,
    settings.ragOptions.minSimilarity,
    settings.ragOptions.limit,
    settings.ragOptions.autoUpdateIntervalHours,
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
      t('settings.defaults.recommendedBadge', '(Recommended)') ??
      '(Recommended)'

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

  const enableSmartSpace = settings.continuationOptions.enableSmartSpace ?? true
  const smartSpaceTriggerMode =
    settings.continuationOptions.smartSpaceTriggerMode ?? 'single-space'
  const enableSelectionChat =
    settings.continuationOptions.enableSelectionChat ?? true

  const enableQuickAsk = settings.continuationOptions.enableQuickAsk ?? true
  const quickAskTrigger = settings.continuationOptions.quickAskTrigger ?? '@'

  const enableTabCompletion = Boolean(
    settings.continuationOptions.enableTabCompletion,
  )
  const tabCompletionOptions = {
    ...DEFAULT_TAB_COMPLETION_OPTIONS,
    ...(settings.continuationOptions.tabCompletionOptions ?? {}),
  }
  const tabCompletionLengthPreset =
    settings.continuationOptions.tabCompletionLengthPreset ??
    DEFAULT_TAB_COMPLETION_LENGTH_PRESET
  const tabCompletionLengthPresetIndex = Math.max(
    0,
    ['short', 'medium', 'long'].indexOf(tabCompletionLengthPreset),
  )
  const tabCompletionTriggers: TabCompletionTrigger[] =
    settings.continuationOptions.tabCompletionTriggers ??
    DEFAULT_TAB_COMPLETION_TRIGGERS

  const [tabNumberInputs, setTabNumberInputs] = useState<NumberInputState>({
    maxSuggestionLength: String(tabCompletionOptions.maxSuggestionLength),
    triggerDelayMs: String(tabCompletionOptions.triggerDelayMs),
    contextRange: String(tabCompletionOptions.contextRange),
    minContextLength: String(tabCompletionOptions.minContextLength),
    temperature: String(tabCompletionOptions.temperature),
    requestTimeoutMs: String(tabCompletionOptions.requestTimeoutMs),
  })

  useEffect(() => {
    setTabNumberInputs({
      maxSuggestionLength: String(tabCompletionOptions.maxSuggestionLength),
      triggerDelayMs: String(tabCompletionOptions.triggerDelayMs),
      contextRange: String(tabCompletionOptions.contextRange),
      minContextLength: String(tabCompletionOptions.minContextLength),
      temperature: String(tabCompletionOptions.temperature),
      requestTimeoutMs: String(tabCompletionOptions.requestTimeoutMs),
    })
  }, [
    tabCompletionOptions.maxSuggestionLength,
    tabCompletionOptions.triggerDelayMs,
    tabCompletionOptions.contextRange,
    tabCompletionOptions.minContextLength,
    tabCompletionOptions.temperature,
    tabCompletionOptions.requestTimeoutMs,
  ])

  const updateTabCompletionOptions = (
    updates: Partial<typeof tabCompletionOptions>,
  ) => {
    updateContinuationOptions({
      tabCompletionOptions: {
        ...tabCompletionOptions,
        ...updates,
      },
    })
  }

  const updateTabCompletionTriggers = (
    nextTriggers: TabCompletionTrigger[],
  ) => {
    updateContinuationOptions({ tabCompletionTriggers: nextTriggers })
  }

  const createTriggerId = () =>
    `tab-trigger-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`

  const handleTriggerChange = (
    id: string,
    patch: Partial<TabCompletionTrigger>,
  ) => {
    const next = tabCompletionTriggers.map((trigger) =>
      trigger.id === id ? { ...trigger, ...patch } : trigger,
    )
    updateTabCompletionTriggers(next)
  }

  const handleAddTrigger = () => {
    const nextTrigger: TabCompletionTrigger = {
      id: createTriggerId(),
      type: 'string',
      pattern: '',
      enabled: true,
      description: '',
    }
    updateTabCompletionTriggers([...tabCompletionTriggers, nextTrigger])
  }

  const handleRemoveTrigger = (id: string) => {
    const next = tabCompletionTriggers.filter((trigger) => trigger.id !== id)
    updateTabCompletionTriggers(next)
  }

  const tabCompletionModelId =
    settings.continuationOptions.tabCompletionModelId ??
    settings.continuationOptions.continuationModelId ??
    orderedEnabledModels[0]?.id ??
    ''

  const handleRagUpdate = (reindexAll: boolean) => {
    void (async () => {
      const abortController = new AbortController()
      setIndexAbortController(abortController)
      setIsIndexing(true)

      try {
        if (reindexAll) {
          try {
            const dbManager = await plugin.getDbManager()
            const resourceCheck = await dbManager.checkPGliteResources()
            if (!resourceCheck.available) {
              new Notice(
                t(
                  'notices.pgliteUnavailable',
                  'PGlite resources unavailable. Please reinstall the plugin.',
                ),
                5000,
              )
              return
            }
          } catch (error) {
            console.warn('Failed to check PGlite resources:', error)
          }
        }

        const ragEngine = await plugin.getRAGEngine()
        await ragEngine.updateVaultIndex(
          { reindexAll, signal: abortController.signal },
          () => {
            return
          },
        )

        await plugin.setSettings({
          ...plugin.settings,
          ragOptions: {
            ...plugin.settings.ragOptions,
            lastAutoUpdateAt: Date.now(),
          },
        })

        new Notice(
          reindexAll ? t('notices.rebuildComplete') : t('notices.indexUpdated'),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          new Notice(t('notices.indexCancelled', '索引已取消'))
        } else {
          console.error('Failed to update index:', error)
          new Notice(
            reindexAll
              ? t('notices.rebuildFailed')
              : t('notices.indexUpdateFailed'),
          )
        }
      } finally {
        setIsIndexing(false)
        setIndexAbortController(null)
      }
    })()
  }

  const handleCancelIndex = () => {
    if (!indexAbortController) return
    indexAbortController.abort()
    new Notice(t('notices.indexCancelling', '正在取消索引...'))
  }

  return (
    <div className="smtcmp-composer-container" ref={composerRef}>
      <div
        className="smtcmp-composer-tabs smtcmp-composer-tabs--glider"
        role="tablist"
        style={
          {
            '--smtcmp-tab-count': 3,
            '--smtcmp-tab-index': ['smart-space', 'quick-ask', 'tab-completion']
              .indexOf(activeTab),
          } as React.CSSProperties
        }
      >
        <div className="smtcmp-composer-tabs-glider" aria-hidden="true" />
        <button
          className={`smtcmp-composer-tab${
            activeTab === 'smart-space' ? ' is-active' : ''
          }`}
          onClick={() => setActiveTab('smart-space')}
          role="tab"
          aria-selected={activeTab === 'smart-space'}
        >
          {t('settings.continuation.customSubsectionTitle', 'Smart Space')}
        </button>
        <button
          className={`smtcmp-composer-tab${
            activeTab === 'quick-ask' ? ' is-active' : ''
          }`}
          onClick={() => setActiveTab('quick-ask')}
          role="tab"
          aria-selected={activeTab === 'quick-ask'}
        >
          {t('settings.continuation.quickAskSubsectionTitle', 'Quick Ask')}
        </button>
        <button
          className={`smtcmp-composer-tab${
            activeTab === 'tab-completion' ? ' is-active' : ''
          }`}
          onClick={() => setActiveTab('tab-completion')}
          role="tab"
          aria-selected={activeTab === 'tab-completion'}
        >
          {t('settings.continuation.tabSubsectionTitle', 'Tab completion')}
        </button>
      </div>

      <div className="smtcmp-composer-scroll">
        {activeTab === 'smart-space' && (
          <>
            <section className="smtcmp-composer-section">
              <header className="smtcmp-composer-heading">
                <div className="smtcmp-composer-heading-title">
                  {t(
                    'settings.continuation.smartSpaceToggle',
                    '启用 Smart Space',
                  )}
                </div>
                <div className="smtcmp-composer-heading-desc">
                  {t(
                    'settings.continuation.smartSpaceDescription',
                    'Smart Space 在空行触发，为续写与快速操作提供入口。',
                  )}
                </div>
              </header>

              <div className="smtcmp-composer-option">
                <div className="smtcmp-composer-option-info">
                  <div className="smtcmp-composer-option-title">
                    {t(
                      'settings.continuation.smartSpaceToggle',
                      '启用 Smart Space',
                    )}
                  </div>
                  <div className="smtcmp-composer-option-desc">
                    {t(
                      'settings.continuation.smartSpaceToggleDesc',
                      '关闭后将不会触发 Smart Space 浮动面板。',
                    )}
                  </div>
                </div>
                <div className="smtcmp-composer-option-control">
                  <ObsidianToggle
                    value={enableSmartSpace}
                    onChange={(value) =>
                      updateContinuationOptions({ enableSmartSpace: value })
                    }
                  />
                </div>
              </div>

              {enableSmartSpace && (
                <>
                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t(
                          'settings.continuation.smartSpaceTriggerMode',
                          '触发模式',
                        )}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.continuation.smartSpaceTriggerModeDesc',
                          '定义在空行按下空格时的触发方式。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control smtcmp-composer-option-control--fluid">
                      <div className="smtcmp-simple-select-wrapper">
                        <SimpleSelect
                          value={smartSpaceTriggerMode}
                          options={[
                            {
                              value: 'single-space',
                              label: t(
                                'settings.continuation.smartSpaceTriggerModeSingle',
                                '单空格触发',
                              ),
                            },
                            {
                              value: 'double-space',
                              label: t(
                                'settings.continuation.smartSpaceTriggerModeDouble',
                                '双空格触发',
                              ),
                            },
                            {
                              value: 'off',
                              label: t(
                                'settings.continuation.smartSpaceTriggerModeOff',
                                '关闭',
                              ),
                            },
                          ]}
                          onChange={(value) => {
                            updateContinuationOptions({
                              smartSpaceTriggerMode: value as
                                | 'single-space'
                                | 'double-space'
                                | 'off',
                            })
                          }}
                          align="end"
                          side="bottom"
                          sideOffset={6}
                          collisionBoundary={composerRef.current}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t(
                          'settings.continuation.selectionChatToggle',
                          'Selection Chat',
                        )}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.continuation.selectionChatToggleDesc',
                          '选中文本后显示快捷操作面板。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control">
                      <ObsidianToggle
                        value={enableSelectionChat}
                        onChange={(value) =>
                          updateContinuationOptions({
                            enableSelectionChat: value,
                          })
                        }
                      />
                    </div>
                  </div>
                </>
              )}
            </section>

            {enableSmartSpace && (
              <section className="smtcmp-composer-section">
                <header className="smtcmp-composer-heading">
                  <div className="smtcmp-composer-heading-title">
                    {t('settings.smartSpace.quickActionsTitle', '快捷动作')}
                  </div>
                  <div className="smtcmp-composer-heading-desc">
                    {t(
                      'settings.smartSpace.quickActionsDesc',
                      '自定义 Smart Space 中显示的快捷选项和提示词。',
                    )}
                  </div>
                </header>
                <SmartSpaceQuickActionsSettings />
              </section>
            )}

            <section className="smtcmp-composer-section">
              <header className="smtcmp-composer-heading">
                <div className="smtcmp-composer-heading-title">
                  {t('settings.rag.title', 'RAG 索引')}
                </div>
                <div className="smtcmp-composer-heading-desc">
                  {t(
                    'settings.rag.enableRagDesc',
                    '为 Sparkle 提供知识库检索与上下文增强。',
                  )}
                </div>
              </header>

              <div className="smtcmp-composer-option">
                <div className="smtcmp-composer-option-info">
                  <div className="smtcmp-composer-option-title">
                    {t('settings.rag.enableRag', '启用 RAG')}
                  </div>
                  <div className="smtcmp-composer-option-desc">
                    {t(
                      'settings.rag.enableRagDesc',
                      '开启后将使用向量检索增强回答。',
                    )}
                  </div>
                </div>
                <div className="smtcmp-composer-option-control">
                  <ObsidianToggle
                    value={isRagEnabled}
                    onChange={(value) => {
                      applySettingsUpdate(
                        {
                          ...settings,
                          ragOptions: {
                            ...settings.ragOptions,
                            enabled: value,
                          },
                        },
                        t(
                          'notices.indexUpdateFailed',
                          'Failed to update RAG settings.',
                        ),
                      )
                    }}
                  />
                </div>
              </div>

              {isRagEnabled && (
                <>
                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t('settings.rag.embeddingModel', 'Embedding 模型')}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.rag.embeddingModelDesc',
                          '用于生成向量索引的模型。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control smtcmp-composer-option-control--fluid">
                      <div className="smtcmp-simple-select-wrapper">
                        <SimpleSelect
                          value={settings.embeddingModelId}
                          groupedOptions={embeddingModelOptionGroups.map(
                            (group) => ({
                              label: group.label,
                              options: group.options.map((option) => ({
                                value: option.value,
                                label: option.label,
                              })),
                            }),
                          )}
                          onChange={(value) => {
                            applySettingsUpdate(
                              {
                                ...settings,
                                embeddingModelId: value,
                              },
                              t(
                                'notices.indexUpdateFailed',
                                'Failed to update embedding model.',
                              ),
                            )
                          }}
                          align="end"
                          side="bottom"
                          sideOffset={6}
                          collisionBoundary={composerRef.current}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t('settings.rag.includePatterns', '包含的文件夹')}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.rag.includePatternsDesc',
                          '只索引这些目录；留空表示全库。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control">
                      <ObsidianButton
                        text={t('settings.rag.testPatterns', '测试规则')}
                        onClick={() => {
                          void (async () => {
                            const patterns = settings.ragOptions.includePatterns
                            const includedFiles =
                              await findFilesMatchingPatterns(
                                patterns,
                                plugin.app.vault,
                              )
                            new IncludedFilesModal(
                              app,
                              includedFiles,
                              patterns,
                            ).open()
                          })().catch((error) => {
                            console.error(
                              'Failed to test include patterns',
                              error,
                            )
                          })
                        }}
                      />
                    </div>
                  </div>

                  <div className="smtcmp-composer-context-picker">
                    <FolderSelectionList
                      app={app}
                      vault={plugin.app.vault}
                      title={t(
                        'settings.rag.selectedFolders',
                        '已选择的文件夹',
                      )}
                      value={includeFolders}
                      onChange={(folders: string[]) => {
                        const patterns = folderPathsToIncludePatterns(folders)
                        applySettingsUpdate(
                          {
                            ...settings,
                            ragOptions: {
                              ...settings.ragOptions,
                              includePatterns: patterns,
                            },
                          },
                          t(
                            'notices.indexUpdateFailed',
                            'Failed to update include patterns.',
                          ),
                        )
                      }}
                    />
                  </div>

                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t('settings.rag.excludePatterns', '排除的文件夹')}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.rag.excludePatternsDesc',
                          '这些目录不会参与索引。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control">
                      <ObsidianButton
                        text={t('settings.rag.testPatterns', '测试规则')}
                        onClick={() => {
                          void (async () => {
                            const patterns = settings.ragOptions.excludePatterns
                            const excludedFiles =
                              await findFilesMatchingPatterns(
                                patterns,
                                plugin.app.vault,
                              )
                            new ExcludedFilesModal(app, excludedFiles).open()
                          })().catch((error) => {
                            console.error(
                              'Failed to test exclude patterns',
                              error,
                            )
                          })
                        }}
                      />
                    </div>
                  </div>

                  <div className="smtcmp-composer-context-picker">
                    <FolderSelectionList
                      app={app}
                      vault={plugin.app.vault}
                      title={t(
                        'settings.rag.excludedFolders',
                        '已排除的文件夹',
                      )}
                      placeholder={t(
                        'settings.rag.selectExcludeFoldersPlaceholder',
                        '点击此处选择要排除的文件夹（留空则不排除）',
                      )}
                      value={excludeFolders}
                      onChange={(folders: string[]) => {
                        const patterns = folderPathsToIncludePatterns(folders)
                        applySettingsUpdate(
                          {
                            ...settings,
                            ragOptions: {
                              ...settings.ragOptions,
                              excludePatterns: patterns,
                            },
                          },
                          t(
                            'notices.indexUpdateFailed',
                            'Failed to update exclude patterns.',
                          ),
                        )
                      }}
                    />
                  </div>

                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t('settings.rag.autoUpdate', '自动更新索引')}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.rag.autoUpdateDesc',
                          '文件变更后按最小间隔增量更新索引。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control">
                      <ObsidianToggle
                        value={!!settings.ragOptions.autoUpdateEnabled}
                        onChange={(value) => {
                          applySettingsUpdate(
                            {
                              ...settings,
                              ragOptions: {
                                ...settings.ragOptions,
                                autoUpdateEnabled: value,
                              },
                            },
                            t(
                              'notices.indexUpdateFailed',
                              'Failed to update auto update settings.',
                            ),
                          )
                        }}
                      />
                    </div>
                  </div>

                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t('settings.rag.manualUpdateNow', '立即更新索引')}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.rag.manualUpdateNowDesc',
                          '手动执行一次增量更新。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control smtcmp-composer-option-control--stack">
                      <ObsidianButton
                        text={t('settings.rag.manualUpdateNow', '立即更新')}
                        disabled={isIndexing}
                        onClick={() => handleRagUpdate(false)}
                      />
                      <ObsidianButton
                        text={t('settings.rag.rebuildIndex', '重建索引')}
                        disabled={isIndexing}
                        onClick={() => handleRagUpdate(true)}
                      />
                      {isIndexing && indexAbortController && (
                        <ObsidianButton
                          text={t('settings.rag.cancelIndex', '取消')}
                          onClick={() => handleCancelIndex()}
                        />
                      )}
                    </div>
                  </div>

                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t(
                          'settings.rag.manageEmbeddingDatabase',
                          '管理索引数据',
                        )}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.rag.manageEmbeddingDatabaseDesc',
                          '查看向量库占用并管理索引。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control">
                      <ObsidianButton
                        text={t('settings.rag.manage', '管理')}
                        onClick={() => {
                          const modal = new EmbeddingDbManageModal(app, plugin)
                          modal.open()
                        }}
                      />
                    </div>
                  </div>

                  <div
                    className={`smtcmp-settings-advanced-toggle smtcmp-clickable${
                      showRagAdvanced ? ' is-expanded' : ''
                    }`}
                    onClick={() => setShowRagAdvanced((prev) => !prev)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setShowRagAdvanced((prev) => !prev)
                      }
                    }}
                  >
                    <span className="smtcmp-settings-advanced-toggle-icon">
                      ▶
                    </span>
                    {t('settings.rag.advanced', '高级设置')}
                  </div>

                  {showRagAdvanced && (
                    <>
                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t('settings.rag.chunkSize', 'Chunk 大小')}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.rag.chunkSizeDesc',
                              '单次切分的字符数。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control">
                          <ObsidianTextInput
                            type="number"
                            value={ragNumberInputs.chunkSize}
                            onChange={(value) => {
                              setRagNumberInputs((prev) => ({
                                ...prev,
                                chunkSize: value,
                              }))
                              const chunkSize = parseIntegerInput(value)
                              if (chunkSize === null) return
                              applySettingsUpdate(
                                {
                                  ...settings,
                                  ragOptions: {
                                    ...settings.ragOptions,
                                    chunkSize,
                                  },
                                },
                                t(
                                  'notices.indexUpdateFailed',
                                  'Failed to update chunk size.',
                                ),
                              )
                            }}
                            onBlur={(value) => {
                              const chunkSize = parseIntegerInput(value)
                              if (chunkSize === null) {
                                setRagNumberInputs((prev) => ({
                                  ...prev,
                                  chunkSize: String(
                                    settings.ragOptions.chunkSize,
                                  ),
                                }))
                              }
                            }}
                          />
                        </div>
                      </div>

                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t('settings.rag.thresholdTokens', '阈值 Token')}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.rag.thresholdTokensDesc',
                              '超过该值将触发分批索引。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control">
                          <ObsidianTextInput
                            type="number"
                            value={ragNumberInputs.thresholdTokens}
                            onChange={(value) => {
                              setRagNumberInputs((prev) => ({
                                ...prev,
                                thresholdTokens: value,
                              }))
                              const thresholdTokens = parseIntegerInput(value)
                              if (thresholdTokens === null) return
                              applySettingsUpdate(
                                {
                                  ...settings,
                                  ragOptions: {
                                    ...settings.ragOptions,
                                    thresholdTokens,
                                  },
                                },
                                t(
                                  'notices.indexUpdateFailed',
                                  'Failed to update threshold tokens.',
                                ),
                              )
                            }}
                            onBlur={(value) => {
                              const thresholdTokens = parseIntegerInput(value)
                              if (thresholdTokens === null) {
                                setRagNumberInputs((prev) => ({
                                  ...prev,
                                  thresholdTokens: String(
                                    settings.ragOptions.thresholdTokens,
                                  ),
                                }))
                              }
                            }}
                          />
                        </div>
                      </div>

                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t('settings.rag.minSimilarity', '最小相似度')}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.rag.minSimilarityDesc',
                              '低于该相似度的结果将被过滤。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control">
                          <ObsidianTextInput
                            type="number"
                            value={ragNumberInputs.minSimilarity}
                            onChange={(value) => {
                              setRagNumberInputs((prev) => ({
                                ...prev,
                                minSimilarity: value,
                              }))
                              const minSimilarity = parseFloatInput(value)
                              if (minSimilarity === null) return
                              applySettingsUpdate(
                                {
                                  ...settings,
                                  ragOptions: {
                                    ...settings.ragOptions,
                                    minSimilarity,
                                  },
                                },
                                t(
                                  'notices.indexUpdateFailed',
                                  'Failed to update min similarity.',
                                ),
                              )
                            }}
                            onBlur={(value) => {
                              const minSimilarity = parseFloatInput(value)
                              if (minSimilarity === null) {
                                setRagNumberInputs((prev) => ({
                                  ...prev,
                                  minSimilarity: String(
                                    settings.ragOptions.minSimilarity,
                                  ),
                                }))
                              }
                            }}
                          />
                        </div>
                      </div>

                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t('settings.rag.limit', '返回条数')}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.rag.limitDesc',
                              '每次检索返回的候选数量。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control">
                          <ObsidianTextInput
                            type="number"
                            value={ragNumberInputs.limit}
                            onChange={(value) => {
                              setRagNumberInputs((prev) => ({
                                ...prev,
                                limit: value,
                              }))
                              const limit = parseIntegerInput(value)
                              if (limit === null) return
                              applySettingsUpdate(
                                {
                                  ...settings,
                                  ragOptions: {
                                    ...settings.ragOptions,
                                    limit,
                                  },
                                },
                                t(
                                  'notices.indexUpdateFailed',
                                  'Failed to update limit.',
                                ),
                              )
                            }}
                            onBlur={(value) => {
                              const limit = parseIntegerInput(value)
                              if (limit === null) {
                                setRagNumberInputs((prev) => ({
                                  ...prev,
                                  limit: String(settings.ragOptions.limit),
                                }))
                              }
                            }}
                          />
                        </div>
                      </div>

                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t(
                              'settings.rag.autoUpdateInterval',
                              '最小更新间隔(小时)',
                            )}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.rag.autoUpdateIntervalDesc',
                              '控制自动更新的最低频率。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control">
                          <ObsidianTextInput
                            type="number"
                            value={ragNumberInputs.autoUpdateIntervalHours}
                            onChange={(value) => {
                              setRagNumberInputs((prev) => ({
                                ...prev,
                                autoUpdateIntervalHours: value,
                              }))
                              const n = parseIntegerInput(value)
                              if (n === null || n <= 0) return
                              applySettingsUpdate(
                                {
                                  ...settings,
                                  ragOptions: {
                                    ...settings.ragOptions,
                                    autoUpdateIntervalHours: n,
                                  },
                                },
                                t(
                                  'notices.indexUpdateFailed',
                                  'Failed to update interval.',
                                ),
                              )
                            }}
                            onBlur={(value) => {
                              const n = parseIntegerInput(value)
                              if (n === null || n <= 0) {
                                setRagNumberInputs((prev) => ({
                                  ...prev,
                                  autoUpdateIntervalHours: String(
                                    settings.ragOptions
                                      .autoUpdateIntervalHours ?? 24,
                                  ),
                                }))
                              }
                            }}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
          </>
        )}

        {activeTab === 'quick-ask' && (
          <>
            <section className="smtcmp-composer-section">
              <header className="smtcmp-composer-heading">
                <div className="smtcmp-composer-heading-title">
                  {t(
                    'settings.continuation.quickAskSubsectionTitle',
                    'Quick Ask',
                  )}
                </div>
                <div className="smtcmp-composer-heading-desc">
                  {t(
                    'settings.continuation.quickAskDescription',
                    '在空行输入触发字符快速呼出浮动聊天面板。',
                  )}
                </div>
              </header>

              <div className="smtcmp-composer-option">
                <div className="smtcmp-composer-option-info">
                  <div className="smtcmp-composer-option-title">
                    {t(
                      'settings.continuation.quickAskToggle',
                      '启用 Quick Ask',
                    )}
                  </div>
                  <div className="smtcmp-composer-option-desc">
                    {t(
                      'settings.continuation.quickAskToggleDesc',
                      '关闭后不会再触发 Quick Ask 浮动面板。',
                    )}
                  </div>
                </div>
                <div className="smtcmp-composer-option-control">
                  <ObsidianToggle
                    value={enableQuickAsk}
                    onChange={(value) =>
                      updateContinuationOptions({ enableQuickAsk: value })
                    }
                  />
                </div>
              </div>

              {enableQuickAsk && (
                <div className="smtcmp-composer-option">
                  <div className="smtcmp-composer-option-info">
                    <div className="smtcmp-composer-option-title">
                      {t('settings.continuation.quickAskTrigger', '触发字符')}
                    </div>
                    <div className="smtcmp-composer-option-desc">
                      {t(
                        'settings.continuation.quickAskTriggerDesc',
                        '支持 1-3 个字符。',
                      )}
                    </div>
                  </div>
                  <div className="smtcmp-composer-option-control">
                    <ObsidianTextInput
                      value={quickAskTrigger}
                      onChange={(value) => {
                        const trimmed = value.trim()
                        if (trimmed.length > 0 && trimmed.length <= 3) {
                          updateContinuationOptions({
                            quickAskTrigger: trimmed,
                          })
                        }
                      }}
                    />
                  </div>
                </div>
              )}
            </section>
          </>
        )}

        {activeTab === 'tab-completion' && (
          <>
            <section className="smtcmp-composer-section">
              <header className="smtcmp-composer-heading">
                <div className="smtcmp-composer-heading-title">
                  {t('settings.continuation.tabSubsectionTitle', 'Tab 补全')}
                </div>
                <div className="smtcmp-composer-heading-desc">
                  {t(
                    'settings.continuation.tabCompletionDesc',
                    '使用模型自动补全文本。',
                  )}
                </div>
              </header>

              <div className="smtcmp-composer-option">
                <div className="smtcmp-composer-option-info">
                  <div className="smtcmp-composer-option-title">
                    {t('settings.continuation.tabCompletion', '启用 Tab 补全')}
                  </div>
                  <div className="smtcmp-composer-option-desc">
                    {t(
                      'settings.continuation.tabCompletionDesc',
                      '开启后会在编辑器中自动触发补全建议。',
                    )}
                  </div>
                </div>
                <div className="smtcmp-composer-option-control">
                  <ObsidianToggle
                    value={enableTabCompletion}
                    onChange={(value) => {
                      updateContinuationOptions({
                        enableTabCompletion: value,
                        tabCompletionOptions: value
                          ? {
                              ...DEFAULT_TAB_COMPLETION_OPTIONS,
                              ...(settings.continuationOptions
                                .tabCompletionOptions ?? {}),
                            }
                          : settings.continuationOptions.tabCompletionOptions,
                      })
                    }}
                  />
                </div>
              </div>

              {enableTabCompletion && (
                <>
                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t(
                          'settings.continuation.tabCompletionModel',
                          '补全模型',
                        )}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.continuation.tabCompletionModelDesc',
                          '选择用于 Tab 补全的模型。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control smtcmp-composer-option-control--fluid">
                      <div className="smtcmp-simple-select-wrapper">
                        <SimpleSelect
                          value={tabCompletionModelId}
                          groupedOptions={tabCompletionOptionGroups}
                          onChange={(value) => {
                            updateContinuationOptions({
                              tabCompletionModelId: value,
                            })
                          }}
                          align="end"
                          side="bottom"
                          sideOffset={6}
                          collisionBoundary={composerRef.current}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t(
                          'settings.continuation.tabCompletionMaxSuggestionLength',
                          '最大补全长度',
                        )}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.continuation.tabCompletionMaxSuggestionLengthDesc',
                          '控制单次建议的最大长度。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control">
                      <ObsidianTextInput
                        type="number"
                        value={tabNumberInputs.maxSuggestionLength}
                        onChange={(value) => {
                          setTabNumberInputs((prev) => ({
                            ...prev,
                            maxSuggestionLength: value,
                          }))
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) return
                          const next = Math.max(20, parsed)
                          updateTabCompletionOptions({
                            maxSuggestionLength: next,
                          })
                        }}
                        onBlur={(value) => {
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) {
                            setTabNumberInputs((prev) => ({
                              ...prev,
                              maxSuggestionLength: String(
                                tabCompletionOptions.maxSuggestionLength,
                              ),
                            }))
                          }
                        }}
                      />
                    </div>
                  </div>

                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t(
                          'settings.continuation.tabCompletionLengthPreset',
                          '补全长度',
                        )}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.continuation.tabCompletionLengthPresetDesc',
                          '提示模型生成短、中、长三档补全。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control">
                      <div
                        className="smtcmp-segmented smtcmp-segmented--glider"
                        style={
                          {
                            '--smtcmp-segment-count': 3,
                            '--smtcmp-segment-index':
                              tabCompletionLengthPresetIndex,
                          } as React.CSSProperties
                        }
                      >
                        <div
                          className="smtcmp-segmented-glider"
                          aria-hidden="true"
                        />
                        <button
                          className={
                            tabCompletionLengthPreset === 'short'
                              ? 'active'
                              : ''
                          }
                          onClick={() => {
                            updateContinuationOptions({
                              tabCompletionLengthPreset: 'short',
                            })
                          }}
                        >
                          {t(
                            'settings.continuation.tabCompletionLengthPresetShort',
                          )}
                        </button>
                        <button
                          className={
                            tabCompletionLengthPreset === 'medium'
                              ? 'active'
                              : ''
                          }
                          onClick={() => {
                            updateContinuationOptions({
                              tabCompletionLengthPreset: 'medium',
                            })
                          }}
                        >
                          {t(
                            'settings.continuation.tabCompletionLengthPresetMedium',
                          )}
                        </button>
                        <button
                          className={
                            tabCompletionLengthPreset === 'long' ? 'active' : ''
                          }
                          onClick={() => {
                            updateContinuationOptions({
                              tabCompletionLengthPreset: 'long',
                            })
                          }}
                        >
                          {t(
                            'settings.continuation.tabCompletionLengthPresetLong',
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="smtcmp-composer-option">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t(
                          'settings.continuation.tabCompletionTriggerDelay',
                          '触发延迟',
                        )}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.continuation.tabCompletionTriggerDelayDesc',
                          '输入后延迟触发的毫秒数。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control">
                      <ObsidianTextInput
                        type="number"
                        value={tabNumberInputs.triggerDelayMs}
                        onChange={(value) => {
                          setTabNumberInputs((prev) => ({
                            ...prev,
                            triggerDelayMs: value,
                          }))
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) return
                          const next = Math.max(200, parsed)
                          updateTabCompletionOptions({ triggerDelayMs: next })
                        }}
                        onBlur={(value) => {
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) {
                            setTabNumberInputs((prev) => ({
                              ...prev,
                              triggerDelayMs: String(
                                tabCompletionOptions.triggerDelayMs,
                              ),
                            }))
                          }
                        }}
                      />
                    </div>
                  </div>

                  <div className="smtcmp-composer-option smtcmp-composer-option--table">
                    <div className="smtcmp-composer-option-info">
                      <div className="smtcmp-composer-option-title">
                        {t(
                          'settings.continuation.tabCompletionTriggersTitle',
                          '触发器',
                        )}
                      </div>
                      <div className="smtcmp-composer-option-desc">
                        {t(
                          'settings.continuation.tabCompletionTriggersDesc',
                          '配置补全触发规则。',
                        )}
                      </div>
                    </div>
                    <div className="smtcmp-composer-option-control smtcmp-composer-option-control--full">
                      <div className="smtcmp-settings-table-container">
                        <table className="smtcmp-settings-table">
                          <thead>
                            <tr>
                              <th>
                                {t(
                                  'settings.continuation.tabCompletionTriggerEnabled',
                                )}
                              </th>
                              <th>
                                {t(
                                  'settings.continuation.tabCompletionTriggerType',
                                )}
                              </th>
                              <th>
                                {t(
                                  'settings.continuation.tabCompletionTriggerPattern',
                                )}
                              </th>
                              <th>
                                {t(
                                  'settings.continuation.tabCompletionTriggerDescription',
                                )}
                              </th>
                              <th>
                                {t(
                                  'settings.continuation.tabCompletionTriggerRemove',
                                )}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {tabCompletionTriggers.map((trigger) => (
                              <tr key={trigger.id}>
                                <td>
                                  <ObsidianToggle
                                    value={trigger.enabled}
                                    onChange={(value) => {
                                      handleTriggerChange(trigger.id, {
                                        enabled: value,
                                      })
                                    }}
                                  />
                                </td>
                                <td>
                                  <ObsidianDropdown
                                    value={trigger.type}
                                    options={{
                                      string: t(
                                        'settings.continuation.tabCompletionTriggerTypeString',
                                      ),
                                      regex: t(
                                        'settings.continuation.tabCompletionTriggerTypeRegex',
                                      ),
                                    }}
                                    onChange={(value) => {
                                      handleTriggerChange(trigger.id, {
                                        type: value as 'string' | 'regex',
                                      })
                                    }}
                                  />
                                </td>
                                <td>
                                  <ObsidianTextInput
                                    value={trigger.pattern}
                                    onChange={(value) => {
                                      handleTriggerChange(trigger.id, {
                                        pattern: value,
                                      })
                                    }}
                                  />
                                </td>
                                <td>
                                  <ObsidianTextInput
                                    value={trigger.description ?? ''}
                                    onChange={(value) => {
                                      handleTriggerChange(trigger.id, {
                                        description: value,
                                      })
                                    }}
                                  />
                                </td>
                                <td>
                                  <ObsidianButton
                                    text={t(
                                      'settings.continuation.tabCompletionTriggerRemove',
                                    )}
                                    onClick={() =>
                                      handleRemoveTrigger(trigger.id)
                                    }
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr>
                              <td colSpan={5}>
                                <ObsidianButton
                                  text={t(
                                    'settings.continuation.tabCompletionTriggerAdd',
                                  )}
                                  onClick={handleAddTrigger}
                                />
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  </div>

                  <div
                    className={`smtcmp-settings-advanced-toggle smtcmp-clickable${
                      showTabAdvanced ? ' is-expanded' : ''
                    }`}
                    onClick={() => setShowTabAdvanced((prev) => !prev)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setShowTabAdvanced((prev) => !prev)
                      }
                    }}
                  >
                    <span className="smtcmp-settings-advanced-toggle-icon">
                      ▶
                    </span>
                    {t(
                      'settings.continuation.tabCompletionAdvanced',
                      '高级设置',
                    )}
                  </div>

                  {showTabAdvanced && (
                    <>
                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t(
                              'settings.continuation.tabCompletionContextRange',
                              '上下文范围',
                            )}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.continuation.tabCompletionContextRangeDesc',
                              '控制上下文范围大小。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control">
                          <ObsidianTextInput
                            type="number"
                            value={tabNumberInputs.contextRange}
                            onChange={(value) => {
                              setTabNumberInputs((prev) => ({
                                ...prev,
                                contextRange: value,
                              }))
                              const parsed = parseIntegerInput(value)
                              if (parsed === null) return
                              const next = Math.max(500, parsed)
                              updateTabCompletionOptions({ contextRange: next })
                            }}
                            onBlur={(value) => {
                              const parsed = parseIntegerInput(value)
                              if (parsed === null) {
                                setTabNumberInputs((prev) => ({
                                  ...prev,
                                  contextRange: String(
                                    tabCompletionOptions.contextRange,
                                  ),
                                }))
                              }
                            }}
                          />
                        </div>
                      </div>

                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t(
                              'settings.continuation.tabCompletionMinContextLength',
                              '最小上下文长度',
                            )}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.continuation.tabCompletionMinContextLengthDesc',
                              '低于该长度不会触发补全。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control">
                          <ObsidianTextInput
                            type="number"
                            value={tabNumberInputs.minContextLength}
                            onChange={(value) => {
                              setTabNumberInputs((prev) => ({
                                ...prev,
                                minContextLength: value,
                              }))
                              const parsed = parseIntegerInput(value)
                              if (parsed === null) return
                              const next = Math.max(0, parsed)
                              updateTabCompletionOptions({
                                minContextLength: next,
                              })
                            }}
                            onBlur={(value) => {
                              const parsed = parseIntegerInput(value)
                              if (parsed === null) {
                                setTabNumberInputs((prev) => ({
                                  ...prev,
                                  minContextLength: String(
                                    tabCompletionOptions.minContextLength,
                                  ),
                                }))
                              }
                            }}
                          />
                        </div>
                      </div>

                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t(
                              'settings.continuation.tabCompletionTemperature',
                              '温度',
                            )}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.continuation.tabCompletionTemperatureDesc',
                              '控制生成的发散程度。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control">
                          <ObsidianTextInput
                            type="number"
                            value={tabNumberInputs.temperature}
                            onChange={(value) => {
                              setTabNumberInputs((prev) => ({
                                ...prev,
                                temperature: value,
                              }))
                              const parsed = parseFloatInput(value)
                              if (parsed === null) return
                              updateTabCompletionOptions({
                                temperature: Math.min(Math.max(parsed, 0), 2),
                              })
                            }}
                            onBlur={(value) => {
                              const parsed = parseFloatInput(value)
                              if (parsed === null) {
                                setTabNumberInputs((prev) => ({
                                  ...prev,
                                  temperature: String(
                                    tabCompletionOptions.temperature,
                                  ),
                                }))
                              }
                            }}
                          />
                        </div>
                      </div>

                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t(
                              'settings.continuation.tabCompletionRequestTimeout',
                              '请求超时',
                            )}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.continuation.tabCompletionRequestTimeoutDesc',
                              '超过该时间将取消请求。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control">
                          <ObsidianTextInput
                            type="number"
                            value={tabNumberInputs.requestTimeoutMs}
                            onChange={(value) => {
                              setTabNumberInputs((prev) => ({
                                ...prev,
                                requestTimeoutMs: value,
                              }))
                              const parsed = parseIntegerInput(value)
                              if (parsed === null) return
                              const next = Math.max(1000, parsed)
                              updateTabCompletionOptions({
                                requestTimeoutMs: next,
                              })
                            }}
                            onBlur={(value) => {
                              const parsed = parseIntegerInput(value)
                              if (parsed === null) {
                                setTabNumberInputs((prev) => ({
                                  ...prev,
                                  requestTimeoutMs: String(
                                    tabCompletionOptions.requestTimeoutMs,
                                  ),
                                }))
                              }
                            }}
                          />
                        </div>
                      </div>

                      <div className="smtcmp-composer-option">
                        <div className="smtcmp-composer-option-info">
                          <div className="smtcmp-composer-option-title">
                            {t(
                              'settings.continuation.tabCompletionConstraints',
                              '补全约束',
                            )}
                          </div>
                          <div className="smtcmp-composer-option-desc">
                            {t(
                              'settings.continuation.tabCompletionConstraintsDesc',
                              '插入到补全提示词中的附加规则。',
                            )}
                          </div>
                        </div>
                        <div className="smtcmp-composer-option-control smtcmp-composer-option-control--full">
                          <ObsidianTextArea
                            value={
                              settings.continuationOptions
                                .tabCompletionConstraints ?? ''
                            }
                            onChange={(value: string) => {
                              updateContinuationOptions({
                                tabCompletionConstraints: value,
                              })
                            }}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

export default Composer
