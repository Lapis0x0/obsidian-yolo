import { YoloSettings } from '../../settings/schema/setting.types'
import { ChatModel } from '../../types/chat-model.types'
import { EmbeddingModel } from '../../types/embedding-model.types'
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'

import { isBedrockMantleProvider, isNativeBedrockProvider } from './bedrock'

export function getProviderById(
  settings: Pick<YoloSettings, 'providers'>,
  providerId: string,
): LLMProvider | undefined {
  return settings.providers.find((provider) => provider.id === providerId)
}

export function resolveChatModelProvider(
  settings: Pick<YoloSettings, 'providers'>,
  model: Pick<ChatModel, 'providerId'>,
): LLMProvider | undefined {
  return getProviderById(settings, model.providerId)
}

export function resolveEmbeddingModelProvider(
  settings: Pick<YoloSettings, 'providers'>,
  model: Pick<EmbeddingModel, 'providerId'>,
): LLMProvider | undefined {
  return getProviderById(settings, model.providerId)
}

export function getRequestTransportModeValue(
  additionalSettings: Record<string, unknown> | undefined,
  isDesktop: boolean,
): RequestTransportMode {
  const mode = additionalSettings?.requestTransportMode
  if (mode && typeof mode === 'object') {
    const byPlatform = mode as Record<string, unknown>
    const platformMode = isDesktop ? byPlatform.desktop : byPlatform.mobile
    if (
      platformMode === 'browser' ||
      platformMode === 'obsidian' ||
      (isDesktop && platformMode === 'node')
    ) {
      return platformMode
    }
  }

  if (mode === 'browser' || mode === 'obsidian') {
    return mode
  }

  if (mode === 'node') {
    return isDesktop ? 'node' : 'browser'
  }

  if (additionalSettings?.useObsidianRequestUrl === true) {
    return 'obsidian'
  }

  if (additionalSettings?.useObsidianRequestUrl === false) {
    return 'browser'
  }

  return isDesktop ? 'node' : 'browser'
}

export function providerSupportsEmbedding(provider: LLMProvider): boolean {
  if (isNativeBedrockProvider(provider)) {
    return true
  }

  switch (provider.apiType) {
    case 'anthropic':
      return false
    case 'amazon-bedrock':
      return false
    case 'gemini':
      return provider.presetType !== 'gemini-oauth'
    case 'openai-compatible':
      return (
        provider.presetType !== 'chatgpt-oauth' &&
        provider.presetType !== 'qwen-oauth' &&
        !isBedrockMantleProvider(provider)
      )
    case 'openai-responses':
      return provider.presetType !== 'chatgpt-oauth'
  }
}

export function reconcileEmbeddingModelsForProviderUpdate({
  embeddingModels,
  previousProvider,
  nextProvider,
}: {
  embeddingModels: EmbeddingModel[]
  previousProvider: Pick<LLMProvider, 'id'>
  nextProvider: LLMProvider
}): EmbeddingModel[] {
  if (!providerSupportsEmbedding(nextProvider)) {
    return embeddingModels.filter(
      (model) => model.providerId !== previousProvider.id,
    )
  }

  if (previousProvider.id === nextProvider.id) {
    return embeddingModels
  }

  return embeddingModels.map((model) => {
    if (model.providerId !== previousProvider.id) {
      return model
    }

    return {
      ...model,
      providerId: nextProvider.id,
    }
  })
}

export function providerSupportsTransportModeSelection(
  provider: Pick<LLMProvider, 'presetType' | 'apiType'>,
): boolean {
  return !isNativeBedrockProvider(provider as LLMProvider)
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
