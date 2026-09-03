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
import { ContinuationQuickActionsSettings } from '../ContinuationQuickActionsSettings'
import { SelectionChatActionsSettings } from '../SelectionChatActionsSettings'

import { SnippetsSection } from './SnippetsSection'

type ContinuationSectionProps = {
  app: App
}

export function ContinuationSection({ app }: ContinuationSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

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

  const enableSelectionChat =
    settings.continuationOptions.enableSelectionChat ?? true
  const enableTabCompletion = Boolean(
    settings.continuationOptions.enableTabCompletion,
  )
  const quickAskContextBeforeChars =
    settings.continuationOptions.quickAskContextBeforeChars ?? 5000
  const quickAskContextAfterChars =
    settings.continuationOptions.quickAskContextAfterChars ?? 2000
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
  const [quickAskNumberInputs, setQuickAskNumberInputs] = useState({
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
      acceptMode: 'insert',
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

  return (
    <>
      <SnippetsSection app={app} />

      <div className="yolo-settings-section yolo-settings-section--tight">
        <section className="yolo-settings-block">
          <div className="yolo-settings-block-head">
            <div className="yolo-settings-block-head-title-row">
              <div className="yolo-settings-sub-header yolo-settings-block-title">
                {t('settings.continuation.quickAskSubsectionTitle')}
              </div>
              <div className="yolo-settings-desc yolo-settings-block-desc">
                {t('settings.continuation.quickAskDescription')}
              </div>
            </div>
          </div>

          <div className="yolo-settings-block-content">
            <ObsidianSetting
              name={t('settings.continuation.quickAskToggle')}
              desc={t('settings.continuation.quickAskToggleDesc')}
              className="yolo-settings-card"
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
              <>
                <ObsidianSetting
                  name={t(
                    'settings.continuation.selectionChatAutoDock',
                    '自动停靠到右上角',
                  )}
                  desc={t(
                    'settings.continuation.selectionChatAutoDockDesc',
                    '发送问题后自动移动到编辑器右上角（拖动后不再自动跟随）。',
                  )}
                  className="yolo-settings-card"
                >
                  <ObsidianToggle
                    value={
                      settings.continuationOptions.quickAskAutoDockToTopRight ??
                      true
                    }
                    onChange={(value) => {
                      updateContinuationOptions(
                        {
                          quickAskAutoDockToTopRight: value,
                        },
                        'quickAskAutoDockToTopRight',
                      )
                    }}
                  />
                </ObsidianSetting>

                <ObsidianSetting
                  name={t('settings.continuation.quickAskTrigger')}
                  desc={t('settings.continuation.quickAskTriggerDesc')}
                  className="yolo-settings-card"
                >
                  <ObsidianTextInput
                    value={settings.continuationOptions.quickAskTrigger ?? '@'}
                    onChange={(value) => {
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
                <ObsidianSetting
                  name={t('settings.continuation.quickAskContextBeforeChars')}
                  desc={t(
                    'settings.continuation.quickAskContextBeforeCharsDesc',
                  )}
                  className="yolo-settings-card"
                >
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
                      const next = Math.max(0, parsed)
                      updateContinuationOptions(
                        {
                          quickAskContextBeforeChars: next,
                        },
                        'quickAskContextBeforeChars',
                      )
                    }}
                    onBlur={() => {
                      const parsed = parseIntegerInput(
                        quickAskNumberInputs.contextBeforeChars,
                      )
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
                </ObsidianSetting>
                <ObsidianSetting
                  name={t('settings.continuation.quickAskContextAfterChars')}
                  desc={t(
                    'settings.continuation.quickAskContextAfterCharsDesc',
                  )}
                  className="yolo-settings-card"
                >
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
                      const next = Math.max(0, parsed)
                      updateContinuationOptions(
                        {
                          quickAskContextAfterChars: next,
                        },
                        'quickAskContextAfterChars',
                      )
                    }}
                    onBlur={() => {
                      const parsed = parseIntegerInput(
                        quickAskNumberInputs.contextAfterChars,
                      )
                      if (parsed === null) {
                        setQuickAskNumberInputs((prev) => ({
                          ...prev,
                          contextAfterChars: String(quickAskContextAfterChars),
                        }))
                      }
                    }}
                  />
                </ObsidianSetting>

                <ContinuationQuickActionsSettings />
              </>
            )}

            <div className="yolo-settings-sub-header">
              {t('settings.continuation.selectionChatSubsectionTitle')}
            </div>
            <div className="yolo-settings-desc yolo-settings-callout">
              {t('settings.continuation.selectionChatDescription')}
            </div>

            <ObsidianSetting
              name={t('settings.continuation.selectionChatToggle')}
              desc={t('settings.continuation.selectionChatToggleDesc')}
              className="yolo-settings-card"
            >
              <ObsidianToggle
                value={enableSelectionChat}
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

            {enableSelectionChat && (
              <>
                <SelectionChatActionsSettings />
              </>
            )}
          </div>
        </section>
      </div>

      <div className="yolo-settings-section yolo-settings-section--tight">
        <section className="yolo-settings-block">
          <div className="yolo-settings-block-head">
            <div className="yolo-settings-block-head-title-row">
              <div className="yolo-settings-sub-header yolo-settings-block-title">
                {t('settings.continuation.tabSubsectionTitle')}
              </div>
              <div className="yolo-settings-desc yolo-settings-block-desc">
                {t('settings.continuation.tabCompletionBasicDesc')}
              </div>
            </div>
          </div>

          <div className="yolo-settings-block-content">
            <ObsidianSetting
              name={t('settings.continuation.tabCompletion')}
              desc={t('settings.continuation.tabCompletionDesc')}
              className="yolo-settings-card"
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
                            ...(settings.continuationOptions
                              .tabCompletionOptions ?? {}),
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
                <ObsidianSetting
                  name={t('settings.continuation.tabCompletionModel')}
                  desc={t('settings.continuation.tabCompletionModelDesc')}
                  className="yolo-settings-card"
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
                  name={t('settings.continuation.tabCompletionRequestTimeout')}
                  className="yolo-settings-card"
                >
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
                    onBlur={() => {
                      const parsed = parseIntegerInput(
                        tabNumberInputs.requestTimeoutSeconds,
                      )
                      if (parsed === null) {
                        setTabNumberInputs((prev) => ({
                          ...prev,
                          requestTimeoutSeconds: String(
                            Math.max(
                              1,
                              Math.round(
                                tabCompletionOptions.requestTimeoutMs / 1000,
                              ) || 12,
                            ),
                          ),
                        }))
                      }
                    }}
                  />
                </ObsidianSetting>

                <div className="yolo-models-textarea-card">
                  <ObsidianSetting
                    name={t('settings.continuation.tabCompletionConstraints')}
                    desc={t(
                      'settings.continuation.tabCompletionConstraintsDesc',
                    )}
                    className="yolo-settings-textarea-header yolo-models-textarea-card-header"
                  />
                  <ObsidianSetting className="yolo-settings-textarea yolo-models-textarea-card-body">
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
                </div>

                <div className="yolo-settings-sub-header">
                  {t('settings.continuation.tabCompletionTriggersTitle')}
                </div>
                <div className="yolo-settings-trigger-callout-row">
                  <div className="yolo-settings-desc yolo-settings-callout">
                    {t('settings.continuation.tabCompletionTriggersDesc')}
                  </div>
                  <div className="yolo-tab-trigger-add">
                    <ObsidianButton
                      text={t('settings.continuation.tabCompletionTriggerAdd')}
                      onClick={handleAddTrigger}
                    />
                  </div>
                </div>
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
                          {t('settings.continuation.tabCompletionTriggerType')}
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
                  desc={t(
                    'settings.continuation.tabCompletionTriggerDelayDesc',
                  )}
                  className="yolo-settings-card"
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
                      const parsed = parseIntegerInput(
                        tabNumberInputs.triggerDelayMs,
                      )
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
                </ObsidianSetting>
                <ObsidianSetting
                  name={t('settings.continuation.tabCompletionAutoTrigger')}
                  desc={t('settings.continuation.tabCompletionAutoTriggerDesc')}
                  className="yolo-settings-card"
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
                      name={t(
                        'settings.continuation.tabCompletionAutoTriggerDelay',
                      )}
                      desc={t(
                        'settings.continuation.tabCompletionAutoTriggerDelayDesc',
                      )}
                      className="yolo-settings-card"
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
                          updateTabCompletionOptions({
                            autoTriggerDelayMs: next,
                          })
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
                      className="yolo-settings-card"
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
                          updateTabCompletionOptions({
                            autoTriggerCooldownMs: next,
                          })
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
              </>
            )}
          </div>
        </section>
      </div>
    </>
  )
}
