import { Notice, getLanguage } from 'obsidian'

import {
  createTranslationFunction,
  resolveLanguageFromLocale,
} from '../../i18n'
import type { YoloSettings } from '../../settings/schema/setting.types'

import type { AutoPromotedTransportMode } from './requestTransport'

const resolveObsidianLanguage = () => resolveLanguageFromLocale(getLanguage())

export const promoteProviderTransportModeToObsidian = async ({
  getSettings,
  setSettings,
  providerId,
  mode,
}: {
  getSettings: () => YoloSettings
  setSettings: (newSettings: YoloSettings) => Promise<boolean>
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
      : mode === 'browser'
        ? t('settings.providers.requestTransportModeBrowser')
        : t('settings.providers.requestTransportModeObsidian')
  new Notice(
    t('notices.transportModeAutoPromoted').replace('{mode}', modeLabel),
    6000,
  )
}
