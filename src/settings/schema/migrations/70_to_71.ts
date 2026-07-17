import type { SettingMigration } from '../setting.types'

/**
 * v70→v71: add plugin self-update auto-download preference (install still manual).
 */
export const migrateFrom70To71: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 71 }

  next.pluginUpdateAutoDownloadEnabled ??= true

  return next
}
