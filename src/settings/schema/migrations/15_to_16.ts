import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_TITLE_MODEL_ID,
} from '../../../constants'
import { SettingMigration } from '../setting.types'

const getDefaultContinuationModelId = () => {
  const defaultModel = DEFAULT_CHAT_MODELS.find(
    (model) => model.id === DEFAULT_CHAT_TITLE_MODEL_ID,
  )
  if (defaultModel) return defaultModel.id
  return DEFAULT_CHAT_MODELS[0]?.id
}

export const migrateFrom15To16: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 16

  const continuationOptionsRaw =
    typeof newData.continuationOptions === 'object' &&
    newData.continuationOptions !== null
      ? (newData.continuationOptions as Record<string, unknown>)
      : {}

  const continuationOptions = { ...continuationOptionsRaw }

  const legacyUseCurrent = continuationOptions.useCurrentModel
  if (typeof continuationOptions.enableSuperContinuation !== 'boolean') {
    continuationOptions.enableSuperContinuation =
      typeof legacyUseCurrent === 'boolean' ? !legacyUseCurrent : false
  }

  if (typeof continuationOptions.continuationModelId !== 'string') {
    let fallback: unknown = continuationOptions.fixedModelId
    if (typeof fallback !== 'string') {
      fallback =
        typeof newData.chatModelId === 'string'
          ? newData.chatModelId
          : getDefaultContinuationModelId()
    }
    continuationOptions.continuationModelId = fallback as string
  }

  delete continuationOptions.useCurrentModel
  delete continuationOptions.fixedModelId

  newData.continuationOptions = continuationOptions
  return newData
}
