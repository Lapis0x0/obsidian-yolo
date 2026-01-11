import { App } from 'obsidian'
import { useEffect, useMemo, useState } from 'react'

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
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
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
  const tabCompletionConstraints =
    settings.continuationOptions.tabCompletionConstraints ?? ''
  const [tabNumberInputs, setTabNumberInputs] = useState({
    maxSuggestionLength: String(tabCompletionOptions.maxSuggestionLength),
    triggerDelayMs: String(tabCompletionOptions.triggerDelayMs),
    autoTriggerDelayMs: String(tabCompletionOptions.autoTriggerDelayMs),
    autoTriggerCooldownMs: String(tabCompletionOptions.autoTriggerCooldownMs),
    contextRange: String(tabCompletionOptions.contextRange),
    minContextLength: String(tabCompletionOptions.minContextLength),
    temperature: String(tabCompletionOptions.temperature),
    requestTimeoutMs: String(tabCompletionOptions.requestTimeoutMs),
  })

  useEffect(() => {
    setTabNumberInputs({
      maxSuggestionLength: String(tabCompletionOptions.maxSuggestionLength),
      triggerDelayMs: String(tabCompletionOptions.triggerDelayMs),
      autoTriggerDelayMs: String(tabCompletionOptions.autoTriggerDelayMs),
      autoTriggerCooldownMs: String(tabCompletionOptions.autoTriggerCooldownMs),
      contextRange: String(tabCompletionOptions.contextRange),
      minContextLength: String(tabCompletionOptions.minContextLength),
      temperature: String(tabCompletionOptions.temperature),
      requestTimeoutMs: String(tabCompletionOptions.requestTimeoutMs),
    })
  }, [
    tabCompletionOptions.maxSuggestionLength,
    tabCompletionOptions.triggerDelayMs,
    tabCompletionOptions.autoTriggerDelayMs,
    tabCompletionOptions.autoTriggerCooldownMs,
    tabCompletionOptions.contextRange,
    tabCompletionOptions.minContextLength,
    tabCompletionOptions.temperature,
    tabCompletionOptions.requestTimeoutMs,
  ])
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
              value={tabNumberInputs.maxSuggestionLength}
              onChange={(value) => {
                setTabNumberInputs((prev) => ({
                  ...prev,
                  maxSuggestionLength: value,
                }))
                const parsed = parseIntegerInput(value)
                if (parsed === null) return
                const next = Math.max(20, parsed)
                updateTabCompletionOptions({ maxSuggestionLength: next })
              }}
              onBlur={() => {
                const parsed = parseIntegerInput(
                  tabNumberInputs.maxSuggestionLength,
                )
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
                  <th>
                    {t('settings.continuation.tabCompletionTriggerEnabled')}
                  </th>
                  <th>{t('settings.continuation.tabCompletionTriggerType')}</th>
                  <th>
                    {t('settings.continuation.tabCompletionTriggerPattern')}
                  </th>
                  <th>
                    {t('settings.continuation.tabCompletionTriggerDescription')}
                  </th>
                  <th>
                    {t('settings.continuation.tabCompletionTriggerRemove')}
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
          <ObsidianSetting
            name={t('settings.continuation.tabCompletionTriggerDelay')}
            desc={t('settings.continuation.tabCompletionTriggerDelayDesc')}
          >
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
              onBlur={() => {
                const parsed = parseIntegerInput(tabNumberInputs.triggerDelayMs)
                if (parsed === null) {
                  setTabNumberInputs((prev) => ({
                    ...prev,
                    triggerDelayMs: String(tabCompletionOptions.triggerDelayMs),
                  }))
                }
              }}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.continuation.tabCompletionAutoTrigger')}
            desc={t('settings.continuation.tabCompletionAutoTriggerDesc')}
          >
            <ObsidianToggle
              value={tabCompletionOptions.idleTriggerEnabled}
              onChange={(value) => {
                updateTabCompletionOptions({ idleTriggerEnabled: value })
              }}
            />
          </ObsidianSetting>
          {tabCompletionOptions.idleTriggerEnabled && (
            <>
              <ObsidianSetting
                name={t('settings.continuation.tabCompletionAutoTriggerDelay')}
                desc={t(
                  'settings.continuation.tabCompletionAutoTriggerDelayDesc',
                )}
              >
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
                    updateTabCompletionOptions({ autoTriggerDelayMs: next })
                  }}
                  onBlur={() => {
                    const parsed = parseIntegerInput(
                      tabNumberInputs.autoTriggerDelayMs,
                    )
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
              </ObsidianSetting>
              <ObsidianSetting
                name={t(
                  'settings.continuation.tabCompletionAutoTriggerCooldown',
                )}
                desc={t(
                  'settings.continuation.tabCompletionAutoTriggerCooldownDesc',
                )}
              >
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
                    updateTabCompletionOptions({ autoTriggerCooldownMs: next })
                  }}
                  onBlur={() => {
                    const parsed = parseIntegerInput(
                      tabNumberInputs.autoTriggerCooldownMs,
                    )
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
              </ObsidianSetting>
            </>
          )}
          {/* Advanced settings toggle */}
          <div
            className={`smtcmp-settings-advanced-toggle smtcmp-clickable${
              showAdvancedTabSettings ? ' is-expanded' : ''
            }`}
            onClick={() => setShowAdvancedTabSettings((prev) => !prev)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setShowAdvancedTabSettings((prev) => !prev)
              }
            }}
          >
            <span className="smtcmp-settings-advanced-toggle-icon">▶</span>
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
                  onBlur={() => {
                    const parsed = parseIntegerInput(
                      tabNumberInputs.contextRange,
                    )
                    if (parsed === null) {
                      setTabNumberInputs((prev) => ({
                        ...prev,
                        contextRange: String(tabCompletionOptions.contextRange),
                      }))
                    }
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
                  value={tabNumberInputs.minContextLength}
                  onChange={(value) => {
                    setTabNumberInputs((prev) => ({
                      ...prev,
                      minContextLength: value,
                    }))
                    const parsed = parseIntegerInput(value)
                    if (parsed === null) return
                    const next = Math.max(0, parsed)
                    updateTabCompletionOptions({ minContextLength: next })
                  }}
                  onBlur={() => {
                    const parsed = parseIntegerInput(
                      tabNumberInputs.minContextLength,
                    )
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
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.continuation.tabCompletionTemperature')}
                desc={t('settings.continuation.tabCompletionTemperatureDesc')}
              >
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
                  onBlur={() => {
                    const parsed = parseFloatInput(tabNumberInputs.temperature)
                    if (parsed === null) {
                      setTabNumberInputs((prev) => ({
                        ...prev,
                        temperature: String(tabCompletionOptions.temperature),
                      }))
                    }
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
                  value={tabNumberInputs.requestTimeoutMs}
                  onChange={(value) => {
                    setTabNumberInputs((prev) => ({
                      ...prev,
                      requestTimeoutMs: value,
                    }))
                    const parsed = parseIntegerInput(value)
                    if (parsed === null) return
                    const next = Math.max(1000, parsed)
                    updateTabCompletionOptions({ requestTimeoutMs: next })
                  }}
                  onBlur={() => {
                    const parsed = parseIntegerInput(
                      tabNumberInputs.requestTimeoutMs,
                    )
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
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.continuation.tabCompletionConstraints')}
                desc={t('settings.continuation.tabCompletionConstraintsDesc')}
                className="smtcmp-settings-textarea-header"
              />
              <ObsidianSetting className="smtcmp-settings-textarea">
                <ObsidianTextArea
                  value={tabCompletionConstraints}
                  onChange={(value: string) => {
                    updateContinuationOptions(
                      { tabCompletionConstraints: value },
                      'tabCompletionConstraints',
                    )
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
