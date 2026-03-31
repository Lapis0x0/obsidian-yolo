import type { SettingMigration } from '../setting.types'

export const migrateFrom39To40: SettingMigration['migrate'] = (data) => {
  // No-op migration: bumps version to 40 for Amazon Bedrock provider support.
  // Bedrock providers are user-created (no default providers or models added).
  return { ...data, version: 40 }
}
