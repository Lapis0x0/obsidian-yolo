import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v63→v64: remove `chatOptions.historyArchiveEnabled` and
 * `chatOptions.historyArchiveThreshold`. History archive grouping is always
 * enabled with a fixed recent-conversation limit.
 */
export const migrateFrom63To64: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 64 }

  if (!isRecord(next.chatOptions)) {
    return next
  }

  const chatOptions = { ...next.chatOptions }
  delete chatOptions.historyArchiveEnabled
  delete chatOptions.historyArchiveThreshold
  next.chatOptions = chatOptions

  return next
}
