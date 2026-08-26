import type { SettingMigration } from '../setting.types'

const MIMO_PROVIDER_ID = 'xiaomimimo'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v82 -> v83: Xiaomi MiMo stops being a default provider. It was seeded by
 * v54 -> v55 together with five default chat models, which left an unused
 * provider card and five entries in every model list for users who never
 * signed up for it.
 *
 * Only removed when the provider still has no API key — a key means the user
 * actually adopted it, and their models (default-seeded or hand-added) stay
 * untouched. The models are dropped alongside the provider so the model list
 * does not keep orphans; `parseYoloSettings` would drop them anyway, but
 * doing it here keeps the persisted file consistent.
 *
 * Gemini OAuth is dropped from `DEFAULT_PROVIDERS` in the same change but is
 * deliberately NOT cleaned up here: its credentials live in a file under the
 * plugin directory (`gemini-oauth/<providerId>.json`), so settings alone
 * cannot tell a logged-in user from an untouched card, and removing the
 * provider would strand a working login.
 */
export const migrateFrom82To83: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 83 }

  if (!Array.isArray(next.providers)) {
    return next
  }

  const mimoProvider = next.providers.find(
    (provider) => isRecord(provider) && provider.id === MIMO_PROVIDER_ID,
  )
  if (!mimoProvider || !isRecord(mimoProvider)) {
    return next
  }

  const apiKey = mimoProvider.apiKey
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return next
  }

  next.providers = next.providers.filter(
    (provider) => !(isRecord(provider) && provider.id === MIMO_PROVIDER_ID),
  )

  if (Array.isArray(next.chatModels)) {
    next.chatModels = next.chatModels.filter(
      (model) => !(isRecord(model) && model.providerId === MIMO_PROVIDER_ID),
    )
  }

  if (Array.isArray(next.embeddingModels)) {
    next.embeddingModels = next.embeddingModels.filter(
      (model) => !(isRecord(model) && model.providerId === MIMO_PROVIDER_ID),
    )
  }

  return next
}
