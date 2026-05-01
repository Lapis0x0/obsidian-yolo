import type { SettingMigration } from '../setting.types'

export const migrateFrom49To50: SettingMigration['migrate'] = (data) => {
  return { ...data, version: 50 }
}
