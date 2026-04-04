import { DEFAULT_CHAT_MODELS, DEFAULT_PROVIDERS } from '../../../constants'
import type { SettingMigration } from '../setting.types'

const DEFAULT_QWEN_OAUTH_PROVIDER = DEFAULT_PROVIDERS.find(
  (provider) => provider.presetType === 'qwen-oauth',
)

const DEFAULT_QWEN_OAUTH_MODELS = DEFAULT_CHAT_MODELS.filter((model) =>
  model.providerId.startsWith('qwen-oauth'),
)

export const migrateFrom41To42: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 42 }

  if (DEFAULT_QWEN_OAUTH_PROVIDER && Array.isArray(next.providers)) {
    const providers = next.providers as Array<{ id: string }>
    const exists = providers.some((provider) => provider.id === 'qwen-oauth')
    if (!exists) {
      next.providers = [...providers, DEFAULT_QWEN_OAUTH_PROVIDER]
    }
  }

  if (DEFAULT_QWEN_OAUTH_MODELS.length > 0 && Array.isArray(next.chatModels)) {
    const models = next.chatModels as Array<
      { id: string } & Record<string, unknown>
    >
    const existingIds = new Set(models.map((model) => model.id))
    next.chatModels = [
      ...models,
      ...DEFAULT_QWEN_OAUTH_MODELS.filter(
        (model) => !existingIds.has(model.id),
      ),
    ]
  }

  return next
}
