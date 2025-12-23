import {
  DEFAULT_TAB_COMPLETION_OPTIONS,
  SettingMigration,
  SmartComposerSettings,
} from '../setting.types'

const cloneDefaults = () => ({ ...DEFAULT_TAB_COMPLETION_OPTIONS })

export const migrateFrom17To18: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 18

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

  const legacy = continuationOptions.tabCompletionOptions as Record<
    string,
    unknown
  >
  const defaults = cloneDefaults()
  const legacyMaxContext =
    typeof legacy.maxContextChars === 'number' &&
    Number.isFinite(legacy.maxContextChars)
      ? legacy.maxContextChars
      : undefined

  const maxBeforeChars =
    typeof legacy.maxBeforeChars === 'number' &&
    Number.isFinite(legacy.maxBeforeChars)
      ? legacy.maxBeforeChars
      : (legacyMaxContext ?? defaults.maxBeforeChars)
  const maxAfterChars =
    typeof legacy.maxAfterChars === 'number' &&
    Number.isFinite(legacy.maxAfterChars)
      ? legacy.maxAfterChars
      : defaults.maxAfterChars

  continuationOptions.tabCompletionOptions = {
    ...defaults,
    ...legacy,
    maxBeforeChars,
    maxAfterChars,
  }

  newData.continuationOptions = continuationOptions
  return newData
}
