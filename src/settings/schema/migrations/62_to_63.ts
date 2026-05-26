import type { SettingMigration } from '../setting.types'

/**
 * v62→v63: introduce `contextVoiceInputOptions` for the context-aware voice
 * input feature (Slice A). All new fields have schema-level defaults via
 * `.catch()`, so this migration only needs to bump the version stamp; existing
 * users get the inert default state where the feature is disabled until they
 * configure an ASR provider in the Models tab.
 */
export const migrateFrom62To63: SettingMigration['migrate'] = (data) => {
  return { ...data, version: 63 }
}
