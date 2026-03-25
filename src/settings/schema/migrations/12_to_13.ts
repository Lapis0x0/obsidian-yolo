import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_TITLE_MODEL_ID,
} from '../../../constants'
import { SettingMigration } from '../setting.types'

const getDefaultTabCompletionModelId = () => {
  const defaultModel = DEFAULT_CHAT_MODELS.find(
    (model) => model.id === DEFAULT_CHAT_TITLE_MODEL_ID,
  )
  if (defaultModel) return defaultModel.id
  return DEFAULT_CHAT_MODELS[0]?.id
}

export const migrateFrom12To13: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 13

  const continuationOptionsRaw =
    typeof newData.continuationOptions === 'object' &&
    newData.continuationOptions !== null
      ? newData.continuationOptions
      : {}

  const continuationOptions = {
    ...continuationOptionsRaw,
  } as Record<string, unknown>

  if (typeof continuationOptions.enableTabCompletion !== 'boolean') {
    continuationOptions.enableTabCompletion = false
  }

  if (typeof continuationOptions.tabCompletionModelId !== 'string') {
    const fallbackModelId =
      typeof continuationOptions.fixedModelId === 'string'
        ? continuationOptions.fixedModelId
        : getDefaultTabCompletionModelId()
    continuationOptions.tabCompletionModelId = fallbackModelId
  }

  newData.continuationOptions = continuationOptions

  return newData
}
