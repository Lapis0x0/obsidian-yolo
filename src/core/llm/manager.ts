import { SmartComposerSettings } from '../../settings/schema/setting.types'
import { ChatModel } from '../../types/chat-model.types'
import { LLMProvider } from '../../types/provider.types'

import { AnthropicProvider } from './anthropic'
import { AzureOpenAIProvider } from './azureOpenaiProvider'
import { BaseLLMProvider } from './base'
import { BedrockProvider } from './bedrockProvider'
import { ChatGPTOAuthProvider } from './chatgptOAuthProvider'
import { DeepSeekStudioProvider } from './deepseekStudioProvider'
import { LLMModelNotFoundException } from './exception'
import { GeminiProvider } from './gemini'
import { GeminiOAuthProvider } from './geminiOAuthProvider'
import { GroqProvider } from './groq'
import { LmStudioProvider } from './lmStudioProvider'
import { MistralProvider } from './mistralProvider'
import { MoonshotProvider } from './moonshotProvider'
import { MorphProvider } from './morphProvider'
import { OllamaProvider } from './ollama'
import { OpenAICompatibleProvider } from './openaiCompatibleProvider'
import { OpenAIResponsesProvider } from './openaiResponsesProvider'
import { OpenRouterProvider } from './openRouterProvider'
import { PerplexityProvider } from './perplexityProvider'
import { QwenOAuthProvider } from './qwenOAuthProvider'
import { resolveModelRequestPolicy } from './requestPolicy'
import { AutoPromotedTransportMode } from './requestTransport'

/*
 * OpenAI, OpenAI-compatible, and Anthropic providers include token usage statistics
 * in the final chunk of the stream (following OpenAI's behavior).
 * Groq and Ollama currently do not support usage statistics for streaming responses.
 */

export function getProviderClient({
  settings,
  providerId,
  onAutoPromoteTransportMode,
}: {
  settings: SmartComposerSettings
  providerId: string
  onAutoPromoteTransportMode?: (
    providerId: string,
    mode: AutoPromotedTransportMode,
  ) => void
}): BaseLLMProvider<LLMProvider> {
  const provider = settings.providers.find((p) => p.id === providerId)
  if (!provider) {
    throw new Error(`Provider ${providerId} not found`)
  }

  const requestPolicy = resolveModelRequestPolicy(settings)

  switch (provider.apiType) {
    case 'openai-responses': {
      if (provider.presetType === 'chatgpt-oauth') {
        return new ChatGPTOAuthProvider(provider as never, { requestPolicy })
      }
      return new OpenAIResponsesProvider(provider, {
        requestPolicy,
        onAutoPromoteTransportMode: (mode) =>
          onAutoPromoteTransportMode?.(provider.id, mode),
      })
    }
    case 'anthropic': {
      return new AnthropicProvider(provider as never, {
        requestPolicy,
        onAutoPromoteTransportMode: (mode) =>
          onAutoPromoteTransportMode?.(provider.id, mode),
      })
    }
    case 'gemini': {
      if (provider.presetType === 'gemini-oauth') {
        return new GeminiOAuthProvider(provider as never, {
          requestPolicy,
        })
      }
      return new GeminiProvider(provider as never, { requestPolicy })
    }
    case 'amazon-bedrock': {
      // Base URL is constructed internally by the AWS SDK as
      // https://bedrock-runtime.{region}.amazonaws.com from the region config.
      return new BedrockProvider(provider, { requestPolicy })
    }
    case 'openai-compatible': {
      switch (provider.presetType) {
        case 'openrouter':
          return new OpenRouterProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'perplexity':
          return new PerplexityProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'groq':
          return new GroqProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'mistral':
          return new MistralProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'moonshot':
          return new MoonshotProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'qwen-oauth':
          return new QwenOAuthProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'ollama':
          return new OllamaProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'lm-studio':
          return new LmStudioProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'deepseek':
          return new DeepSeekStudioProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'morph':
          return new MorphProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        case 'azure-openai':
          return new AzureOpenAIProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
        default:
          return new OpenAICompatibleProvider(provider as never, {
            requestPolicy,
            onAutoPromoteTransportMode: (mode) =>
              onAutoPromoteTransportMode?.(provider.id, mode),
          })
      }
    }
  }
}

export function getChatModelClient({
  settings,
  modelId,
  onAutoPromoteTransportMode,
}: {
  settings: SmartComposerSettings
  modelId: string
  onAutoPromoteTransportMode?: (
    providerId: string,
    mode: AutoPromotedTransportMode,
  ) => void
}): {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
} {
  const chatModel = settings.chatModels.find((model) => model.id === modelId)
  if (!chatModel) {
    throw new LLMModelNotFoundException(`Chat model ${modelId} not found`)
  }

  const providerClient = getProviderClient({
    settings,
    providerId: chatModel.providerId,
    onAutoPromoteTransportMode,
  })

  return {
    providerClient,
    model: chatModel,
  }
}
