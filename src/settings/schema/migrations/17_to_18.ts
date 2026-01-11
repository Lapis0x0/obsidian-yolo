import { SettingMigration, SmartComposerSettings } from '../setting.types'

// Legacy defaults for v17->v18 migration (before schema v19 changes)
const LEGACY_TAB_COMPLETION_DEFAULTS = {
  triggerDelayMs: 3000,
  minContextLength: 20,
  maxBeforeChars: 3000,
  maxAfterChars: 1000,
  maxSuggestionLength: 2000,
  maxTokens: 64,
  temperature: 0.5,
  requestTimeoutMs: 12000,
  maxRetries: 0,
}

const cloneDefaults = () => ({ ...LEGACY_TAB_COMPLETION_DEFAULTS })

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
