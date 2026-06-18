import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const migrateFrom72To73: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 73 }
  const yolo = isRecord(next.yolo) ? next.yolo : {}
  next.yolo = {
    ...yolo,
    vectorBackend: yolo.vectorBackend ?? 'sharded',
  }
  return next
}
