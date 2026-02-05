import { SettingMigration } from '../setting.types'

export const migrateFrom27To28: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 28

  if (typeof newData.quickAskAssistantId !== 'string') {
    newData.quickAskAssistantId = newData.currentAssistantId
  }

  return newData
}
