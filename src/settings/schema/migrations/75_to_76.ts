import type { SettingMigration } from '../setting.types'

/** v75→v76: persist per-module update versions muted by the user. */
export const migrateFrom75To76: SettingMigration['migrate'] = (data) => ({
  ...data,
  version: 76,
  mutedModuleUpdateVersions: {},
})
