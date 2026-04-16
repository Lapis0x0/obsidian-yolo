import type { SettingMigration } from '../setting.types'

export const migrateFrom44To45: SettingMigration['migrate'] = (data) => {
  return { ...data, version: 45 }
}
