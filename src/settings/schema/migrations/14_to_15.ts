import {
  DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
  SettingMigration,
  SmartComposerSettings,
} from '../setting.types'

// Legacy defaults for v14->v15 migration (before schema v19 changes)
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

export const migrateFrom14To15: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 15

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
      tabCompletionSystemPrompt: DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
    }
    return newData
  }

  const existingOptions = continuationOptions

  if (
    typeof existingOptions.tabCompletionOptions !== 'object' ||
    existingOptions.tabCompletionOptions === null
  ) {
    existingOptions.tabCompletionOptions = cloneDefaults()
  } else {
    const legacy = existingOptions.tabCompletionOptions as Record<
      string,
      unknown
    >
    existingOptions.tabCompletionOptions = {
      ...cloneDefaults(),
      ...legacy,
      maxTokens:
        typeof legacy.maxTokens === 'number' &&
        Number.isFinite(legacy.maxTokens)
          ? legacy.maxTokens
          : LEGACY_TAB_COMPLETION_DEFAULTS.maxTokens,
    }
  }

  if (typeof existingOptions.tabCompletionSystemPrompt !== 'string') {
    existingOptions.tabCompletionSystemPrompt =
      DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT
  }

  newData.continuationOptions = existingOptions
  return newData
}
