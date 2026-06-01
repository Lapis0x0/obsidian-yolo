import type { SettingMigration } from '../setting.types'

/**
 * v66→v67: add `mutedUpdateVersion` for the "don't notify for this version"
 * action in the update toast. Default to an empty string (nothing muted).
 */
export const migrateFrom66To67: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 67 }

  if (next.mutedUpdateVersion === undefined) {
    next.mutedUpdateVersion = ''
  }

  return next
}
