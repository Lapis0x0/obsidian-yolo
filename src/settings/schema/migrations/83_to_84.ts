import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v83->v84: rename continuationOptions.smartSpaceQuickActions to
 * continuationOptions.continuationQuickActions. The old key name predated
 * the Quick Ask "continue" mode and referenced the now-removed Smart Space
 * panel it originally belonged to.
 */
export const migrateFrom83To84: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 84 }

  if (!isRecord(next.continuationOptions)) {
    return next
  }

  const { smartSpaceQuickActions, ...rest } = next.continuationOptions
  next.continuationOptions =
    smartSpaceQuickActions === undefined
      ? rest
      : { ...rest, continuationQuickActions: smartSpaceQuickActions }

  return next
}
