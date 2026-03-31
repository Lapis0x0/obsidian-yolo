import { SmartComposerSettings } from '../../settings/schema/setting.types'
import { ChatModel } from '../../types/chat-model.types'
import { EmbeddingModel } from '../../types/embedding-model.types'
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'

import { isBedrockMantleProvider, isNativeBedrockProvider } from './bedrock'

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
