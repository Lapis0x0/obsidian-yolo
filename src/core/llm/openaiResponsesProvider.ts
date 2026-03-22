import OpenAI from 'openai'
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'

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
import { ChatGPTOAuthResponsesAdapter } from './chatgptOAuthResponsesAdapter'
import { extractEmbeddingVector } from './embedding-utils'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMRateLimitExceededException,
} from './exception'

export class OpenAIResponsesProvider extends BaseLLMProvider<LLMProvider> {
  private readonly adapter = new ChatGPTOAuthResponsesAdapter()
  private readonly client: OpenAI

  private applyReasoningEffort(
    model: ChatModel,
    request: LLMRequestNonStreaming,
  ): LLMRequestNonStreaming
  private applyReasoningEffort(
    model: ChatModel,
    request: LLMRequestStreaming,
  ): LLMRequestStreaming
  private applyReasoningEffort(
    model: ChatModel,
    request: LLMRequestNonStreaming | LLMRequestStreaming,
  ): LLMRequestNonStreaming | LLMRequestStreaming {
    const reasoningEffort = model.reasoning?.reasoning_effort
    if (
      !model.reasoning?.enabled ||
      request.reasoning_effort ||
      !reasoningEffort
    ) {
      return request
    }

    return {
      ...request,
      reasoning_effort: reasoningEffort as
        | LLMRequestNonStreaming['reasoning_effort']
        | LLMRequestStreaming['reasoning_effort'],
    }
  }

  constructor(provider: LLMProvider) {
    super(provider)
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.client = new OpenAI({
      apiKey: provider.apiKey ?? '',
      baseURL: provider.baseUrl
        ? provider.baseUrl.replace(/\/+$/, '')
        : undefined,
      dangerouslyAllowBrowser: true,
      defaultHeaders,
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    if (!this.client.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    try {
      const body = this.adapter.buildRequest(
        this.applyCustomModelParameters(model, {
          ...this.applyReasoningEffort(model, request),
          stream: false,
        }),
      ) as ResponseCreateParamsStreaming

      const response = (await this.client.responses.create(body as never, {
        signal: options?.signal,
      })) as Response
      return this.adapter.parseResponse(response)
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) {
        throw new LLMAPIKeyInvalidException(
          'OpenAI API key is invalid. Please update it in settings menu.',
          error,
        )
      }
      throw error
    }
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    if (!this.client.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    const body = this.adapter.buildRequest(
      this.applyCustomModelParameters(
        model,
        this.applyReasoningEffort(model, request),
      ),
    ) as ResponseCreateParamsStreaming

    const stream = (await this.client.responses.create(body, {
      signal: options?.signal,
    })) as AsyncIterable<ResponseStreamEvent>
    const adapter = this.adapter

    return {
      async *[Symbol.asyncIterator]() {
        const state = adapter.createStreamState()
        for await (const event of stream) {
          yield* adapter.parseStreamEvent(event, state)
        }
      },
    }
  }

  async getEmbedding(model: string, text: string): Promise<number[]> {
    if (!this.client.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    try {
      const embedding = await this.client.embeddings.create({
        model,
        input: text,
      })
      return extractEmbeddingVector(embedding)
    } catch (error) {
      if ((error as { status?: number }).status === 429) {
        throw new LLMRateLimitExceededException(
          'OpenAI API rate limit exceeded. Please try again later.',
        )
      }
      throw error
    }
  }
}
