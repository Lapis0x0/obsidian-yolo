import { SettingMigration } from '../setting.types'

// Legacy defaults for v13->v14 migration (before schema v19 changes)
const LEGACY_TAB_COMPLETION_DEFAULTS = {
  triggerDelayMs: 3000,
  minContextLength: 20,
  maxBeforeChars: 3000,
  maxAfterChars: 1000,
  maxSuggestionLength: 240,
  maxTokens: 64,
  temperature: 0.5,
  requestTimeoutMs: 12000,
  maxRetries: 0,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const normalizeNumber = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return fallback
}

export const migrateFrom13To14: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 14

  if (!isRecord(newData.continuationOptions)) {
    newData.continuationOptions = {}
  }

  const continuationOptions = newData.continuationOptions as Record<
    string,
    unknown
  >

  if (!isRecord(continuationOptions.tabCompletionOptions)) {
    continuationOptions.tabCompletionOptions = {
      ...LEGACY_TAB_COMPLETION_DEFAULTS,
    }
  } else {
    const options = { ...LEGACY_TAB_COMPLETION_DEFAULTS }
    const legacy = continuationOptions.tabCompletionOptions

    options.triggerDelayMs = normalizeNumber(
      legacy.triggerDelayMs,
      options.triggerDelayMs,
    )
    options.minContextLength = normalizeNumber(
      legacy.minContextLength,
      options.minContextLength,
    )
    const legacyMaxContext = normalizeNumber(
      legacy.maxContextChars,
      options.maxBeforeChars,
    )
    const hasLegacyBefore = Object.prototype.hasOwnProperty.call(
      legacy,
      'maxBeforeChars',
    )
    const hasLegacyAfter = Object.prototype.hasOwnProperty.call(
      legacy,
      'maxAfterChars',
    )

    options.maxBeforeChars = hasLegacyBefore
      ? normalizeNumber(legacy.maxBeforeChars, options.maxBeforeChars)
      : legacyMaxContext
    options.maxAfterChars = hasLegacyAfter
      ? normalizeNumber(legacy.maxAfterChars, options.maxAfterChars)
      : options.maxAfterChars
    options.maxSuggestionLength = normalizeNumber(
      legacy.maxSuggestionLength,
      options.maxSuggestionLength,
    )
    options.temperature = normalizeNumber(
      legacy.temperature,
      options.temperature,
    )
    options.requestTimeoutMs = normalizeNumber(
      legacy.requestTimeoutMs,
      options.requestTimeoutMs,
    )
    options.maxRetries = Math.max(
      0,
      Math.min(
        5,
        Math.round(normalizeNumber(legacy.maxRetries, options.maxRetries)),
      ),
    )

    continuationOptions.tabCompletionOptions = options
  }

  newData.continuationOptions = continuationOptions

  return newData
}
