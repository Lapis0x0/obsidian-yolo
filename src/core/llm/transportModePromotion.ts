import { Notice, getLanguage } from 'obsidian'

import { type Language, createTranslationFunction } from '../../i18n'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'

import type { AutoPromotedTransportMode } from './requestTransport'

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
  mode,
}: {
  getSettings: () => SmartComposerSettings
  setSettings: (newSettings: SmartComposerSettings) => void | Promise<void>
  providerId: string
  mode: AutoPromotedTransportMode
}): Promise<void> => {
  const settings = getSettings()
  const providerIndex = settings.providers.findIndex((p) => p.id === providerId)
  if (providerIndex < 0) {
    return
  }

  const provider = settings.providers[providerIndex]
  if (
    provider.apiType !== 'openai-compatible' &&
    provider.apiType !== 'anthropic'
  ) {
    return
  }

  if (provider.additionalSettings?.requestTransportMode === mode) {
    return
  }

  const nextProvider = {
    ...provider,
    additionalSettings: {
      ...(provider.additionalSettings ?? {}),
      requestTransportMode: mode,
    },
  }

  const nextProviders = [...settings.providers]
  nextProviders[providerIndex] = nextProvider

  await setSettings({
    ...settings,
    providers: nextProviders,
  })

  const t = createTranslationFunction(resolveObsidianLanguage())
  const modeLabel =
    mode === 'node'
      ? t('settings.providers.requestTransportModeNode')
      : t('settings.providers.requestTransportModeObsidian')
  new Notice(
    t('notices.transportModeAutoPromoted').replace('{mode}', modeLabel),
    6000,
  )
}
