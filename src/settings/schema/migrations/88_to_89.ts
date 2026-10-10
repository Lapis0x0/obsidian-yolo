import type { SettingMigration } from '../setting.types'

// The URL the APIMart preset filled in when the user left Base URL empty.
const APIMART_BASE_URL = 'https://api.apimart.ai/v1'

/**
 * v88→v89:
 *
 * - The APIMart preset goes away with its sponsorship. A provider added from
 *   it becomes a custom OpenAI-compatible provider, and one that relied on the
 *   preset's default Base URL gets that URL written in, so it keeps working.
 */
export const migrateFrom88To89: SettingMigration['migrate'] = (data) => ({
  ...data,
  version: 89,
  ...(Array.isArray(data.providers)
    ? { providers: data.providers.map(migrateApimartProvider) }
    : {}),
})

const migrateApimartProvider = (provider: unknown): unknown => {
  if (!isRecord(provider) || provider.presetType !== 'apimart') {
    return provider
  }
  const baseUrl =
    typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : ''
  return {
    ...provider,
    presetType: 'openai-compatible',
    baseUrl: baseUrl || APIMART_BASE_URL,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
