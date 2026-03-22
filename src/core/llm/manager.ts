import { SmartComposerSettings } from '../../settings/schema/setting.types'
import { ChatModel } from '../../types/chat-model.types'
import { LLMProvider } from '../../types/provider.types'

import { AnthropicProvider } from './anthropic'
import { AzureOpenAIProvider } from './azureOpenaiProvider'
import { BaseLLMProvider } from './base'
import { ChatGPTOAuthProvider } from './chatgptOAuthProvider'
import { DeepSeekStudioProvider } from './deepseekStudioProvider'
import { LLMModelNotFoundException } from './exception'
import { GeminiProvider } from './gemini'
import { GroqProvider } from './groq'
import { LmStudioProvider } from './lmStudioProvider'
import { MistralProvider } from './mistralProvider'
import { MorphProvider } from './morphProvider'
import { OllamaProvider } from './ollama'
import { OpenAICompatibleProvider } from './openaiCompatibleProvider'
import { OpenAIResponsesProvider } from './openaiResponsesProvider'
import { OpenRouterProvider } from './openRouterProvider'
import { PerplexityProvider } from './perplexityProvider'

/*
 * OpenAI, OpenAI-compatible, and Anthropic providers include token usage statistics
 * in the final chunk of the stream (following OpenAI's behavior).
 * Groq and Ollama currently do not support usage statistics for streaming responses.
 */

export function getProviderClient({
  settings,
  providerId,
  onAutoPromoteToObsidian,
}: {
  settings: SmartComposerSettings
  providerId: string
  onAutoPromoteToObsidian?: (providerId: string) => void
}): BaseLLMProvider<LLMProvider> {
  const provider = settings.providers.find((p) => p.id === providerId)
  if (!provider) {
    throw new Error(`Provider ${providerId} not found`)
  }

  switch (provider.apiType) {
    case 'openai-responses': {
      if (provider.presetType === 'chatgpt-oauth') {
        return new ChatGPTOAuthProvider(provider as never)
      }
      return new OpenAIResponsesProvider(provider)
    }
    case 'anthropic': {
      return new AnthropicProvider(provider as never, {
        onAutoPromoteToObsidian: () => onAutoPromoteToObsidian?.(provider.id),
      })
    }
    case 'gemini': {
      return new GeminiProvider(provider as never)
    }
    case 'openai-compatible': {
      switch (provider.presetType) {
        case 'openrouter':
          return new OpenRouterProvider(provider as never)
        case 'perplexity':
          return new PerplexityProvider(provider as never)
        case 'groq':
          return new GroqProvider(provider as never)
        case 'mistral':
          return new MistralProvider(provider as never)
        case 'ollama':
          return new OllamaProvider(provider as never)
        case 'lm-studio':
          return new LmStudioProvider(provider as never)
        case 'deepseek':
          return new DeepSeekStudioProvider(provider as never)
        case 'morph':
          return new MorphProvider(provider as never)
        case 'azure-openai':
          return new AzureOpenAIProvider(provider as never)
        default:
          return new OpenAICompatibleProvider(provider as never, {
            onAutoPromoteToObsidian: () =>
              onAutoPromoteToObsidian?.(provider.id),
          })
      }
    }
  }
}

export function getChatModelClient({
  settings,
  modelId,
  onAutoPromoteToObsidian,
}: {
  settings: SmartComposerSettings
  modelId: string
  onAutoPromoteToObsidian?: (providerId: string) => void
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
    onAutoPromoteToObsidian,
  })

  return {
    providerClient,
    model: chatModel,
  }
}
