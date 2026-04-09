import type { SettingMigration } from '../setting.types'

export const migrateFrom42To43: SettingMigration['migrate'] = (data) => {
  return { ...data, version: 43 }
}
