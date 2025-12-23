import {
  DEFAULT_TAB_COMPLETION_TRIGGERS,
  SettingMigration,
  SmartComposerSettings,
} from '../setting.types'

const cloneDefaults = () => [...DEFAULT_TAB_COMPLETION_TRIGGERS]

export const migrateFrom19To20: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 20

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

  if (!Array.isArray(continuationOptions.tabCompletionTriggers)) {
    continuationOptions.tabCompletionTriggers = cloneDefaults()
  }

  newData.continuationOptions = continuationOptions
  return newData
}
