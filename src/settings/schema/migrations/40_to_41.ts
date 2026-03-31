import { DEFAULT_CHAT_MODELS, DEFAULT_PROVIDERS } from '../../../constants'
import type { SettingMigration } from '../setting.types'

const DEFAULT_GEMINI_OAUTH_PROVIDER = DEFAULT_PROVIDERS.find(
  (provider) => provider.presetType === 'gemini-oauth',
)

const DEFAULT_GEMINI_OAUTH_MODELS = DEFAULT_CHAT_MODELS.filter((model) =>
  model.providerId.startsWith('gemini-oauth'),
)

export const migrateFrom40To41: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 41 }

  if (DEFAULT_GEMINI_OAUTH_PROVIDER && Array.isArray(next.providers)) {
    const providers = next.providers as Array<{ id: string }>
    const exists = providers.some((provider) => provider.id === 'gemini-oauth')
    if (!exists) {
      next.providers = [...providers, DEFAULT_GEMINI_OAUTH_PROVIDER]
    }
  }

  if (
    DEFAULT_GEMINI_OAUTH_MODELS.length > 0 &&
    Array.isArray(next.chatModels)
  ) {
    const models = next.chatModels as Array<
      { id: string } & Record<string, unknown>
    >
    const existingIds = new Set(models.map((model) => model.id))
    next.chatModels = [
      ...models,
      ...DEFAULT_GEMINI_OAUTH_MODELS.filter(
        (model) => !existingIds.has(model.id),
      ),
    ]
  }

  return next
}
