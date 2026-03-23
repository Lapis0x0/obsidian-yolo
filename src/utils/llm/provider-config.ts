import { SmartComposerSettings } from '../../settings/schema/setting.types'
import { ChatModel } from '../../types/chat-model.types'
import { EmbeddingModel } from '../../types/embedding-model.types'
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'

export function getProviderById(
  settings: Pick<SmartComposerSettings, 'providers'>,
  providerId: string,
): LLMProvider | undefined {
  return settings.providers.find((provider) => provider.id === providerId)
}

export function resolveChatModelProvider(
  settings: Pick<SmartComposerSettings, 'providers'>,
  model: Pick<ChatModel, 'providerId'>,
): LLMProvider | undefined {
  return getProviderById(settings, model.providerId)
}

export function resolveEmbeddingModelProvider(
  settings: Pick<SmartComposerSettings, 'providers'>,
  model: Pick<EmbeddingModel, 'providerId'>,
): LLMProvider | undefined {
  return getProviderById(settings, model.providerId)
}

export function getRequestTransportModeValue(
  additionalSettings: Record<string, unknown> | undefined,
): RequestTransportMode {
  const mode = additionalSettings?.requestTransportMode
  if (
    mode === 'auto' ||
    mode === 'browser' ||
    mode === 'obsidian' ||
    mode === 'node'
  ) {
    return mode
  }

  if (additionalSettings?.useObsidianRequestUrl === true) {
    return 'obsidian'
  }

  if (additionalSettings?.useObsidianRequestUrl === false) {
    return 'browser'
  }

  return 'auto'
}

export function providerSupportsEmbedding(provider: LLMProvider): boolean {
  switch (provider.apiType) {
    case 'anthropic':
      return false
    case 'gemini':
      return true
    case 'openai-compatible':
    case 'openai-responses':
      return provider.presetType !== 'chatgpt-oauth'
  }
}

export function providerSupportsGeminiTools(provider: LLMProvider): boolean {
  return (
    provider.apiType === 'gemini' || provider.apiType === 'openai-compatible'
  )
}

export function isProviderOpenAIStyle(provider: LLMProvider): boolean {
  return (
    provider.apiType === 'openai-compatible' ||
    provider.apiType === 'openai-responses'
  )
}
