import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v86→v87: reset the per-runtime CLI model defaults.
 *
 * `chatOptions.cliModelIdByRuntime` / `cliReasoningEffortByModel` used to be
 * written automatically — every model a CLI reported on bind, and every pick
 * in the picker, became the default for the next conversation and was pushed
 * back onto the CLI with `set_model`, overriding its own configuration. They
 * now hold only a default the user explicitly set from the picker, so the
 * auto-captured values are dropped and every runtime starts out following
 * its CLI's configuration.
 */
export const migrateFrom86To87: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 87 }
  if (isRecord(next.chatOptions)) {
    next.chatOptions = {
      ...next.chatOptions,
      cliModelIdByRuntime: {},
      cliReasoningEffortByModel: {},
    }
  }
  return next
}
