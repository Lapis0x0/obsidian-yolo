import { YoloSettings } from '../../settings/schema/setting.types'
import { ChatModel } from '../../types/chat-model.types'
import { EmbeddingModel } from '../../types/embedding-model.types'
import {
  LLMProvider,
  RequestTransportMode,
  ResponseStreamingMode,
} from '../../types/provider.types'

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

export function getResponseStreamingMode(
  additionalSettings: Record<string, unknown> | undefined,
): ResponseStreamingMode {
  const mode = additionalSettings?.responseStreamingMode
  if (mode === 'auto' || mode === 'streaming' || mode === 'non-streaming') {
    return mode
  }

  return 'auto'
}

/**
 * True for providers that keep the conversation's transcript inside their own
 * runtime and compact it themselves.
 *
 * YOLO's own context management — the auto-compaction prompt and the
 * `context_compact` tool it asks the model to call — has nothing to act on for
 * these: the messages it would compact are YOLO's copy, while the context that
 * actually fills up lives in the provider's session. Worse, the prompt asks
 * for a tool the provider's own agent loop never sees, so it would be an
 * instruction that can only be ignored.
 */
export function providerOwnsConversationContext(
  provider: Pick<LLMProvider, 'presetType'>,
): boolean {
  return provider.presetType === 'claude-oauth'
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

/**
 * Prompt caching is a property of the Anthropic request YOLO builds itself: the
 * toggle only decides whether `cache_control` breakpoints get attached to the
 * system prompt, tool list and history it sends. Providers served by the Claude
 * Agent SDK never get such a payload — caching there is decided inside the
 * SDK's own agent loop — so the toggle would have nothing to act on.
 */
export function providerSupportsPromptCaching(
  provider: Pick<LLMProvider, 'presetType' | 'apiType'>,
): boolean {
  return (
    provider.apiType === 'anthropic' && provider.presetType !== 'claude-oauth'
  )
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
