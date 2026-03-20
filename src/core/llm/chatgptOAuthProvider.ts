import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'

import { BaseLLMProvider } from './base'
import { LLMProviderNotConfiguredException } from './exception'

export class ChatGPTOAuthProvider extends BaseLLMProvider<
  Extract<LLMProvider, { type: 'chatgpt-oauth' }>
> {
  constructor(provider: Extract<LLMProvider, { type: 'chatgpt-oauth' }>) {
    super(provider)
  }

  async generateResponse(
    model: ChatModel,
    _request: LLMRequestNonStreaming,
    _options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    if (model.providerType !== 'chatgpt-oauth') {
      throw new Error('Model is not a ChatGPT OAuth model')
    }

    throw new LLMProviderNotConfiguredException(
      'ChatGPT OAuth provider is not configured yet. Please log in from settings after setup is implemented.',
    )
  }

  async streamResponse(
    model: ChatModel,
    _request: LLMRequestStreaming,
    _options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    if (model.providerType !== 'chatgpt-oauth') {
      throw new Error('Model is not a ChatGPT OAuth model')
    }

    throw new LLMProviderNotConfiguredException(
      'ChatGPT OAuth provider is not configured yet. Please log in from settings after setup is implemented.',
    )
  }

  async getEmbedding(_model: string, _text: string): Promise<number[]> {
    throw new LLMProviderNotConfiguredException(
      'ChatGPT OAuth provider does not support embeddings.',
    )
  }
}
