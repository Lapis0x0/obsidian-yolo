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

export class MorphProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: OpenAIMessageAdapter
  private client: NoStainlessOpenAI

  constructor(provider: LLMProvider) {
    super(provider)
    this.adapter = new OpenAIMessageAdapter()
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.client = new NoStainlessOpenAI({
      baseURL: `${provider.baseUrl ? provider.baseUrl.replace(/\/+$/, '') : 'https://api.morphllm.com'}/v1`,
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

    let formattedRequest = {
      ...request,
      prediction: undefined, // morph doesn't support prediction
    }

    formattedRequest = this.applyCustomModelParameters(model, formattedRequest)

    return this.adapter.generateResponse(this.client, formattedRequest, options)
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {

    let formattedRequest = {
      ...request,
      prediction: undefined, // morph doesn't support prediction
    }

    formattedRequest = this.applyCustomModelParameters(model, formattedRequest)

    return this.adapter.streamResponse(this.client, formattedRequest, options)
  }

  getEmbedding(_model: string, _text: string): Promise<number[]> {
    return Promise.reject(
      new Error(
        `Provider ${this.provider.id} does not support embeddings. Please use a different provider.`,
      ),
    )
  }
}
