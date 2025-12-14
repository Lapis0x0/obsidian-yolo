import { DEFAULT_ASSISTANT_ICON } from '../../../utils/assistant-icon'
import { SettingMigration } from '../setting.types'

export const migrateFrom16To17: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 17

  // 为现有的助手添加默认图标
  if (Array.isArray(newData.assistants)) {
    newData.assistants = newData.assistants.map((assistant) => {
      if (!assistant || typeof assistant !== 'object') {
        return assistant
      }

      const assistantObj = assistant as Record<string, unknown>

      // 如果助手已经有图标，保持不变
      if (assistantObj.icon) {
        return assistantObj
      }

      // 否则添加默认图标
      return {
        ...assistantObj,
        icon: DEFAULT_ASSISTANT_ICON,
      }
    })
  }

  return newData
}
