import type { SettingMigration } from '../setting.types'

export const migrateFrom43To44: SettingMigration['migrate'] = (data) => {
  const chatOptionsRecord =
    data.chatOptions && typeof data.chatOptions === 'object'
      ? { ...(data.chatOptions as Record<string, unknown>) }
      : {}

  if (!('chatExportFolder' in chatOptionsRecord)) {
    chatOptionsRecord.chatExportFolder = 'YOLO Exports'
  }

  return { ...data, version: 44, chatOptions: chatOptionsRecord }
}
