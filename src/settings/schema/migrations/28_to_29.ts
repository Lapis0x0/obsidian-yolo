import { detectReasoningTypeFromModelId } from '../../../utils/model-id-utils'
import type { SettingMigration } from '../setting.types'

export const migrateFrom28To29: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 29

  const chatModelsRaw = newData.chatModels
  if (!Array.isArray(chatModelsRaw)) {
    return newData
  }

  newData.chatModels = chatModelsRaw.map((model) => {
    if (!model || typeof model !== 'object') {
      return model
    }

    const record = model as Record<string, unknown>
    if (record.isBaseModel === true) {
      return model
    }

    if (typeof record.reasoningType === 'string') {
      return model
    }

    const modelId = typeof record.model === 'string' ? record.model : ''
    if (!modelId) {
      return model
    }

    const hasReasoningConfig =
      typeof record.reasoning !== 'undefined' ||
      typeof record.thinking !== 'undefined'
    if (hasReasoningConfig) {
      return model
    }

    const detected = detectReasoningTypeFromModelId(modelId)
    if (detected === 'none') {
      return model
    }

    return {
      ...record,
      reasoningType: 'none',
    }
  })

  return newData
}
