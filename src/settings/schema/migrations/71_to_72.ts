import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v71→v72: default RAG indexing to skip the plugin's YOLO base directory.
 * Skills / snippets / data mirror under that folder are plugin metadata, not
 * user knowledge — surfacing them in vector search is noise. Stored as a
 * boolean so the actual path stays dynamic against `yolo.baseDir`; users can
 * remove the corresponding chip in settings to opt out.
 */
export const migrateFrom71To72: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 72 }
  const ragOptions = isRecord(next.ragOptions) ? next.ragOptions : {}
  next.ragOptions = {
    ...ragOptions,
    excludeYoloBaseDir: ragOptions.excludeYoloBaseDir ?? true,
  }
  return next
}
