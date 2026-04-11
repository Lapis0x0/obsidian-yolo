import type { SettingMigration } from '../setting.types'

export const migrateFrom43To44: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 44 }
  const ragOptions = next.ragOptions

  if (
    ragOptions &&
    typeof ragOptions === 'object' &&
    !Array.isArray(ragOptions) &&
    (ragOptions as Record<string, unknown>).autoUpdateIntervalHours === 24
  ) {
    next.ragOptions = {
      ...(ragOptions as Record<string, unknown>),
      autoUpdateIntervalHours: 0,
    }
  }

  return next
}
