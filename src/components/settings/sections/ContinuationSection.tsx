import { App } from 'obsidian'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { DEFAULT_TAB_COMPLETION_OPTIONS } from '../../../settings/schema/setting.types'
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
            name={t('settings.continuation.tabCompletionTriggerDelay')}
            desc={t('settings.continuation.tabCompletionTriggerDelayDesc')}
          >
            <ObsidianTextInput
              type="number"
              value={String(tabCompletionOptions.triggerDelayMs)}
              onChange={(value) => {
                const next = Math.max(
                  0,
                  parseIntegerOption(
                    value,
                    DEFAULT_TAB_COMPLETION_OPTIONS.triggerDelayMs,
                  ),
                )
                updateTabCompletionOptions({
                  triggerDelayMs: next,
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.continuation.tabCompletionMinContextLength')}
            desc={t('settings.continuation.tabCompletionMinContextLengthDesc')}
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
            name={t('settings.continuation.tabCompletionMaxBeforeChars')}
            desc={t('settings.continuation.tabCompletionMaxBeforeCharsDesc')}
          >
            <ObsidianTextInput
              type="number"
              value={String(tabCompletionOptions.maxBeforeChars)}
              onChange={(value) => {
                const next = Math.max(
                  200,
                  parseIntegerOption(
                    value,
                    DEFAULT_TAB_COMPLETION_OPTIONS.maxBeforeChars,
                  ),
                )
                updateTabCompletionOptions({
                  maxBeforeChars: next,
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.continuation.tabCompletionMaxAfterChars')}
            desc={t('settings.continuation.tabCompletionMaxAfterCharsDesc')}
          >
            <ObsidianTextInput
              type="number"
              value={String(tabCompletionOptions.maxAfterChars)}
              onChange={(value) => {
                const next = Math.max(
                  0,
                  parseIntegerOption(
                    value,
                    DEFAULT_TAB_COMPLETION_OPTIONS.maxAfterChars,
                  ),
                )
                updateTabCompletionOptions({
                  maxAfterChars: next,
                })
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

          <ObsidianSetting
            name={t('settings.continuation.tabCompletionMaxTokens')}
            desc={t('settings.continuation.tabCompletionMaxTokensDesc')}
          >
            <ObsidianTextInput
              type="number"
              value={String(tabCompletionOptions.maxTokens)}
              onChange={(value) => {
                const parsed = Math.max(
                  16,
                  Math.min(
                    2000,
                    parseIntegerOption(
                      value,
                      DEFAULT_TAB_COMPLETION_OPTIONS.maxTokens,
                    ),
                  ),
                )
                updateTabCompletionOptions({
                  maxTokens: parsed,
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
            desc={t('settings.continuation.tabCompletionRequestTimeoutDesc')}
          >
            <ObsidianTextInput
              type="number"
              value={String(tabCompletionOptions.requestTimeoutMs)}
              onChange={(value) => {
                const next = Math.max(
                  0,
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

          <ObsidianSetting
            name={t('settings.continuation.tabCompletionMaxRetries')}
            desc={t('settings.continuation.tabCompletionMaxRetriesDesc')}
          >
            <ObsidianTextInput
              type="number"
              value={String(tabCompletionOptions.maxRetries)}
              onChange={(value) => {
                const parsed = parseIntegerOption(
                  value,
                  DEFAULT_TAB_COMPLETION_OPTIONS.maxRetries,
                )
                const next = Math.max(0, Math.min(5, parsed))
                updateTabCompletionOptions({
                  maxRetries: next,
                })
              }}
            />
          </ObsidianSetting>
        </>
      )}
    </div>
  )
}
