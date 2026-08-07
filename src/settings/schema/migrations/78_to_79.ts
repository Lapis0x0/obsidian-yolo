import type { SettingMigration } from '../setting.types'

/**
 * v78→v79: purely additive schema bump.
 *
 * - `builtinToolProvider` enum gains `'deepseek'`.
 * - `builtinTools` gains an optional `deepseek` sub-key (model-level toggle
 *   for DeepSeek's server-side web search).
 *
 * Existing v78 data is forward-compatible — every new field is optional and
 * old values stay valid. The migration only stamps the version so loaders
 * stay in lock-step with `SETTINGS_SCHEMA_VERSION`.
 */
export const migrateFrom78To79: SettingMigration['migrate'] = (data) => {
  return { ...data, version: 79 }
}
