import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type {
  ModuleSettingsFieldSnapshotV1,
  RegisteredModuleSettingsContributionV1,
  YoloModuleSettingFieldV1,
} from '../../../core/modules/moduleSettingsContributions'
import { resolveSettingsContribution } from '../../../core/modules/moduleSettingsContributions'
import { ObsidianSetting } from '../../common/ObsidianSetting'

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
    <section className="yolo-module-settings-block">
      <div className="yolo-settings-sub-header">{localized.title}</div>
      {localized.fields.map((field) => (
        <ObsidianSetting
          key={field.key}
          name={field.name}
          desc={field.description}
          className="yolo-module-settings-field"
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
      <input
        className="yolo-module-settings-toggle"
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    )
  }
  if (field.type === 'text') {
    return (
      <input
        className="yolo-module-settings-text"
        type="text"
        defaultValue={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onBlur={(event) => onChange(event.currentTarget.value)}
      />
    )
  }
  return (
    <select
      className="yolo-module-settings-select"
      value={typeof value === 'string' ? value : ''}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {!snapshot.models.models.some((model) => model.id === value) ? (
        <option value="">
          {snapshot.models.defaultModelId || t('common.default')}
        </option>
      ) : null}
      {snapshot.models.models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.name} ({model.providerId})
        </option>
      ))}
    </select>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
