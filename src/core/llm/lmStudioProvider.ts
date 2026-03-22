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
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'

import { BaseLLMProvider } from './base'
import { extractEmbeddingVector } from './embedding-utils'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'

export class LmStudioProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: OpenAIMessageAdapter
  private client: OpenAI

  constructor(provider: LLMProvider) {
    super(provider)
    this.adapter = new OpenAIMessageAdapter()
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.client = new OpenAI({
      apiKey: provider.apiKey ?? '',
      baseURL: `${provider.baseUrl ? provider.baseUrl.replace(/\/+$/, '') : 'http://127.0.0.1:1234'}/v1`,
      dangerouslyAllowBrowser: true,
      defaultHeaders,
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {

    const mergedRequest = this.applyCustomModelParameters(model, request)

    return this.adapter.generateResponse(this.client, mergedRequest, options)
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {

    const mergedRequest = this.applyCustomModelParameters(model, request)

    return this.adapter.streamResponse(this.client, mergedRequest, options)
  }

  async getEmbedding(model: string, text: string): Promise<number[]> {
    const embedding = await this.client.embeddings.create({
      model: model,
      input: text,
      encoding_format: 'float',
    })
    return extractEmbeddingVector(embedding)
  }
}
