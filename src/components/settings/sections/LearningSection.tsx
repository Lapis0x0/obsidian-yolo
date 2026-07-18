import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import type { RegisteredModuleSettingsContributionV1 } from '../../../core/modules/moduleSettingsContributions'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'

import { ModuleSettingsSection } from './ModuleSettingsSection'

export function LearningSection({
  moduleSettings = [],
  handoffState = 'ready',
  retryHandoff,
}: {
  moduleSettings?: readonly RegisteredModuleSettingsContributionV1[]
  handoffState?: 'pending' | 'ready' | 'failed'
  retryHandoff?: () => Promise<void>
}) {
  if (moduleSettings.length > 0) {
    return <ModuleSettingsSection registrations={moduleSettings} />
  }
  return (
    <LegacyLearningSection
      handoffState={handoffState}
      retryHandoff={retryHandoff}
    />
  )
}

function LegacyLearningSection({
  handoffState,
  retryHandoff,
}: {
  handoffState: 'pending' | 'ready' | 'failed'
  retryHandoff?: () => Promise<void>
}) {
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
    if (handoffState !== 'ready') return
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

  return (
    <div className="yolo-settings-section">
      {handoffState !== 'ready' ? (
        <div className="yolo-module-settings-error" role="alert">
          <span>
            {handoffState === 'pending'
              ? 'Learning settings handoff is still in progress. Settings are read-only.'
              : 'Learning settings handoff could not be confirmed. Settings are read-only to prevent divergent copies.'}
          </span>
          {handoffState === 'failed' && retryHandoff ? (
            <button
              type="button"
              className="yolo-module-card-retry"
              onClick={() => void retryHandoff().catch(() => undefined)}
            >
              Retry handoff
            </button>
          ) : null}
        </div>
      ) : null}
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
              disabled={handoffState !== 'ready'}
              onChange={updateModel}
            />
          </ObsidianSetting>
        </div>
      </section>
    </div>
  )
}
