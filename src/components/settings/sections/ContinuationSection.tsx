import { App } from 'obsidian'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_TRIGGERS,
  type TabCompletionTrigger,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { SmartSpaceQuickActionsSettings } from '../SmartSpaceQuickActionsSettings'

type ContinuationSectionProps = {
  app: App
}

export function ContinuationSection({ app: _app }: ContinuationSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [showAdvancedTabSettings, setShowAdvancedTabSettings] = useState(false)

  const updateContinuationOptions = (
    patch: Partial<typeof settings.continuationOptions>,
    context: string,
  ) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          continuationOptions: {
            ...settings.continuationOptions,
            ...patch,
          },
        })
      } catch (error: unknown) {
        console.error(
          `Failed to update continuation options: ${context}`,
          error,
        )
      }
    })()
  }

  const enabledChatModels = useMemo(
    () => settings.chatModels.filter(({ enable }) => enable ?? true),
    [settings.chatModels],
  )

  const enableSmartSpace = settings.continuationOptions.enableSmartSpace ?? true
  const smartSpaceTriggerMode =
    settings.continuationOptions.smartSpaceTriggerMode ?? 'single-space'
  const enableTabCompletion = Boolean(
    settings.continuationOptions.enableTabCompletion,
  )
  const tabCompletionOptions = enableTabCompletion
    ? {
        ...DEFAULT_TAB_COMPLETION_OPTIONS,
        ...(settings.continuationOptions.tabCompletionOptions ?? {}),
      }
    : {
        ...DEFAULT_TAB_COMPLETION_OPTIONS,
        ...(settings.continuationOptions.tabCompletionOptions ?? {}),
      }
  const updateTabCompletionOptions = (
    updates: Partial<typeof tabCompletionOptions>,
  ) => {
    updateContinuationOptions(
      {
        tabCompletionOptions: {
          ...tabCompletionOptions,
          ...updates,
        },
      },
      'tabCompletionOptions',
    )
  }

  const tabCompletionTriggers: TabCompletionTrigger[] =
    settings.continuationOptions.tabCompletionTriggers ??
    DEFAULT_TAB_COMPLETION_TRIGGERS

  const updateTabCompletionTriggers = (
    nextTriggers: TabCompletionTrigger[],
  ) => {
    updateContinuationOptions(
      {
        tabCompletionTriggers: nextTriggers,
      },
      'tabCompletionTriggers',
    )
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

  const parseNumberOrDefault = (value: string, fallback: number) => {
    if (value.trim().length === 0) return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  const parseIntegerOption = (value: string, fallback: number) => {
    const parsed = parseNumberOrDefault(value, fallback)
    return Math.round(parsed)
  }

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-header">
        {t('settings.continuation.title')}
      </div>
      <div className="smtcmp-settings-sub-header">
        {t('settings.continuation.customSubsectionTitle')}
      </div>
      <div className="smtcmp-settings-desc smtcmp-settings-callout">
        {t('settings.continuation.smartSpaceDescription')}
      </div>
      <ObsidianSetting
        name={t('settings.continuation.smartSpaceToggle')}
        desc={t('settings.continuation.smartSpaceToggleDesc')}
      >
        <ObsidianToggle
          value={enableSmartSpace}
          onChange={(value) => {
            updateContinuationOptions(
              {
                enableSmartSpace: value,
              },
              'enableSmartSpace',
            )
          }}
        />
      </ObsidianSetting>

      {enableSmartSpace && (
        <>
          <ObsidianSetting
            name={t('settings.continuation.smartSpaceTriggerMode')}
            desc={t('settings.continuation.smartSpaceTriggerModeDesc')}
            className="smtcmp-smart-space-trigger-setting"
          >
            <ObsidianDropdown
              value={smartSpaceTriggerMode}
              options={{
                'single-space': t(
                  'settings.continuation.smartSpaceTriggerModeSingle',
                ),
                'double-space': t(
                  'settings.continuation.smartSpaceTriggerModeDouble',
                ),
                off: t('settings.continuation.smartSpaceTriggerModeOff'),
              }}
              onChange={(value) => {
                updateContinuationOptions(
                  {
                    smartSpaceTriggerMode: value as
                      | 'single-space'
                      | 'double-space'
                      | 'off',
                  },
                  'smartSpaceTriggerMode',
                )
              }}
            />
          </ObsidianSetting>

          <SmartSpaceQuickActionsSettings />
        </>
      )}

      <ObsidianSetting
        name={t('settings.continuation.selectionChatToggle')}
        desc={t('settings.continuation.selectionChatToggleDesc')}
      >
        <ObsidianToggle
          value={settings.continuationOptions.enableSelectionChat ?? true}
          onChange={(value) => {
            updateContinuationOptions(
              {
                enableSelectionChat: value,
              },
              'enableSelectionChat',
            )
          }}
        />
      </ObsidianSetting>

      <div className="smtcmp-settings-sub-header">
        {t('settings.continuation.quickAskSubsectionTitle')}
      </div>
      <div className="smtcmp-settings-desc smtcmp-settings-callout">
        {t('settings.continuation.quickAskDescription')}
      </div>
      <ObsidianSetting
        name={t('settings.continuation.quickAskToggle')}
        desc={t('settings.continuation.quickAskToggleDesc')}
      >
        <ObsidianToggle
          value={settings.continuationOptions.enableQuickAsk ?? true}
          onChange={(value) => {
            updateContinuationOptions(
              {
                enableQuickAsk: value,
              },
              'enableQuickAsk',
            )
          }}
        />
      </ObsidianSetting>

      {(settings.continuationOptions.enableQuickAsk ?? true) && (
        <ObsidianSetting
          name={t('settings.continuation.quickAskTrigger')}
          desc={t('settings.continuation.quickAskTriggerDesc')}
        >
          <ObsidianTextInput
            value={settings.continuationOptions.quickAskTrigger ?? '@'}
            onChange={(value) => {
              // Only allow single character or short string
              const trimmed = value.trim()
              if (trimmed.length > 0 && trimmed.length <= 3) {
                updateContinuationOptions(
                  {
                    quickAskTrigger: trimmed,
                  },
                  'quickAskTrigger',
                )
              }
            }}
          />
        </ObsidianSetting>
      )}

      <div className="smtcmp-settings-sub-header">
        {t('settings.continuation.tabSubsectionTitle')}
      </div>
      <ObsidianSetting
        name={t('settings.continuation.tabCompletion')}
        desc={t('settings.continuation.tabCompletionDesc')}
      >
        <ObsidianToggle
          value={enableTabCompletion}
          onChange={(value) => {
            updateContinuationOptions(
              {
                enableTabCompletion: value,
                tabCompletionOptions: value
                  ? {
                      ...DEFAULT_TAB_COMPLETION_OPTIONS,
                      ...(settings.continuationOptions.tabCompletionOptions ??
                        {}),
                    }
                  : settings.continuationOptions.tabCompletionOptions,
              },
              'enableTabCompletion',
            )
          }}
        />
      </ObsidianSetting>

      {enableTabCompletion && (
        <>
          {/* Core settings */}
          <ObsidianSetting
            name={t('settings.continuation.tabCompletionModel')}
            desc={t('settings.continuation.tabCompletionModelDesc')}
          >
            <ObsidianDropdown
              value={
                settings.continuationOptions.tabCompletionModelId ??
                settings.continuationOptions.continuationModelId ??
                enabledChatModels[0]?.id ??
                ''
              }
              options={Object.fromEntries(
                enabledChatModels.map((chatModel) => {
                  const label = chatModel.name?.trim()
                    ? chatModel.name.trim()
                    : chatModel.model || chatModel.id
                  return [chatModel.id, label]
                }),
              )}
              onChange={(value) => {
                updateContinuationOptions(
                  {
                    tabCompletionModelId: value,
                  },
                  'tabCompletionModelId',
                )
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.continuation.tabCompletionMaxSuggestionLength')}
            desc={t(
              'settings.continuation.tabCompletionMaxSuggestionLengthDesc',
            )}
          >
            <ObsidianTextInput
              type="number"
              value={String(tabCompletionOptions.maxSuggestionLength)}
              onChange={(value) => {
                const next = Math.max(
                  20,
                  parseIntegerOption(
                    value,
                    DEFAULT_TAB_COMPLETION_OPTIONS.maxSuggestionLength,
                  ),
                )
                updateTabCompletionOptions({
                  maxSuggestionLength: next,
                })
              }}
            />
          </ObsidianSetting>

          <div className="smtcmp-settings-sub-header">
            {t('settings.continuation.tabCompletionTriggersTitle')}
          </div>
          <div className="smtcmp-settings-trigger-callout-row">
            <div className="smtcmp-settings-desc smtcmp-settings-callout">
              {t('settings.continuation.tabCompletionTriggersDesc')}
            </div>
            <div className="smtcmp-tab-trigger-add">
              <ObsidianButton
                text={t('settings.continuation.tabCompletionTriggerAdd')}
                onClick={handleAddTrigger}
              />
            </div>
          </div>
          <div className="smtcmp-settings-table-container">
            <table className="smtcmp-settings-table">
              <thead>
                <tr>
                  <th>{t('settings.continuation.tabCompletionTriggerEnabled')}</th>
                  <th>{t('settings.continuation.tabCompletionTriggerType')}</th>
                  <th>{t('settings.continuation.tabCompletionTriggerPattern')}</th>
                  <th>{t('settings.continuation.tabCompletionTriggerDescription')}</th>
                  <th>{t('settings.continuation.tabCompletionTriggerRemove')}</th>
                </tr>
              </thead>
              <tbody>
                {tabCompletionTriggers.map((trigger) => (
                  <tr key={trigger.id}>
                    <td>
                      <ObsidianToggle
                        value={trigger.enabled}
                        onChange={(value) => {
                          handleTriggerChange(trigger.id, { enabled: value })
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
                          handleTriggerChange(trigger.id, { pattern: value })
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
                        onClick={() => handleRemoveTrigger(trigger.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Advanced settings toggle */}
          <div
            className="smtcmp-settings-advanced-toggle"
            onClick={() => setShowAdvancedTabSettings(!showAdvancedTabSettings)}
            style={{
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '8px 0',
              color: 'var(--text-muted)',
              fontSize: '0.9em',
            }}
          >
            <span
              style={{
                transform: showAdvancedTabSettings
                  ? 'rotate(90deg)'
                  : 'rotate(0deg)',
                transition: 'transform 0.2s',
              }}
            >
              ▶
            </span>
            {t('settings.continuation.tabCompletionAdvanced')}
          </div>

          {/* Advanced settings */}
          {showAdvancedTabSettings && (
            <>
              <ObsidianSetting
                name={t('settings.continuation.tabCompletionContextRange')}
                desc={t('settings.continuation.tabCompletionContextRangeDesc')}
              >
                <ObsidianTextInput
                  type="number"
                  value={String(tabCompletionOptions.contextRange)}
                  onChange={(value) => {
                    const next = Math.max(
                      500,
                      parseIntegerOption(
                        value,
                        DEFAULT_TAB_COMPLETION_OPTIONS.contextRange,
                      ),
                    )
                    updateTabCompletionOptions({
                      contextRange: next,
                    })
                  }}
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.continuation.tabCompletionMinContextLength')}
                desc={t(
                  'settings.continuation.tabCompletionMinContextLengthDesc',
                )}
              >
                <ObsidianTextInput
                  type="number"
                  value={String(tabCompletionOptions.minContextLength)}
                  onChange={(value) => {
                    const next = Math.max(
                      0,
                      parseIntegerOption(
                        value,
                        DEFAULT_TAB_COMPLETION_OPTIONS.minContextLength,
                      ),
                    )
                    updateTabCompletionOptions({
                      minContextLength: next,
                    })
                  }}
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.continuation.tabCompletionTemperature')}
                desc={t('settings.continuation.tabCompletionTemperatureDesc')}
              >
                <ObsidianTextInput
                  type="number"
                  value={String(tabCompletionOptions.temperature)}
                  onChange={(value) => {
                    const next = parseNumberOrDefault(
                      value,
                      DEFAULT_TAB_COMPLETION_OPTIONS.temperature,
                    )
                    updateTabCompletionOptions({
                      temperature: Math.min(Math.max(next, 0), 2),
                    })
                  }}
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.continuation.tabCompletionRequestTimeout')}
                desc={t(
                  'settings.continuation.tabCompletionRequestTimeoutDesc',
                )}
              >
                <ObsidianTextInput
                  type="number"
                  value={String(tabCompletionOptions.requestTimeoutMs)}
                  onChange={(value) => {
                    const next = Math.max(
                      1000,
                      parseIntegerOption(
                        value,
                        DEFAULT_TAB_COMPLETION_OPTIONS.requestTimeoutMs,
                      ),
                    )
                    updateTabCompletionOptions({
                      requestTimeoutMs: next,
                    })
                  }}
                />
              </ObsidianSetting>
            </>
          )}
        </>
      )}
    </div>
  )
}
