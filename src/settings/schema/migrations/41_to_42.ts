import type { SettingMigration } from '../setting.types'

export const migrateFrom41To42: SettingMigration['migrate'] = (data) => {
  return { ...data, version: 42 }
}
