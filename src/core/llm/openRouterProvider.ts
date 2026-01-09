import OpenAI from 'openai'

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
import { extractEmbeddingVector } from './embedding-utils'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'

export class OpenRouterProvider extends BaseLLMProvider<
  Extract<LLMProvider, { type: 'openrouter' }>
> {
  private adapter: OpenAIMessageAdapter
  private client: OpenAI

  constructor(provider: Extract<LLMProvider, { type: 'openrouter' }>) {
    super(provider)
    this.adapter = new OpenAIMessageAdapter()
    this.client = new OpenAI({
      apiKey: provider.apiKey ?? '',
      baseURL: provider.baseUrl
        ? provider.baseUrl?.replace(/\/+$/, '')
        : 'https://openrouter.ai/api/v1',
      dangerouslyAllowBrowser: true,
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    if (model.providerType !== 'openrouter') {
      throw new Error('Model is not an OpenRouter model')
    }

    const mergedRequest = this.applyCustomModelParameters(model, request)

    return this.adapter.generateResponse(this.client, mergedRequest, options)
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    if (model.providerType !== 'openrouter') {
      throw new Error('Model is not an OpenRouter model')
    }

    const mergedRequest = this.applyCustomModelParameters(model, request)

    return this.adapter.streamResponse(this.client, mergedRequest, options)
  }

  async getEmbedding(model: string, text: string): Promise<number[]> {
    try {
      const embedding = await this.client.embeddings.create({
        model: model,
        input: text,
      })
      return extractEmbeddingVector(embedding)
    } catch (error) {
      throw new Error(
        `Failed to get embedding from OpenRouter: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }
}
