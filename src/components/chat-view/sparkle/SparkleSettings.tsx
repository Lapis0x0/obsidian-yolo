import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_TRIGGERS,
  type TabCompletionTrigger,
} from '../../../settings/schema/setting.types'
import type { YoloSettings } from '../../../settings/schema/setting.types'
import { getModelDisplayName } from '../../../utils/model-id-utils'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReasoningPanel } from '../../common/ReasoningPanel'
import { SimpleSelect } from '../../common/SimpleSelect'
import { ContinuationQuickActionsSettings } from '../../settings/ContinuationQuickActionsSettings'
import { SelectionChatActionsSettings } from '../../settings/SelectionChatActionsSettings'

type SparkleSettingsProps = {
  onNavigateChat?: () => void
}

type SparkleTab = 'quick-ask' | 'tab-completion'

type NumberInputState = {
  [key: string]: string
}

const SparkleSettings: React.FC<SparkleSettingsProps> = (_props) => {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const composerRef = useRef<HTMLDivElement>(null)

  const [activeTab, setActiveTab] = useState<SparkleTab>('tab-completion')

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
    (updates: Partial<YoloSettings['continuationOptions']>) => {
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

  const parseIntegerInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^-?\d+$/.test(trimmed)) return null
    return parseInt(trimmed, 10)
  }

  const enableSelectionChat =
    settings.continuationOptions.enableSelectionChat ?? true

  const enableQuickAsk = settings.continuationOptions.enableQuickAsk ?? true
  const quickAskTrigger = settings.continuationOptions.quickAskTrigger ?? '@'
  const quickAskContextBeforeChars =
    settings.continuationOptions.quickAskContextBeforeChars ?? 5000
  const quickAskContextAfterChars =
    settings.continuationOptions.quickAskContextAfterChars ?? 2000

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
    triggerDelayMs: String(tabCompletionOptions.triggerDelayMs),
    autoTriggerDelayMs: String(tabCompletionOptions.autoTriggerDelayMs),
    autoTriggerCooldownMs: String(tabCompletionOptions.autoTriggerCooldownMs),
    requestTimeoutSeconds: String(
      Math.max(
        1,
        Math.round(tabCompletionOptions.requestTimeoutMs / 1000) || 12,
      ),
    ),
  })
  const [quickAskNumberInputs, setQuickAskNumberInputs] =
    useState<NumberInputState>({
      contextBeforeChars: String(quickAskContextBeforeChars),
      contextAfterChars: String(quickAskContextAfterChars),
    })

  useEffect(() => {
    setTabNumberInputs({
      triggerDelayMs: String(tabCompletionOptions.triggerDelayMs),
      autoTriggerDelayMs: String(tabCompletionOptions.autoTriggerDelayMs),
      autoTriggerCooldownMs: String(tabCompletionOptions.autoTriggerCooldownMs),
      requestTimeoutSeconds: String(
        Math.max(
          1,
          Math.round(tabCompletionOptions.requestTimeoutMs / 1000) || 12,
        ),
      ),
    })
  }, [
    tabCompletionOptions.triggerDelayMs,
    tabCompletionOptions.autoTriggerDelayMs,
    tabCompletionOptions.autoTriggerCooldownMs,
    tabCompletionOptions.requestTimeoutMs,
  ])
  useEffect(() => {
    setQuickAskNumberInputs({
      contextBeforeChars: String(quickAskContextBeforeChars),
      contextAfterChars: String(quickAskContextAfterChars),
    })
  }, [quickAskContextBeforeChars, quickAskContextAfterChars])

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
      acceptMode: 'insert',
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
  const tabCompletionChatModel = useMemo(
    () =>
      orderedEnabledModels.find((m) => m.id === tabCompletionModelId) ?? null,
    [orderedEnabledModels, tabCompletionModelId],
  )

  return (
    <div className="yolo-composer-container" ref={composerRef}>
      <div
        className="yolo-composer-tabs yolo-composer-tabs--glider"
        role="tablist"
        style={
          {
            '--yolo-tab-count': 2,
            '--yolo-tab-index': ['tab-completion', 'quick-ask'].indexOf(
              activeTab,
            ),
          } as React.CSSProperties
        }
      >
        <div className="yolo-composer-tabs-glider" aria-hidden="true" />
        <button
          className={`yolo-composer-tab${
            activeTab === 'tab-completion' ? ' is-active' : ''
          }`}
          onClick={() => setActiveTab('tab-completion')}
          role="tab"
          aria-selected={activeTab === 'tab-completion'}
        >
          <span className="yolo-composer-tab-label">
            {t('settings.continuation.tabSubsectionTitle', 'Tab completion')}
          </span>
        </button>
        <button
          className={`yolo-composer-tab${
            activeTab === 'quick-ask' ? ' is-active' : ''
          }`}
          onClick={() => setActiveTab('quick-ask')}
          role="tab"
          aria-selected={activeTab === 'quick-ask'}
        >
          <span className="yolo-composer-tab-label">
            {t('settings.continuation.quickAskSubsectionTitle', 'Quick Ask')}
          </span>
        </button>
      </div>

      <div className="yolo-composer-scroll">
        {activeTab === 'quick-ask' && (
          <>
            <section className="yolo-composer-section">
              <header className="yolo-composer-heading">
                <div className="yolo-composer-heading-title">
                  {t(
                    'settings.continuation.quickAskSubsectionTitle',
                    'Quick Ask',
                  )}
                </div>
                <div className="yolo-composer-heading-desc">
                  {t(
                    'settings.continuation.quickAskDescription',
                    '在空行输入触发字符快速呼出浮动聊天面板。',
                  )}
                </div>
              </header>

              <div className="yolo-composer-option">
                <div className="yolo-composer-option-info">
                  <div className="yolo-composer-option-title">
                    {t(
                      'settings.continuation.quickAskToggle',
                      '启用 Quick Ask',
                    )}
                  </div>
                  <div className="yolo-composer-option-desc">
                    {t(
                      'settings.continuation.quickAskToggleDesc',
                      '关闭后不会再触发 Quick Ask 浮动面板。',
                    )}
                  </div>
                </div>
                <div className="yolo-composer-option-control">
                  <ObsidianToggle
                    value={enableQuickAsk}
                    onChange={(value) =>
                      updateContinuationOptions({ enableQuickAsk: value })
                    }
                  />
                </div>
              </div>

              {enableQuickAsk && (
                <>
                  <div className="yolo-composer-option">
                    <div className="yolo-composer-option-info">
                      <div className="yolo-composer-option-title">
                        {t('settings.continuation.quickAskTrigger', '触发字符')}
                      </div>
                      <div className="yolo-composer-option-desc">
                        {t(
                          'settings.continuation.quickAskTriggerDesc',
                          '支持 1-3 个字符。',
                        )}
                      </div>
                    </div>
                    <div className="yolo-composer-option-control">
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
                  <div className="yolo-composer-option">
                    <div className="yolo-composer-option-info">
                      <div className="yolo-composer-option-title">
                        {t(
                          'settings.continuation.quickAskContextBeforeChars',
                          '上文字符数',
                        )}
                      </div>
                      <div className="yolo-composer-option-desc">
                        {t(
                          'settings.continuation.quickAskContextBeforeCharsDesc',
                          '传递给模型的光标上方最大字符数。',
                        )}
                      </div>
                    </div>
                    <div className="yolo-composer-option-control">
                      <ObsidianTextInput
                        type="number"
                        value={quickAskNumberInputs.contextBeforeChars}
                        onChange={(value) => {
                          setQuickAskNumberInputs((prev) => ({
                            ...prev,
                            contextBeforeChars: value,
                          }))
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) return
                          updateContinuationOptions({
                            quickAskContextBeforeChars: Math.max(0, parsed),
                          })
                        }}
                        onBlur={(value) => {
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) {
                            setQuickAskNumberInputs((prev) => ({
                              ...prev,
                              contextBeforeChars: String(
                                quickAskContextBeforeChars,
                              ),
                            }))
                          }
                        }}
                      />
                    </div>
                  </div>
                  <div className="yolo-composer-option">
                    <div className="yolo-composer-option-info">
                      <div className="yolo-composer-option-title">
                        {t(
                          'settings.continuation.quickAskContextAfterChars',
                          '下文字符数',
                        )}
                      </div>
                      <div className="yolo-composer-option-desc">
                        {t(
                          'settings.continuation.quickAskContextAfterCharsDesc',
                          '传递给模型的光标下方最大字符数。',
                        )}
                      </div>
                    </div>
                    <div className="yolo-composer-option-control">
                      <ObsidianTextInput
                        type="number"
                        value={quickAskNumberInputs.contextAfterChars}
                        onChange={(value) => {
                          setQuickAskNumberInputs((prev) => ({
                            ...prev,
                            contextAfterChars: value,
                          }))
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) return
                          updateContinuationOptions({
                            quickAskContextAfterChars: Math.max(0, parsed),
                          })
                        }}
                        onBlur={(value) => {
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) {
                            setQuickAskNumberInputs((prev) => ({
                              ...prev,
                              contextAfterChars: String(
                                quickAskContextAfterChars,
                              ),
                            }))
                          }
                        }}
                      />
                    </div>
                  </div>
                </>
              )}
            </section>

            {enableQuickAsk && (
              <section className="yolo-composer-section">
                <header className="yolo-composer-heading">
                  <div className="yolo-composer-heading-title">
                    {t(
                      'settings.continuationQuickActions.quickActionsTitle',
                      '续写预设',
                    )}
                  </div>
                  <div className="yolo-composer-heading-desc">
                    {t(
                      'settings.continuationQuickActions.quickActionsDesc',
                      '自定义续写模式下显示的快捷选项和提示词。',
                    )}
                  </div>
                </header>
                <ContinuationQuickActionsSettings variant="composer" />
              </section>
            )}

            <section className="yolo-composer-section">
              <header className="yolo-composer-heading">
                <div className="yolo-composer-heading-title">
                  {t(
                    'settings.continuation.selectionChatSubsectionTitle',
                    'Cursor Chat',
                  )}
                </div>
                <div className="yolo-composer-heading-desc">
                  {t(
                    'settings.continuation.selectionChatDescription',
                    '选中文本后显示快捷操作面板，并保持同步到侧边 Chat。',
                  )}
                </div>
              </header>
              <div className="yolo-composer-option">
                <div className="yolo-composer-option-info">
                  <div className="yolo-composer-option-title">
                    {t(
                      'settings.continuation.selectionChatToggle',
                      'Selection Chat',
                    )}
                  </div>
                  <div className="yolo-composer-option-desc">
                    {t(
                      'settings.continuation.selectionChatToggleDesc',
                      '选中文本后显示快捷操作面板。',
                    )}
                  </div>
                </div>
                <div className="yolo-composer-option-control">
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
              {enableSelectionChat && (
                <div className="yolo-composer-option">
                  <div className="yolo-composer-option-info">
                    <div className="yolo-composer-option-title">
                      {t(
                        'settings.continuation.selectionChatAutoDock',
                        '自动停靠到右上角',
                      )}
                    </div>
                    <div className="yolo-composer-option-desc">
                      {t(
                        'settings.continuation.selectionChatAutoDockDesc',
                        '发送问题后自动移动到编辑器右上角（拖动后不再自动跟随）。',
                      )}
                    </div>
                  </div>
                  <div className="yolo-composer-option-control">
                    <ObsidianToggle
                      value={
                        settings.continuationOptions
                          .quickAskAutoDockToTopRight ?? true
                      }
                      onChange={(value) =>
                        updateContinuationOptions({
                          quickAskAutoDockToTopRight: value,
                        })
                      }
                    />
                  </div>
                </div>
              )}
              {enableSelectionChat && (
                <SelectionChatActionsSettings variant="composer" />
              )}
            </section>
          </>
        )}

        {activeTab === 'tab-completion' && (
          <>
            <section className="yolo-composer-section">
              <header className="yolo-composer-heading">
                <div className="yolo-composer-heading-title">
                  {t(
                    'settings.continuation.tabCompletionBasicTitle',
                    '基础设置',
                  )}
                </div>
                <div className="yolo-composer-heading-desc">
                  {t(
                    'settings.continuation.tabCompletionBasicDesc',
                    '启用 Tab 补全并设置基础参数。',
                  )}
                </div>
              </header>

              <div className="yolo-composer-option">
                <div className="yolo-composer-option-info">
                  <div className="yolo-composer-option-title">
                    {t('settings.continuation.tabCompletion', '启用 Tab 补全')}
                  </div>
                  <div className="yolo-composer-option-desc">
                    {t(
                      'settings.continuation.tabCompletionDesc',
                      '开启后会在编辑器中自动触发补全建议。',
                    )}
                  </div>
                </div>
                <div className="yolo-composer-option-control">
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
                  <div className="yolo-composer-option">
                    <div className="yolo-composer-option-info">
                      <div className="yolo-composer-option-title">
                        {t(
                          'settings.continuation.tabCompletionModel',
                          '补全模型',
                        )}
                      </div>
                      <div className="yolo-composer-option-desc">
                        {t(
                          'settings.continuation.tabCompletionModelDesc',
                          '选择用于 Tab 补全的模型。',
                        )}
                      </div>
                    </div>
                    <div className="yolo-composer-option-control yolo-composer-option-control--fluid">
                      <div className="yolo-simple-select-wrapper">
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

                  <ReasoningPanel
                    model={tabCompletionChatModel}
                    value={tabCompletionOptions.reasoningLevel}
                    onChange={(level) => {
                      updateTabCompletionOptions({ reasoningLevel: level })
                    }}
                  />

                  <div className="yolo-composer-option">
                    <div className="yolo-composer-option-info">
                      <div className="yolo-composer-option-title">
                        {t(
                          'settings.continuation.tabCompletionLengthPreset',
                          '补全长度',
                        )}
                      </div>
                      <div className="yolo-composer-option-desc">
                        {t(
                          'settings.continuation.tabCompletionLengthPresetDesc',
                          '提示模型生成短、中、长三档补全。',
                        )}
                      </div>
                    </div>
                    <div className="yolo-composer-option-control">
                      <div
                        className="yolo-segmented yolo-segmented--glider"
                        style={
                          {
                            '--yolo-segment-count': 3,
                            '--yolo-segment-index':
                              tabCompletionLengthPresetIndex,
                          } as React.CSSProperties
                        }
                      >
                        <div
                          className="yolo-segmented-glider"
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

                  <div className="yolo-composer-option">
                    <div className="yolo-composer-option-info">
                      <div className="yolo-composer-option-title">
                        {t(
                          'settings.continuation.tabCompletionRequestTimeout',
                          '请求超时（秒）',
                        )}
                      </div>
                    </div>
                    <div className="yolo-composer-option-control">
                      <ObsidianTextInput
                        type="number"
                        value={tabNumberInputs.requestTimeoutSeconds}
                        onChange={(value) => {
                          setTabNumberInputs((prev) => ({
                            ...prev,
                            requestTimeoutSeconds: value,
                          }))
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) return
                          const seconds = Math.min(120, Math.max(1, parsed))
                          updateTabCompletionOptions({
                            requestTimeoutMs: seconds * 1000,
                          })
                        }}
                        onBlur={(value) => {
                          const parsed = parseIntegerInput(value)
                          if (parsed === null) {
                            setTabNumberInputs((prev) => ({
                              ...prev,
                              requestTimeoutSeconds: String(
                                Math.max(
                                  1,
                                  Math.round(
                                    tabCompletionOptions.requestTimeoutMs /
                                      1000,
                                  ) || 12,
                                ),
                              ),
                            }))
                          }
                        }}
                      />
                    </div>
                  </div>

                  <div className="yolo-composer-option">
                    <div className="yolo-composer-option-info">
                      <div className="yolo-composer-option-title">
                        {t(
                          'settings.continuation.tabCompletionConstraints',
                          '补全约束',
                        )}
                      </div>
                      <div className="yolo-composer-option-desc">
                        {t(
                          'settings.continuation.tabCompletionConstraintsDesc',
                          '插入到补全提示词中的附加规则。',
                        )}
                      </div>
                    </div>
                    <div className="yolo-composer-option-control yolo-composer-option-control--full">
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
            </section>

            {enableTabCompletion && (
              <section className="yolo-composer-section">
                <header className="yolo-composer-heading">
                  <div className="yolo-composer-heading-title">
                    {t(
                      'settings.continuation.tabCompletionTriggersSectionTitle',
                      '触发器设置',
                    )}
                  </div>
                  <div className="yolo-composer-heading-desc">
                    {t(
                      'settings.continuation.tabCompletionTriggersSectionDesc',
                      '配置补全触发条件与规则。',
                    )}
                  </div>
                </header>

                <div className="yolo-composer-option">
                  <div className="yolo-composer-option-info">
                    <div className="yolo-composer-option-title">
                      {t(
                        'settings.continuation.tabCompletionTriggerDelay',
                        '触发延迟',
                      )}
                    </div>
                    <div className="yolo-composer-option-desc">
                      {t(
                        'settings.continuation.tabCompletionTriggerDelayDesc',
                        '输入后延迟触发的毫秒数。',
                      )}
                    </div>
                  </div>
                  <div className="yolo-composer-option-control">
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

                <div className="yolo-composer-option yolo-composer-option--table">
                  <div className="yolo-composer-option-info">
                    <div className="yolo-composer-option-title">
                      {t(
                        'settings.continuation.tabCompletionTriggersTitle',
                        '触发器',
                      )}
                    </div>
                    <div className="yolo-composer-option-desc">
                      {t(
                        'settings.continuation.tabCompletionTriggersDesc',
                        '配置补全触发规则。',
                      )}
                    </div>
                  </div>
                  <div className="yolo-composer-option-control yolo-composer-option-control--full">
                    <div className="yolo-settings-table-container">
                      <table className="yolo-settings-table">
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
                                'settings.continuation.tabCompletionTriggerAcceptMode',
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
                                <ObsidianDropdown
                                  value={trigger.acceptMode ?? 'insert'}
                                  options={{
                                    insert: t(
                                      'settings.continuation.tabCompletionTriggerAcceptModeInsert',
                                    ),
                                    replace: t(
                                      'settings.continuation.tabCompletionTriggerAcceptModeReplace',
                                    ),
                                  }}
                                  onChange={(value) => {
                                    handleTriggerChange(trigger.id, {
                                      acceptMode: value as 'insert' | 'replace',
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
                            <td colSpan={6}>
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
              </section>
            )}

            {enableTabCompletion && (
              <section className="yolo-composer-section">
                <header className="yolo-composer-heading">
                  <div className="yolo-composer-heading-title">
                    {t(
                      'settings.continuation.tabCompletionAutoSectionTitle',
                      '自动补全设置',
                    )}
                  </div>
                  <div className="yolo-composer-heading-desc">
                    {t(
                      'settings.continuation.tabCompletionAutoSectionDesc',
                      '配置停顿后的自动补全行为。',
                    )}
                  </div>
                </header>

                <div className="yolo-composer-option">
                  <div className="yolo-composer-option-info">
                    <div className="yolo-composer-option-title">
                      {t(
                        'settings.continuation.tabCompletionAutoTrigger',
                        '自动补全（停顿后）',
                      )}
                    </div>
                    <div className="yolo-composer-option-desc">
                      {t(
                        'settings.continuation.tabCompletionAutoTriggerDesc',
                        '启用后，停止输入一段时间也会触发补全。',
                      )}
                    </div>
                  </div>
                  <div className="yolo-composer-option-control">
                    <ObsidianToggle
                      value={tabCompletionOptions.idleTriggerEnabled}
                      onChange={(value) => {
                        updateTabCompletionOptions({
                          idleTriggerEnabled: value,
                        })
                      }}
                    />
                  </div>
                </div>

                {tabCompletionOptions.idleTriggerEnabled && (
                  <>
                    <div className="yolo-composer-option">
                      <div className="yolo-composer-option-info">
                        <div className="yolo-composer-option-title">
                          {t(
                            'settings.continuation.tabCompletionAutoTriggerDelay',
                            '自动补全停顿时间（毫秒）',
                          )}
                        </div>
                        <div className="yolo-composer-option-desc">
                          {t(
                            'settings.continuation.tabCompletionAutoTriggerDelayDesc',
                            '停止输入后等待多久再触发自动补全。',
                          )}
                        </div>
                      </div>
                      <div className="yolo-composer-option-control">
                        <ObsidianTextInput
                          type="number"
                          value={tabNumberInputs.autoTriggerDelayMs}
                          onChange={(value) => {
                            setTabNumberInputs((prev) => ({
                              ...prev,
                              autoTriggerDelayMs: value,
                            }))
                            const parsed = parseIntegerInput(value)
                            if (parsed === null) return
                            const next = Math.max(200, parsed)
                            updateTabCompletionOptions({
                              autoTriggerDelayMs: next,
                            })
                          }}
                          onBlur={(value) => {
                            const parsed = parseIntegerInput(value)
                            if (parsed === null) {
                              setTabNumberInputs((prev) => ({
                                ...prev,
                                autoTriggerDelayMs: String(
                                  tabCompletionOptions.autoTriggerDelayMs,
                                ),
                              }))
                            }
                          }}
                        />
                      </div>
                    </div>

                    <div className="yolo-composer-option">
                      <div className="yolo-composer-option-info">
                        <div className="yolo-composer-option-title">
                          {t(
                            'settings.continuation.tabCompletionAutoTriggerCooldown',
                            '自动补全冷却时间（毫秒）',
                          )}
                        </div>
                        <div className="yolo-composer-option-desc">
                          {t(
                            'settings.continuation.tabCompletionAutoTriggerCooldownDesc',
                            '自动补全触发后冷却一段时间，避免频繁请求。',
                          )}
                        </div>
                      </div>
                      <div className="yolo-composer-option-control">
                        <ObsidianTextInput
                          type="number"
                          value={tabNumberInputs.autoTriggerCooldownMs}
                          onChange={(value) => {
                            setTabNumberInputs((prev) => ({
                              ...prev,
                              autoTriggerCooldownMs: value,
                            }))
                            const parsed = parseIntegerInput(value)
                            if (parsed === null) return
                            const next = Math.max(0, parsed)
                            updateTabCompletionOptions({
                              autoTriggerCooldownMs: next,
                            })
                          }}
                          onBlur={(value) => {
                            const parsed = parseIntegerInput(value)
                            if (parsed === null) {
                              setTabNumberInputs((prev) => ({
                                ...prev,
                                autoTriggerCooldownMs: String(
                                  tabCompletionOptions.autoTriggerCooldownMs,
                                ),
                              }))
                            }
                          }}
                        />
                      </div>
                    </div>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default SparkleSettings
