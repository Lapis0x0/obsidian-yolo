import {
  DEFAULT_TAB_COMPLETION_OPTIONS,
  type SettingMigration,
  type SmartComposerSettings,
} from '../setting.types'

const cloneDefaults = () => ({ ...DEFAULT_TAB_COMPLETION_OPTIONS })

export const migrateFrom23To24: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 24

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
      tabCompletionOptions: cloneDefaults(),
    }
    return newData
  }

  if (
    typeof continuationOptions.tabCompletionOptions !== 'object' ||
    continuationOptions.tabCompletionOptions === null
  ) {
    continuationOptions.tabCompletionOptions = cloneDefaults()
    newData.continuationOptions = continuationOptions
    return newData
  }

  const tabOptions = continuationOptions.tabCompletionOptions as Record<
    string,
    unknown
  >
  if (typeof tabOptions.idleTriggerEnabled !== 'boolean') {
    tabOptions.idleTriggerEnabled =
      DEFAULT_TAB_COMPLETION_OPTIONS.idleTriggerEnabled
  }

  continuationOptions.tabCompletionOptions = tabOptions
  newData.continuationOptions = continuationOptions
  return newData
}
