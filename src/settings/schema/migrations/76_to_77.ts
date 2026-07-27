import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** v76→v77: enable multiple Tab completion candidates by default. */
export const migrateFrom76To77: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 77 }
  const continuationOptions = isRecord(next.continuationOptions)
    ? { ...next.continuationOptions }
    : {}
  const tabCompletionOptions = isRecord(
    continuationOptions.tabCompletionOptions,
  )
    ? { ...continuationOptions.tabCompletionOptions }
    : {}

  if (typeof tabCompletionOptions.multipleCandidatesEnabled !== 'boolean') {
    tabCompletionOptions.multipleCandidatesEnabled = true
  }
  continuationOptions.tabCompletionOptions = tabCompletionOptions
  next.continuationOptions = continuationOptions
  return next
}
