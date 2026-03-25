import type { SettingMigration } from '../setting.types'

export const migrateFrom38To39: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 39 }

  if (
    typeof next.chatTitleModelId !== 'string' &&
    typeof next.applyModelId === 'string'
  ) {
    next.chatTitleModelId = next.applyModelId
  }

  delete next.applyModelId

  return next
}
