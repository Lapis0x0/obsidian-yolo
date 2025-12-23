import {
  DEFAULT_TAB_COMPLETION_OPTIONS,
  SettingMigration,
  SmartComposerSettings,
} from '../setting.types'

const cloneDefaults = () => ({ ...DEFAULT_TAB_COMPLETION_OPTIONS })

/**
 * Migration from v18 to v19:
 * - Merge maxBeforeChars + maxAfterChars into contextRange
 * - Remove maxTokens (now auto-computed from maxSuggestionLength)
 * - Remove maxRetries (now fixed at 1)
 */
export const migrateFrom18To19: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 19

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

  // Compute contextRange from legacy maxBeforeChars + maxAfterChars
  const legacyMaxBefore =
    typeof legacy.maxBeforeChars === 'number' &&
    Number.isFinite(legacy.maxBeforeChars)
      ? legacy.maxBeforeChars
      : 3000
  const legacyMaxAfter =
    typeof legacy.maxAfterChars === 'number' &&
    Number.isFinite(legacy.maxAfterChars)
      ? legacy.maxAfterChars
      : 1000

  const contextRange = legacyMaxBefore + legacyMaxAfter

  // Build new options, excluding removed fields
  const newOptions: Record<string, unknown> = {
    triggerDelayMs:
      typeof legacy.triggerDelayMs === 'number'
        ? legacy.triggerDelayMs
        : defaults.triggerDelayMs,
    minContextLength:
      typeof legacy.minContextLength === 'number'
        ? legacy.minContextLength
        : defaults.minContextLength,
    contextRange,
    maxSuggestionLength:
      typeof legacy.maxSuggestionLength === 'number'
        ? legacy.maxSuggestionLength
        : defaults.maxSuggestionLength,
    temperature:
      typeof legacy.temperature === 'number'
        ? legacy.temperature
        : defaults.temperature,
    requestTimeoutMs:
      typeof legacy.requestTimeoutMs === 'number'
        ? legacy.requestTimeoutMs
        : defaults.requestTimeoutMs,
  }

  continuationOptions.tabCompletionOptions = newOptions
  newData.continuationOptions = continuationOptions
  return newData
}
