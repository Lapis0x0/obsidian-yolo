import type { SettingMigration } from '../setting.types'

const migrateProviderAdditionalSettings = (
  provider: Record<string, unknown>,
): Record<string, unknown> => {
  const additionalSettingsRaw = provider.additionalSettings
  if (
    !additionalSettingsRaw ||
    typeof additionalSettingsRaw !== 'object' ||
    Array.isArray(additionalSettingsRaw)
  ) {
    return provider
  }

  const additionalSettings = additionalSettingsRaw as Record<string, unknown>
  if (typeof additionalSettings.requestTransportMode === 'string') {
    return provider
  }

  const legacy = additionalSettings.useObsidianRequestUrl
  if (typeof legacy !== 'boolean') {
    return provider
  }

  return {
    ...provider,
    additionalSettings: {
      ...additionalSettings,
      requestTransportMode: legacy ? 'obsidian' : 'browser',
    },
  }
}

export const migrateFrom35To36: SettingMigration['migrate'] = (data) => {
  const newData: Record<string, unknown> = { ...data, version: 36 }

  if (!Array.isArray(newData.providers)) {
    return newData
  }

  newData.providers = newData.providers.map((provider) => {
    if (!provider || typeof provider !== 'object') {
      return provider
    }

    const providerRecord = provider as Record<string, unknown>
    const providerType = providerRecord.type
    if (providerType !== 'anthropic' && providerType !== 'openai-compatible') {
      return providerRecord
    }

    return migrateProviderAdditionalSettings(providerRecord)
  })

  return newData
}
