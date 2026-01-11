import {
  DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
  type SettingMigration,
  type SmartComposerSettings,
} from '../setting.types'

const VALID_PRESETS = new Set(['short', 'medium', 'long'])

export const migrateFrom22To23: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 23

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
      tabCompletionLengthPreset: DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
    }
    return newData
  }

  const rawPreset = continuationOptions.tabCompletionLengthPreset
  if (typeof rawPreset !== 'string' || !VALID_PRESETS.has(rawPreset)) {
    continuationOptions.tabCompletionLengthPreset =
      DEFAULT_TAB_COMPLETION_LENGTH_PRESET
  }

  newData.continuationOptions = continuationOptions
  return newData
}
