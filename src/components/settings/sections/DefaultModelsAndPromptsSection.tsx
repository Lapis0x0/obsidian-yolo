import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  DEFAULT_CHAT_TITLE_PROMPT,
  RECOMMENDED_MODELS_FOR_CHAT,
  RECOMMENDED_MODELS_FOR_CHAT_TITLE,
} from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from '../../../settings/schema/setting.types'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

export function DefaultModelsAndPromptsSection() {
  const { settings, setSettings } = useSettings()
  const { t, language } = useLanguage()

  const commitSettingsUpdate = (
    patch: Partial<typeof settings>,
    context: string,
  ) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          ...patch,
        })
      } catch (error: unknown) {
        console.error(
          `Failed to update default models/settings: ${context}`,
          error,
        )
      }
    })()
  }

  const enabledChatModels = useMemo(
    () => settings.chatModels.filter(({ enable }) => enable ?? true),
    [settings.chatModels],
  )

  const orderedProviderIds = useMemo(() => {
    const providerOrder = settings.providers.map((p) => p.id)
    const providerIdsInModels = Array.from(
      new Set(enabledChatModels.map((m) => m.providerId)),
    )
    return [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]
  }, [enabledChatModels, settings.providers])

  const buildGroupedChatOptions = useCallback(
    (recommendedModelIds: string[]) => {
      const recommendedBadge =
        t('settings.defaults.recommendedBadge') ?? '(Recommended)'
      return orderedProviderIds
        .map<ObsidianDropdownOptionGroup | null>((providerId) => {
          const groupModels = enabledChatModels.filter(
            (model) => model.providerId === providerId,
          )
          if (groupModels.length === 0) return null
          return {
            label: providerId,
            options: groupModels.map((chatModel) => {
              const labelBase =
                chatModel.name || chatModel.model || chatModel.id
              const badge = recommendedModelIds.includes(chatModel.id)
                ? ` ${recommendedBadge}`
                : ''
              return {
                value: chatModel.id,
                label: `${labelBase}${badge}`.trim(),
              }
            }),
          }
        })
        .filter((group): group is ObsidianDropdownOptionGroup => group !== null)
    },
    [enabledChatModels, orderedProviderIds, t],
  )

  const chatTitleModelGroupedOptions = useMemo(
    () => buildGroupedChatOptions(RECOMMENDED_MODELS_FOR_CHAT_TITLE),
    [buildGroupedChatOptions],
  )

  const chatModelGroupedOptions = useMemo(
    () => buildGroupedChatOptions(RECOMMENDED_MODELS_FOR_CHAT),
    [buildGroupedChatOptions],
  )

  const defaultTitlePrompt =
    DEFAULT_CHAT_TITLE_PROMPT[language] ?? DEFAULT_CHAT_TITLE_PROMPT.en
  const streamFallbackRecoveryEnabled =
    settings.continuationOptions.streamFallbackRecoveryEnabled ?? true
  const primaryRequestTimeoutMs =
    settings.continuationOptions.primaryRequestTimeoutMs ??
    DEFAULT_MODEL_REQUEST_TIMEOUT_MS
  const [
    primaryRequestTimeoutSecondsInput,
    setPrimaryRequestTimeoutSecondsInput,
  ] = useState(String(Math.round(primaryRequestTimeoutMs / 1000)))

  const chatTitlePromptValue =
    (settings.chatOptions.chatTitlePrompt ?? '').trim().length > 0
      ? settings.chatOptions.chatTitlePrompt!
      : defaultTitlePrompt

  useEffect(() => {
    setPrimaryRequestTimeoutSecondsInput(
      String(Math.round(primaryRequestTimeoutMs / 1000)),
    )
  }, [primaryRequestTimeoutMs])

  const parseIntegerInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^-?\d+$/.test(trimmed)) return null
    return parseInt(trimmed, 10)
  }

  return (
    <div className="smtcmp-settings-section">
      <section className="smtcmp-models-block smtcmp-default-models-block">
        <div className="smtcmp-models-block-head">
          <div className="smtcmp-models-block-head-title-row">
            <div className="smtcmp-settings-sub-header smtcmp-models-block-title">
              {t('settings.defaults.title')}
            </div>
          </div>
        </div>

        <div className="smtcmp-models-block-content">
          <ObsidianSetting
            name={t('settings.defaults.defaultChatModel')}
            desc={t('settings.defaults.defaultChatModelDesc')}
            className="smtcmp-models-select-card"
          >
            <ObsidianDropdown
              value={settings.chatModelId}
              groupedOptions={chatModelGroupedOptions}
              onChange={(value) => {
                commitSettingsUpdate({ chatModelId: value }, 'chatModelId')
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.defaults.chatTitleModel')}
            desc={t('settings.defaults.chatTitleModelDesc')}
            className="smtcmp-models-select-card"
          >
            <ObsidianDropdown
              value={settings.chatTitleModelId}
              groupedOptions={chatTitleModelGroupedOptions}
              onChange={(value) => {
                commitSettingsUpdate(
                  { chatTitleModelId: value },
                  'chatTitleModelId',
                )
              }}
            />
          </ObsidianSetting>

          <div className="smtcmp-models-textarea-card">
            <ObsidianSetting
              name={t('settings.defaults.requestRecoverySectionTitle')}
              desc={t('settings.defaults.requestRecoverySectionDesc')}
              className="smtcmp-settings-textarea-header smtcmp-models-textarea-card-header"
            />

            <div className="smtcmp-models-textarea-card-body">
              <ObsidianSetting
                name={t('settings.defaults.streamFallbackRecovery')}
                desc={t('settings.defaults.streamFallbackRecoveryDesc')}
              >
                <ObsidianToggle
                  value={streamFallbackRecoveryEnabled}
                  onChange={(value) => {
                    commitSettingsUpdate(
                      {
                        continuationOptions: {
                          ...settings.continuationOptions,
                          streamFallbackRecoveryEnabled: value,
                        },
                      },
                      'streamFallbackRecoveryEnabled',
                    )
                  }}
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.defaults.primaryRequestTimeout')}
                desc={t('settings.defaults.primaryRequestTimeoutDesc')}
              >
                <ObsidianTextInput
                  type="number"
                  value={primaryRequestTimeoutSecondsInput}
                  onChange={(value) => {
                    setPrimaryRequestTimeoutSecondsInput(value)
                    const nextSeconds = parseIntegerInput(value)
                    if (nextSeconds === null) return
                    const clampedSeconds = Math.min(
                      600,
                      Math.max(1, nextSeconds),
                    )
                    commitSettingsUpdate(
                      {
                        continuationOptions: {
                          ...settings.continuationOptions,
                          primaryRequestTimeoutMs: clampedSeconds * 1000,
                        },
                      },
                      'primaryRequestTimeoutMs',
                    )
                  }}
                  onBlur={() => {
                    const parsedSeconds = parseIntegerInput(
                      primaryRequestTimeoutSecondsInput,
                    )
                    const nextSeconds =
                      parsedSeconds === null
                        ? Math.round(primaryRequestTimeoutMs / 1000)
                        : Math.min(600, Math.max(1, parsedSeconds))
                    setPrimaryRequestTimeoutSecondsInput(String(nextSeconds))
                    if (nextSeconds * 1000 !== primaryRequestTimeoutMs) {
                      commitSettingsUpdate(
                        {
                          continuationOptions: {
                            ...settings.continuationOptions,
                            primaryRequestTimeoutMs: nextSeconds * 1000,
                          },
                        },
                        'primaryRequestTimeoutMs',
                      )
                    }
                  }}
                />
              </ObsidianSetting>
            </div>
          </div>

          <div className="smtcmp-models-textarea-card">
            <ObsidianSetting
              name={t('settings.defaults.globalSystemPrompt')}
              desc={t('settings.defaults.globalSystemPromptDesc')}
              className="smtcmp-settings-textarea-header smtcmp-models-textarea-card-header smtcmp-settings-desc-copyable"
            />

            <ObsidianSetting className="smtcmp-settings-textarea smtcmp-models-textarea-card-body">
              <ObsidianTextArea
                value={settings.systemPrompt}
                onChange={(value: string) => {
                  commitSettingsUpdate({ systemPrompt: value }, 'systemPrompt')
                }}
              />
            </ObsidianSetting>
          </div>

          <div className="smtcmp-models-textarea-card">
            <ObsidianSetting
              name={t('settings.defaults.chatTitlePrompt')}
              desc={t('settings.defaults.chatTitlePromptDesc')}
              className="smtcmp-settings-textarea-header smtcmp-models-textarea-card-header"
            />

            <ObsidianSetting className="smtcmp-settings-textarea smtcmp-models-textarea-card-body">
              <ObsidianTextArea
                value={chatTitlePromptValue}
                onChange={(value: string) => {
                  commitSettingsUpdate(
                    {
                      chatOptions: {
                        ...settings.chatOptions,
                        chatTitlePrompt: value,
                      },
                    },
                    'chatTitlePrompt',
                  )
                }}
              />
            </ObsidianSetting>
          </div>
        </div>
      </section>
    </div>
  )
}
