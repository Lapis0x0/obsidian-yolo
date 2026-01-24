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
import { detectReasoningTypeFromModelId } from '../../utils/model-id-utils'

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

    const mergedRequest = this.applyCustomModelParameters(
      model,
      this.applyReasoningConfig(model, request),
    )

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

    const mergedRequest = this.applyCustomModelParameters(
      model,
      this.applyReasoningConfig(model, request),
    )

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

  private applyReasoningConfig<
    RequestType extends LLMRequestNonStreaming | LLMRequestStreaming,
  >(model: ChatModel, request: RequestType): RequestType {
    const formattedRequest = { ...request } as RequestType &
      Record<string, unknown>

    const resolveReasoningType = () => {
      if (model.reasoningType && model.reasoningType !== 'none') {
        return model.reasoningType
      }
      const detected = detectReasoningTypeFromModelId(model.model)
      return detected === 'none' ? null : detected
    }

    const reasoningType = resolveReasoningType()
    const thinkingModel = model as ChatModel & {
      thinking?: {
        enabled?: boolean
        thinking_budget?: number
        budget_tokens?: number
      }
    }
    const reasoningModel = model as ChatModel & {
      reasoning?: { enabled?: boolean; reasoning_effort?: string }
    }

    const budget =
      thinkingModel.thinking?.thinking_budget ??
      thinkingModel.thinking?.budget_tokens

    if (reasoningType === 'openai' && reasoningModel.reasoning) {
      if (reasoningModel.reasoning.enabled === false) {
        formattedRequest.reasoning = { effort: 'none', exclude: true }
      } else {
        const effort = reasoningModel.reasoning.reasoning_effort as
          | 'low'
          | 'medium'
          | 'high'
          | undefined
        if (effort) {
          formattedRequest.reasoning = { effort }
        } else if (reasoningModel.reasoning.enabled) {
          formattedRequest.reasoning = { enabled: true }
        }
      }
    }

    if (reasoningType !== 'openai' && thinkingModel.thinking) {
      if (thinkingModel.thinking.enabled === false) {
        formattedRequest.reasoning = { max_tokens: 0, exclude: true }
      } else if (budget === -1) {
        formattedRequest.reasoning = { enabled: true }
      } else if (typeof budget === 'number') {
        if (budget <= 0) {
          formattedRequest.reasoning = { max_tokens: 0, exclude: true }
        } else {
          formattedRequest.reasoning = { max_tokens: budget }
        }
      }
    }

    if (!reasoningType && reasoningModel.reasoning) {
      if (reasoningModel.reasoning.enabled === false) {
        formattedRequest.reasoning = { effort: 'none', exclude: true }
      } else if (reasoningModel.reasoning.reasoning_effort) {
        formattedRequest.reasoning = {
          effort: reasoningModel.reasoning.reasoning_effort,
        }
      }
    }

    return formattedRequest as RequestType
  }
}
