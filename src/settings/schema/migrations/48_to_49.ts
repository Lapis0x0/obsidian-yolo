import { resolveKnownChatModelModalities } from '../../../utils/llm/model-capability-registry'
import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type ApiType =
  | 'openai-compatible'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'amazon-bedrock'

// Fallback when the model ID is not in the capability registry. Duplicated
// from resolveDefaultChatModelModalities so the migration stays deterministic
// even if that helper's defaults shift later.
const modalitiesForApiType = (
  apiType: ApiType | undefined,
): Array<'text' | 'vision'> => {
  switch (apiType) {
    case 'anthropic':
    case 'amazon-bedrock':
    case 'gemini':
    case 'openai-responses':
      return ['text', 'vision']
    default:
      return ['text']
  }
}

export const migrateFrom48To49: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 49 }

  if (!Array.isArray(next.chatModels)) return next

  const providerApiTypeById = new Map<string, ApiType>()
  if (Array.isArray(next.providers)) {
    for (const entry of next.providers) {
      if (!isRecord(entry)) continue
      const id = typeof entry.id === 'string' ? entry.id : null
      const apiType =
        typeof entry.apiType === 'string'
          ? (entry.apiType as ApiType)
          : undefined
      if (id && apiType) providerApiTypeById.set(id, apiType)
    }
  }

  next.chatModels = next.chatModels.map((raw) => {
    if (!isRecord(raw)) return raw
    if (Array.isArray(raw.modalities) && raw.modalities.length > 0) return raw

    const modelId = typeof raw.model === 'string' ? raw.model : undefined
    const known = resolveKnownChatModelModalities(modelId)
    if (known) return { ...raw, modalities: known }

    const providerId =
      typeof raw.providerId === 'string' ? raw.providerId : null
    const apiType = providerId
      ? providerApiTypeById.get(providerId)
      : undefined
    return { ...raw, modalities: modalitiesForApiType(apiType) }
  })

  return next
}
