import {
  DEFAULT_TAB_COMPLETION_TRIGGERS,
  SettingMigration,
  SmartComposerSettings,
} from '../setting.types'

const cloneDefaults = () => [...DEFAULT_TAB_COMPLETION_TRIGGERS]

type LegacyTrigger = {
  id: string
  type: 'string' | 'regex'
  pattern: string
  enabled: boolean
  description?: string
  scope?: string
}

export const migrateFrom20To21: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 21

  const continuationOptionsRaw = newData.continuationOptions
  const continuationOptions:
    | SmartComposerSettings['continuationOptions']
    | Record<string, unknown>
    | undefined =
    continuationOptionsRaw && typeof continuationOptionsRaw === 'object'
      ? (continuationOptionsRaw as Record<string, unknown>)
      : undefined

  if (!continuationOptions) {
    newData.continuationOptions = {
      tabCompletionTriggers: cloneDefaults(),
    }
    return newData
  }

  const triggersRaw = continuationOptions.tabCompletionTriggers
  if (!Array.isArray(triggersRaw)) {
    continuationOptions.tabCompletionTriggers = cloneDefaults()
    newData.continuationOptions = continuationOptions
    return newData
  }

  const sanitized = triggersRaw
    .filter((trigger): trigger is LegacyTrigger => {
      return Boolean(
        trigger &&
          typeof trigger === 'object' &&
          typeof (trigger as LegacyTrigger).id === 'string' &&
          typeof (trigger as LegacyTrigger).type === 'string' &&
          typeof (trigger as LegacyTrigger).pattern === 'string',
      )
    })
    .map((trigger) => ({
      id: trigger.id,
      type: trigger.type === 'regex' ? 'regex' : 'string',
      pattern: trigger.pattern,
      enabled: typeof trigger.enabled === 'boolean' ? trigger.enabled : true,
      description: trigger.description,
    }))

  continuationOptions.tabCompletionTriggers =
    sanitized.length > 0 ? sanitized : cloneDefaults()
  newData.continuationOptions = continuationOptions
  return newData
}
