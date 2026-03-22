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
import { MistralMessageAdapter } from './mistralMessageAdapter'
import { NoStainlessOpenAI } from './NoStainlessOpenAI'

export class MistralProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: MistralMessageAdapter
  private client: NoStainlessOpenAI

  constructor(provider: LLMProvider) {
    super(provider)
    this.adapter = new MistralMessageAdapter()
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.client = new NoStainlessOpenAI({
      apiKey: provider.apiKey ?? '',
      baseURL: provider.baseUrl
        ? provider.baseUrl.replace(/\/+$/, '')
        : 'https://api.mistral.ai/v1',
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

  getEmbedding(_model: string, _text: string): Promise<number[]> {
    return Promise.reject(
      new Error(
        `Provider ${this.provider.id} does not support embeddings. Please use a different provider.`,
      ),
    )
  }
}
