import type { SettingMigration } from '../setting.types'

/**
 * v87→v88: fold the two update toggles into one update mode (Refs #611).
 *
 * `pluginUpdateNoticeEnabled` gated the update toast and
 * `pluginUpdateAutoDownloadEnabled` only chose whether to download ahead of
 * it. Automatic updating is new and never chosen for the user, so turned-off
 * notices become `off` and everything else `notify`, which now always
 * downloads ahead.
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
  }
}
