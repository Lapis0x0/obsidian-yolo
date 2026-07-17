import { DEFAULT_CHAT_QUICK_ACCESS_ENTRIES } from '../../chatQuickAccess'
import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** v74→v75: seed the customizable Chat empty-state quick access entries. */
export const migrateFrom74To75: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 75 }
  const chatOptions = isRecord(next.chatOptions) ? next.chatOptions : {}

  next.chatOptions = {
    ...chatOptions,
    quickAccessEntries: Array.isArray(chatOptions.quickAccessEntries)
      ? chatOptions.quickAccessEntries
      : DEFAULT_CHAT_QUICK_ACCESS_ENTRIES.map((entry) => ({ ...entry })),
  }

  return next
}
