import { getDefaultApiTypeForPresetType } from '../../../types/provider.types'
import type { SettingMigration } from '../setting.types'

type LegacyProviderRecord = Record<string, unknown> & {
  id?: string
  type?: string
  presetType?: string
  apiType?: string
}

type LegacyModelRecord = Record<string, unknown>

export const migrateFrom37To38: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 38 }

  if (Array.isArray(next.providers)) {
    next.providers = next.providers.map((provider) => {
      const record = provider as LegacyProviderRecord
      const presetType =
        typeof record.presetType === 'string'
          ? record.presetType
          : typeof record.type === 'string'
            ? record.type
            : 'openai-compatible'

      const apiType =
        typeof record.apiType === 'string'
          ? record.apiType
          : getDefaultApiTypeForPresetType(
              presetType as Parameters<
                typeof getDefaultApiTypeForPresetType
              >[0],
            )

      const { type: _type, ...rest } = record
      return {
        ...rest,
        presetType,
        apiType,
      }
    })
  }

  const stripModelLegacyFields = (model: LegacyModelRecord) => {
    const { providerType: _providerType, ...rest } = model
    return rest
  }

  if (Array.isArray(next.chatModels)) {
    next.chatModels = next.chatModels.map((model) =>
      stripModelLegacyFields(model as LegacyModelRecord),
    )
  }

  if (Array.isArray(next.embeddingModels)) {
    next.embeddingModels = next.embeddingModels.map((model) =>
      stripModelLegacyFields(model as LegacyModelRecord),
    )
  }

  return next
}
