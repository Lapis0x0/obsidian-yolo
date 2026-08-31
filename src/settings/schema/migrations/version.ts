/**
 * Kept free of imports so `setting.types.ts` can read the current schema
 * version without importing the migration list, which itself depends on
 * `setting.types.ts` (breaking that edge removes the migration→types→index
 * dependency cycles).
 */
export const SETTINGS_SCHEMA_VERSION = 84
