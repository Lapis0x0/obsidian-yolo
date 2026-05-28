import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v62→v63: remove deprecated `continuationOptions.persistSelectionHighlight`.
 * Selection block highlight is always on during sidebar Chat / Quick Ask.
 */
export const migrateFrom62To63: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 63 }

  if (!isRecord(next.continuationOptions)) {
    return next
  }

  const continuationOptions = { ...next.continuationOptions }
  delete continuationOptions.persistSelectionHighlight
  next.continuationOptions = continuationOptions

  return next
}
