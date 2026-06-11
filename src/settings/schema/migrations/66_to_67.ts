import type { SettingMigration } from '../setting.types'

/**
 * v66→v67: add update-toast dismissal state. The first close records a soft
 * dismissal so the same version can surface once more on next launch; the
 * second close records a persistent mute for that version.
 */
export const migrateFrom66To67: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 67 }

  next.softDismissedUpdateVersion ??= ''
  next.mutedUpdateVersion ??= ''

  return next
}
