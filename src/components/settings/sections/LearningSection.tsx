import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  LEARNING_OUTPUT_LANGUAGES,
  type LearningOutputLanguage,
} from '../../../settings/schema/setting.types'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'

const OUTPUT_LANGUAGE_LABELS: Record<string, string> = {
  English: 'English',
  'Simplified Chinese': '\u7b80\u4f53\u4e2d\u6587',
  Spanish: 'Espa\u00f1ol',
  Italian: 'Italiano',
  French: 'Fran\u00e7ais',
  German: 'Deutsch',
  Japanese: '\u65e5\u672c\u8a9e',
  Korean: '\ud55c\uad6d\uc5b4',
  Portuguese: 'Portugu\u00eas',
}

export function LearningSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const modelGroups = useMemo(() => {
    const enabledModels = settings.chatModels.filter(
      (model) => model.enable ?? true,
    )
    const providerOrder = settings.providers.map((provider) => provider.id)
    const modelProviderIds = [
      ...new Set(enabledModels.map((model) => model.providerId)),
    ]
    const orderedProviderIds = [
      ...providerOrder.filter((id) => modelProviderIds.includes(id)),
      ...modelProviderIds.filter((id) => !providerOrder.includes(id)),
    ]

    return orderedProviderIds
      .map<ObsidianDropdownOptionGroup | null>((providerId) => {
        const options = enabledModels
          .filter((model) => model.providerId === providerId)
          .map((model) => ({
            value: model.id,
            label: model.name || model.model || model.id,
          }))
        return options.length ? { label: providerId, options } : null
      })
      .filter((group): group is ObsidianDropdownOptionGroup => group !== null)
  }, [settings.chatModels, settings.providers])

  const updateModel = (modelId: string) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          learningOptions: {
            ...settings.learningOptions,
            modelId,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to update learning generation model:', error)
      }
    })()
  }

  const updateOutputLanguage = (outputLanguage: string) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          learningOptions: {
            ...settings.learningOptions,
            outputLanguage: outputLanguage as LearningOutputLanguage,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to update learning output language:', error)
      }
    })()
  }

  return (
    <div className="yolo-settings-section">
      <section className="yolo-models-block">
        <div className="yolo-models-block-head">
          <div className="yolo-models-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-models-block-title">
              {t('settings.learning.generationTitle')}
            </div>
          </div>
        </div>

        <div className="yolo-models-block-content">
          <ObsidianSetting
            name={t('settings.learning.generationModel')}
            desc={t('settings.learning.generationModelDesc')}
            className="yolo-models-select-card"
          >
            <ObsidianDropdown
              value={settings.learningOptions.modelId}
              groupedOptions={modelGroups}
              onChange={updateModel}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.learning.outputLanguage')}
            desc={t('settings.learning.outputLanguageDesc')}
            className="yolo-models-select-card"
          >
            <ObsidianDropdown
              value={settings.learningOptions.outputLanguage ?? 'auto'}
              options={Object.fromEntries(
                LEARNING_OUTPUT_LANGUAGES.map((lang) => [
                  lang,
                  lang === 'auto'
                    ? t('settings.learning.outputLanguageAuto')
                    : OUTPUT_LANGUAGE_LABELS[lang],
                ]),
              )}
              onChange={updateOutputLanguage}
            />
          </ObsidianSetting>
        </div>
      </section>
    </div>
  )
}
