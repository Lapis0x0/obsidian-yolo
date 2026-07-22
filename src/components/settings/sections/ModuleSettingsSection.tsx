import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type {
  ModuleSettingsFieldSnapshotV1,
  RegisteredModuleSettingsContributionV1,
  YoloModuleSettingFieldV1,
} from '../../../core/modules/moduleSettingsContributions'
import { resolveSettingsContribution } from '../../../core/modules/moduleSettingsContributions'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

type ModuleSettingsSectionProps = {
  registrations: readonly RegisteredModuleSettingsContributionV1[]
}

export function ModuleSettingsSection({
  registrations,
}: ModuleSettingsSectionProps) {
  return (
    <div className="yolo-settings-section yolo-module-settings">
      {registrations.map((registration) => (
        <ModuleSettingsContribution
          key={`${registration.moduleId}:${registration.contribution.id}`}
          registration={registration}
        />
      ))}
    </div>
  )
}

function ModuleSettingsContribution({
  registration,
}: {
  registration: RegisteredModuleSettingsContributionV1
}) {
  const { language, t } = useLanguage()
  const localized = resolveSettingsContribution(
    registration.contribution,
    language,
  )
  const [snapshot, setSnapshot] =
    useState<ModuleSettingsFieldSnapshotV1 | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    const refresh = () => {
      void registration.fields.getSnapshot().then(
        (next) => {
          if (!current) return
          setSnapshot(next)
          setError(null)
        },
        (reason: unknown) => {
          if (current) setError(errorMessage(reason))
        },
      )
    }
    let unsubscribe: () => void = () => undefined
    try {
      unsubscribe = registration.fields.subscribe(refresh)
    } catch (reason: unknown) {
      setError(errorMessage(reason))
    }
    refresh()
    return () => {
      current = false
      unsubscribe()
    }
  }, [registration])

  const write = (key: string, value: string | boolean) => {
    setSavingKey(key)
    setError(null)
    void (async () => {
      try {
        const next = await registration.fields.write(key, value)
        setSnapshot(next)
        setSavingKey(null)
      } catch (reason: unknown) {
        setError(errorMessage(reason))
        setSavingKey(null)
      }
    })()
  }

  return (
    <section className="yolo-models-block yolo-module-settings-block">
      <div className="yolo-models-block-head">
        <div className="yolo-models-block-head-title-row">
          <div className="yolo-settings-sub-header yolo-models-block-title">
            {localized.title}
          </div>
        </div>
      </div>
      <div className="yolo-models-block-content">
        {localized.fields.map((field) => (
          <ObsidianSetting
            key={field.key}
            name={field.name}
            desc={field.description}
            className="yolo-models-select-card yolo-module-settings-field"
          >
            {snapshot ? (
              <ModuleSettingControl
                field={field}
                snapshot={snapshot}
                disabled={savingKey === field.key}
                onChange={(value) => write(field.key, value)}
              />
            ) : null}
          </ObsidianSetting>
        ))}
        {error ? (
          <div className="yolo-module-settings-error" role="alert">
            {t(
              'settings.modules.settingsSaveError',
              'Unable to save module settings',
            )}
            {`: ${error}`}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function ModuleSettingControl({
  field,
  snapshot,
  disabled,
  onChange,
}: {
  field: YoloModuleSettingFieldV1
  snapshot: ModuleSettingsFieldSnapshotV1
  disabled: boolean
  onChange: (value: string | boolean) => void
}) {
  const { t } = useLanguage()
  const value = snapshot.values[field.key]
  if (field.type === 'toggle') {
    return (
      <ObsidianToggle
        value={value === true}
        disabled={disabled}
        onChange={onChange}
      />
    )
  }
  if (field.type === 'text') {
    return (
      <ObsidianTextInput
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onChange={() => undefined}
        onBlur={onChange}
      />
    )
  }
  const hasSelectedModel = snapshot.models.models.some(
    (model) => model.id === value,
  )
  const options = Object.fromEntries([
    ...(!hasSelectedModel
      ? [['', snapshot.models.defaultModelId || t('common.default')] as const]
      : []),
    ...snapshot.models.models.map(
      (model) => [model.id, `${model.name} (${model.providerId})`] as const,
    ),
  ])
  return (
    <ObsidianDropdown
      value={hasSelectedModel && typeof value === 'string' ? value : ''}
      options={options}
      disabled={disabled}
      onChange={onChange}
    />
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
