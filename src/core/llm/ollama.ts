/**
 * This provider is nearly identical to OpenAICompatibleProvider, but uses a custom OpenAI client
 * (NoStainlessOpenAI) to work around CORS issues specific to Ollama.
 */

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
import { NoStainlessOpenAI } from './NoStainlessOpenAI'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'

export class OllamaProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: OpenAIMessageAdapter
  private client: NoStainlessOpenAI

  constructor(provider: LLMProvider) {
    super(provider)
    this.adapter = new OpenAIMessageAdapter()
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.client = new NoStainlessOpenAI({
      baseURL: `${provider.baseUrl ? provider.baseUrl.replace(/\/+$/, '') : 'http://127.0.0.1:11434'}/v1`,
      apiKey: provider.apiKey ?? '',
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
    return embedding.data[0].embedding
  }
}
