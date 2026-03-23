import { useCallback, useMemo } from 'react'

import {
  DEFAULT_CHAT_TITLE_PROMPT,
  RECOMMENDED_MODELS_FOR_APPLY,
  RECOMMENDED_MODELS_FOR_CHAT,
} from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'

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

  const applyModelGroupedOptions = useMemo(
    () => buildGroupedChatOptions(RECOMMENDED_MODELS_FOR_APPLY),
    [buildGroupedChatOptions],
  )

  const chatModelGroupedOptions = useMemo(
    () => buildGroupedChatOptions(RECOMMENDED_MODELS_FOR_CHAT),
    [buildGroupedChatOptions],
  )

  const defaultTitlePrompt =
    DEFAULT_CHAT_TITLE_PROMPT[language] ?? DEFAULT_CHAT_TITLE_PROMPT.en

  const chatTitlePromptValue =
    (settings.chatOptions.chatTitlePrompt ?? '').trim().length > 0
      ? settings.chatOptions.chatTitlePrompt!
      : defaultTitlePrompt

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
            name={t('settings.defaults.toolModel')}
            desc={t('settings.defaults.toolModelDesc')}
            className="smtcmp-models-select-card"
          >
            <ObsidianDropdown
              value={settings.applyModelId}
              groupedOptions={applyModelGroupedOptions}
              onChange={(value) => {
                commitSettingsUpdate({ applyModelId: value }, 'applyModelId')
              }}
            />
          </ObsidianSetting>

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
