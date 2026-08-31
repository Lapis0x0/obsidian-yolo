import type { SettingMigration } from '../setting.types'

/**
 * v79→v80: add the update-notice preference (Refs #571).
 *
 * `pluginUpdateNoticeEnabled` gates the update toast for both the plugin and
 * modules, and with it the background download. Existing installs keep today's
 * behaviour, so it defaults to true.
 */
export const migrateFrom79To80: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 80 }

  next.pluginUpdateNoticeEnabled ??= true

  return next
}
