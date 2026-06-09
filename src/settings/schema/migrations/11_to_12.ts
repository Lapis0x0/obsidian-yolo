import { migrateModelId } from '../../../utils/model-id-utils'
import { SettingMigration } from '../setting.types'
import {
  getMigratedChatModels,
  getMigratedEmbeddingModels,
} from './migrationUtils'

type ModelWithProvider = {
  id: string
  providerId: string
}

const isModelWithProvider = (value: unknown): value is ModelWithProvider => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.providerId === 'string'
}

/**
 * Migration from version 11 to version 12
 * - Add provider prefix to all model IDs to support multiple providers with same model names
 * - Update chatModelId and applyModelId to use prefixed format
 * - Update embeddingModelId to use prefixed format
 * - Transform existing model IDs: gpt-4 -> openai/gpt-4, claude-3.5-sonnet -> anthropic/claude-3.5-sonnet, etc.
 */
export const migrateFrom11To12: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 12

  // Migrate chat models to use prefixed IDs
  if ('chatModels' in newData && Array.isArray(newData.chatModels)) {
    newData.chatModels = newData.chatModels.map((model) => {
      const migratedId = migrateModelId(model.id, model.providerId)
      return {
        ...model,
        id: migratedId,
      }
    })
  }

  // Migrate embedding models to use prefixed IDs
  if ('embeddingModels' in newData && Array.isArray(newData.embeddingModels)) {
    newData.embeddingModels = newData.embeddingModels.map((model) => {
      const migratedId = migrateModelId(model.id, model.providerId)
      return {
        ...model,
        id: migratedId,
      }
    })
  }

  // Migrate selected model IDs
  if ('chatModelId' in newData && typeof newData.chatModelId === 'string') {
    const chatModelId = newData.chatModelId
    // Find the corresponding model to get its providerId
    const chatModels = Array.isArray(newData.chatModels)
      ? newData.chatModels.filter(isModelWithProvider)
      : []
    const chatModel = chatModels.find((model) => model.id.endsWith(chatModelId))
    if (chatModel) {
      newData.chatModelId = migrateModelId(chatModelId, chatModel.providerId)
    } else {
      // Fallback: assume it's an OpenAI model if not found
      newData.chatModelId = migrateModelId(chatModelId, 'openai')
    }
  }

  if ('applyModelId' in newData && typeof newData.applyModelId === 'string') {
    const applyModelId = newData.applyModelId
    // Find the corresponding model to get its providerId
    const chatModels = Array.isArray(newData.chatModels)
      ? newData.chatModels.filter(isModelWithProvider)
      : []
    const applyModel = chatModels.find((model) =>
      model.id.endsWith(applyModelId),
    )
    if (applyModel) {
      newData.applyModelId = migrateModelId(applyModelId, applyModel.providerId)
    } else {
      // Fallback: assume it's an OpenAI model if not found
      newData.applyModelId = migrateModelId(applyModelId, 'openai')
    }
  }

  if (
    'embeddingModelId' in newData &&
    typeof newData.embeddingModelId === 'string'
  ) {
    const embeddingModelId = newData.embeddingModelId
    // Find the corresponding model to get its providerId
    const embeddingModels = Array.isArray(newData.embeddingModels)
      ? newData.embeddingModels.filter(isModelWithProvider)
      : []
    const embeddingModel = embeddingModels.find((model) =>
      model.id.endsWith(embeddingModelId),
    )
    if (embeddingModel) {
      newData.embeddingModelId = migrateModelId(
        embeddingModelId,
        embeddingModel.providerId,
      )
    } else {
      // Fallback: assume it's an OpenAI model if not found
      newData.embeddingModelId = migrateModelId(embeddingModelId, 'openai')
    }
  }

  // Add new default models with prefixed IDs
  newData.chatModels = getMigratedChatModels(newData, DEFAULT_CHAT_MODELS_V12)
  newData.embeddingModels = getMigratedEmbeddingModels(
    newData,
    DEFAULT_EMBEDDING_MODELS_V12,
  )

  return newData
}

type DefaultChatModelsV12 = {
  id: string
  providerType: string
  providerId: string
  model: string
  reasoning?: {
    enabled: boolean
    reasoning_effort?: string
  }
  thinking?: {
    enabled: boolean
    budget_tokens: number
  }
  web_search_options?: {
    search_context_size?: string
  }
  enable?: boolean
}[]

