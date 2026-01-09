import OpenAI from 'openai'
import type { ReasoningEffort } from 'openai/resources'

import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestTool,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import { formatMessages } from '../../utils/llm/request'

import { BaseLLMProvider } from './base'
import { extractEmbeddingVector } from './embedding-utils'
import { LLMBaseUrlNotSetException } from './exception'
import { NoStainlessOpenAI } from './NoStainlessOpenAI'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'

type GeminiThinkingConfig = {
  thinking_budget: number
  include_thoughts: boolean
}

type OpenAICompatibleExtras = {
  thinking_config?: GeminiThinkingConfig
  thinkingConfig?: {
    thinkingBudget: number
    includeThoughts: boolean
  }
  reasoning?: {
    effort: string
  }
  extra_body?: Record<string, unknown>
}

type OpenAICompatibleRequest = LLMRequestNonStreaming &
  Record<string, unknown> &
  OpenAICompatibleExtras
type OpenAICompatibleStreamingRequest = LLMRequestStreaming &
  Record<string, unknown> &
  OpenAICompatibleExtras

export class OpenAICompatibleProvider extends BaseLLMProvider<
  Extract<LLMProvider, { type: 'openai-compatible' }>
> {
  private adapter: OpenAIMessageAdapter
  private client: OpenAI

  constructor(provider: Extract<LLMProvider, { type: 'openai-compatible' }>) {
    super(provider)
    this.adapter = new OpenAIMessageAdapter()
    // Prefer standard OpenAI SDK; allow opting into NoStainless to bypass headers/validation when needed
    this.client = new (
      provider.additionalSettings?.noStainless ? NoStainlessOpenAI : OpenAI
    )({
      apiKey: provider.apiKey ?? '',
      baseURL: provider.baseUrl ? provider.baseUrl?.replace(/\/+$/, '') : '',
      dangerouslyAllowBrowser: true,
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    if (model.providerType !== 'openai-compatible') {
      throw new Error('Model is not an OpenAI Compatible model')
    }

    if (!this.provider.baseUrl) {
      throw new LLMBaseUrlNotSetException(
        `Provider ${this.provider.id} base URL is missing. Please set it in settings menu.`,
      )
    }

    let formattedRequest: OpenAICompatibleRequest = {
      ...request,
      messages: formatMessages(request.messages),
    }

    // Handle Gemini tools for OpenAI-compatible gateways
    const geminiToolsSettings = options?.geminiTools
    if (model.toolType === 'gemini' && geminiToolsSettings) {
      const openaiTools: RequestTool[] = []

      if (geminiToolsSettings.useWebSearch) {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'googleSearch',
            description: 'Search the web using Google Search',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query',
                },
              },
            },
          },
        })
      }

      if (geminiToolsSettings.useUrlContext) {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'urlContext',
            description: 'Get context from a URL',
            parameters: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to get context from',
                },
              },
            },
          },
        })
      }

      if (openaiTools.length > 0) {
        formattedRequest.tools = openaiTools
      }
    }
    // If toolType is Gemini but no Gemini tools enabled, also ensure top-level tools are unset
    else if (model.toolType === 'gemini') {
      delete formattedRequest.tools
    }

    // Inject Gemini thinking config for OpenAI-compatible gateways if user selected Gemini reasoning
    if (model.thinking?.enabled) {
      const budget = model.thinking.thinking_budget
      // Use both snake_case and camelCase to maximize compatibility
      formattedRequest.thinking_config = {
        thinking_budget: budget,
        include_thoughts: true,
      }
      formattedRequest.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: true,
      }
    }
    // Inject OpenAI reasoning effort for compatible gateways if user enabled OpenAI reasoning
    if (model.reasoning?.enabled) {
      const effort = model.reasoning.reasoning_effort as
        | ReasoningEffort
        | undefined
      if (effort) {
        // Pass the flat field (widely supported by OpenAI-compatible proxies)
        formattedRequest.reasoning_effort = effort
        // Also add a nested object for gateways that prefer `reasoning: { effort }`
        formattedRequest.reasoning = { effort }
      }
    }
    formattedRequest = this.applyCustomModelParameters(model, formattedRequest)
    return this.adapter.generateResponse(this.client, formattedRequest, options)
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    if (model.providerType !== 'openai-compatible') {
      throw new Error('Model is not an OpenAI Compatible model')
    }

    if (!this.provider.baseUrl) {
      throw new LLMBaseUrlNotSetException(
        `Provider ${this.provider.id} base URL is missing. Please set it in settings menu.`,
      )
    }

    let formattedRequest: OpenAICompatibleStreamingRequest = {
      ...request,
      messages: formatMessages(request.messages),
    }

    // Handle Gemini tools for OpenAI-compatible gateways (streaming)
    const streamingGeminiTools = options?.geminiTools
    if (model.toolType === 'gemini' && streamingGeminiTools) {
      const openaiTools: RequestTool[] = []

      if (streamingGeminiTools.useWebSearch) {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'googleSearch',
            description: 'Search the web using Google Search',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query',
                },
              },
            },
          },
        })
      }

      if (streamingGeminiTools.useUrlContext) {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'urlContext',
            description: 'Get context from a URL',
            parameters: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to get context from',
                },
              },
            },
          },
        })
      }

      if (openaiTools.length > 0) {
        formattedRequest.tools = openaiTools
      }
    }
    if (model.toolType === 'gemini' && !options?.geminiTools) {
      // Ensure no top-level tools when Gemini tool type but none enabled
      delete formattedRequest.tools
    }

    if (model.thinking?.enabled) {
      const budget = model.thinking.thinking_budget
      formattedRequest.thinking_config = {
        thinking_budget: budget,
        include_thoughts: true,
      }
      formattedRequest.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: true,
      }
    }
    if (model.reasoning?.enabled) {
      const effort = model.reasoning.reasoning_effort as
        | ReasoningEffort
        | undefined
      if (effort) {
        formattedRequest.reasoning_effort = effort
        formattedRequest.reasoning = { effort }
      }
    }
    formattedRequest = this.applyCustomModelParameters(model, formattedRequest)
    return this.adapter.streamResponse(this.client, formattedRequest, options)
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
