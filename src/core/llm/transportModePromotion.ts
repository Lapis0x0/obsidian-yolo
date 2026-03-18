import { Notice, getLanguage } from 'obsidian'

import { createTranslationFunction, type Language } from '../../i18n'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'

const resolveObsidianLanguage = (): Language => {
  const rawLanguage = String(getLanguage() ?? '')
    .trim()
    .toLowerCase()
  if (rawLanguage.startsWith('zh')) return 'zh'
  if (rawLanguage.startsWith('it')) return 'it'
  return 'en'
}

export const promoteProviderTransportModeToObsidian = async ({
  getSettings,
  setSettings,
  providerId,
}: {
  getSettings: () => SmartComposerSettings
  setSettings: (newSettings: SmartComposerSettings) => void | Promise<void>
  providerId: string
}): Promise<void> => {
  const settings = getSettings()
  const providerIndex = settings.providers.findIndex((p) => p.id === providerId)
  if (providerIndex < 0) {
    return
  }

  const provider = settings.providers[providerIndex]
  if (provider.type !== 'openai-compatible' && provider.type !== 'anthropic') {
    return
  }

  if (provider.additionalSettings?.requestTransportMode === 'obsidian') {
    return
  }

  const nextProvider = {
    ...provider,
    additionalSettings: {
      ...(provider.additionalSettings ?? {}),
      requestTransportMode: 'obsidian' as const,
    },
  }

  const nextProviders = [...settings.providers]
  nextProviders[providerIndex] = nextProvider

  await setSettings({
    ...settings,
    providers: nextProviders,
  })

  const t = createTranslationFunction(resolveObsidianLanguage())
  new Notice(t('notices.transportModeAutoPromoted'), 6000)
}
