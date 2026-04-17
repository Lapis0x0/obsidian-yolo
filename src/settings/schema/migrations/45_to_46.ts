import type { SettingMigration } from '../setting.types'

export const migrateFrom45To46: SettingMigration['migrate'] = (data) => {
  const existingExperimental =
    data.experimental && typeof data.experimental === 'object'
      ? (data.experimental as Record<string, unknown>)
      : {}
  return {
    ...data,
    experimental: {
      ...existingExperimental,
      storeDataInVault:
        typeof existingExperimental.storeDataInVault === 'boolean'
          ? existingExperimental.storeDataInVault
          : false,
    },
    version: 46,
  }
}
