import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * v58→v59: introduce `chatExport` for per-user chat export folder/filename
 * configuration, including optional sync with Obsidian's core `unique-note`
 * plugin. Older settings have no such field; seed safe defaults so existing
 * exports keep landing at `{baseDir}/Exports/{title} - YYYY-MM-DD.md`.
 */
export const migrateFrom58To59: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 59 }

  if (!isRecord(next.chatExport)) {
    next.chatExport = {
      followUniqueNote: false,
      folder: '',
      filenameTemplate: '{{title}} - {{date}}',
      appendTitleWhenFollowing: true,
      conflictStrategy: 'suffix',
    }
  }

  return next
}
