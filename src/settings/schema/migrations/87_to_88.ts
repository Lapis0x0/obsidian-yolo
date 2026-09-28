import type { SettingMigration } from '../setting.types'

/**
 * v87→v88:
 *
 * - Fold the two update toggles into one update mode (Refs #611).
 *   `pluginUpdateNoticeEnabled` gated the update toast and
 *   `pluginUpdateAutoDownloadEnabled` only chose whether to download ahead of
 *   it. Automatic updating is new and never chosen for the user, so turned-off
 *   notices become `off` and everything else `notify`, which now always
 *   downloads ahead.
 * - Context compaction is now forced by the runtime and keyed only on a share
 *   of the context window, so the threshold mode and absolute token threshold
 *   go away. Users still on the old defaults (off, 80%) never chose them and
 *   move to the new ones (on, 90%); anyone who changed either keeps theirs.
 */
export const migrateFrom87To88: SettingMigration['migrate'] = (data) => {
  const {
    pluginUpdateNoticeEnabled,
    pluginUpdateAutoDownloadEnabled: _autoDownload,
    ...rest
  } = data
  return {
    ...rest,
    version: 88,
    pluginUpdateMode: pluginUpdateNoticeEnabled === false ? 'off' : 'notify',
    ...(isRecord(rest.chatOptions)
      ? { chatOptions: migrateAutoContextCompaction(rest.chatOptions) }
      : {}),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const migrateAutoContextCompaction = (
  chatOptions: Record<string, unknown>,
): Record<string, unknown> => {
  const {
    autoContextCompactionThresholdMode: _mode,
    autoContextCompactionThresholdTokens: _tokens,
    ...rest
  } = chatOptions
  const onOldDefaults =
    (rest.autoContextCompactionEnabled ?? false) === false &&
    (rest.autoContextCompactionThresholdRatio ?? 0.8) === 0.8
  return onOldDefaults
    ? {
        ...rest,
        autoContextCompactionEnabled: true,
        autoContextCompactionThresholdRatio: 0.9,
      }
    : rest
}