type DefaultEmbeddingModelsV12 = {
  id: string
  providerType: string
  providerId: string
  model: string
  dimension: number
}[]

export const DEFAULT_CHAT_MODELS_V12: DefaultChatModelsV12 = [
  {
    providerType: 'anthropic',
    providerId: 'anthropic',
    id: 'anthropic/claude-sonnet-4.0',
    model: 'claude-sonnet-4-0',
    enable: false,
  },
  {
    providerType: 'anthropic',
    providerId: 'anthropic',
    id: 'anthropic/claude-opus-4.1',
    model: 'claude-opus-4-1',
    enable: false,
  },
  {
    providerType: 'anthropic',
    providerId: 'anthropic',
    id: 'anthropic/claude-3.7-sonnet',
    model: 'claude-3-7-sonnet-latest',
    enable: false,
  },
  {
    providerType: 'anthropic',
    providerId: 'anthropic',
    id: 'anthropic/claude-3.5-sonnet',
    model: 'claude-3-5-sonnet-latest',
    enable: false,
  },
  {
    providerType: 'anthropic',
    providerId: 'anthropic',
    id: 'anthropic/claude-3.5-haiku',
    model: 'claude-3-5-haiku-latest',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/gpt-5',
    model: 'gpt-5',
    enable: true,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/gpt-5-mini',
    model: 'gpt-5-mini',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/gpt-5-nano',
    model: 'gpt-5-nano',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/gpt-4.1',
    model: 'gpt-4.1',
    enable: true,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/gpt-4.1-mini',
    model: 'gpt-4.1-mini',
    enable: true,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/gpt-4.1-nano',
    model: 'gpt-4.1-nano',
    enable: true,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/gpt-4o',
    model: 'gpt-4o',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/gpt-4o-mini',
    model: 'gpt-4o-mini',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/o4-mini',
    model: 'o4-mini',
    enable: false,
    reasoning: {
      enabled: true,
      reasoning_effort: 'medium',
    },
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/o3',
    model: 'o3',
    enable: false,
    reasoning: {
      enabled: true,
      reasoning_effort: 'medium',
    },
  },
  {
    providerType: 'gemini',
    providerId: 'gemini',
    id: 'gemini/gemini-2.5-pro',
    model: 'gemini-2.5-pro',
    enable: false,
  },
  {
    providerType: 'gemini',
    providerId: 'gemini',
    id: 'gemini/gemini-2.5-flash',
    model: 'gemini-2.5-flash',
    enable: false,
  },
  {
    providerType: 'gemini',
    providerId: 'gemini',
    id: 'gemini/gemini-2.5-flash-lite',
    model: 'gemini-2.5-flash-lite',
    enable: false,
  },
  {
    providerType: 'gemini',
    providerId: 'gemini',
    id: 'gemini/gemini-2.0-flash',
    model: 'gemini-2.0-flash',
    enable: false,
  },
  {
    providerType: 'gemini',
    providerId: 'gemini',
    id: 'gemini/gemini-2.0-flash-lite',
    model: 'gemini-2.0-flash-lite',
    enable: false,
  },
  {
    providerType: 'deepseek',
    providerId: 'deepseek',
    id: 'deepseek/deepseek-chat',
    model: 'deepseek-chat',
    enable: false,
  },
  {
    providerType: 'deepseek',
    providerId: 'deepseek',
    id: 'deepseek/deepseek-reasoner',
    model: 'deepseek-reasoner',
    enable: false,
  },
]

export const DEFAULT_EMBEDDING_MODELS_V12: DefaultEmbeddingModelsV12 = [
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/text-embedding-3-small',
    model: 'text-embedding-3-small',
    dimension: 1536,
  },
  {
    providerType: 'openai',
    providerId: 'openai',
    id: 'openai/text-embedding-3-large',
    model: 'text-embedding-3-large',
    dimension: 3072,
  },
  {
    providerType: 'gemini',
    providerId: 'gemini',
    id: 'gemini/text-embedding-004',
    model: 'text-embedding-004',
    dimension: 768,
  },
]
