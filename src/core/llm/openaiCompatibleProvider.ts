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
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { resolveProviderBaseUrl } from '../../utils/llm/provider-base-url'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'
import { getHostedToolsForModel } from '../../utils/llm/model-tools'
import { formatMessages } from '../../utils/llm/request'

import { BaseLLMProvider } from './base'
import { extractEmbeddingVector } from './embedding-utils'
import { LLMBaseUrlNotSetException } from './exception'
import { NoStainlessOpenAI } from './NoStainlessOpenAI'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import { applyOpenAICompatibleCapabilities } from './openaiCompatibleCapabilities'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransportForStream,
  runWithRequestTransport,
} from './requestTransport'
import { createDesktopNodeFetch } from './sdkFetch'

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
  reasoning?: Record<string, unknown>
  extra_body?: Record<string, unknown>
}

type OpenAICompatibleRequest = LLMRequestNonStreaming &
  Record<string, unknown> &
  OpenAICompatibleExtras
type OpenAICompatibleStreamingRequest = LLMRequestStreaming &
  Record<string, unknown> &
  OpenAICompatibleExtras

export class OpenAICompatibleProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: OpenAIMessageAdapter
  private browserClient: OpenAI
  private obsidianClient: OpenAI
  private nodeClient: OpenAI
  private requestTransportMode: RequestTransportMode
  private requestTransportMemoryKey: string
  private onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void

  private promoteTransportMode = (mode: AutoPromotedTransportMode) => {
    if (this.requestTransportMode === mode) {
      return
    }

    this.provider.additionalSettings = {
      ...(this.provider.additionalSettings ?? {}),
      requestTransportMode: mode,
    }
    this.requestTransportMode = mode
    this.onAutoPromoteTransportMode?.(mode)
  }

  constructor(
    provider: LLMProvider,
    options?: {
      onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
    },
  ) {
    super(provider)
    this.onAutoPromoteTransportMode = options?.onAutoPromoteTransportMode
    this.adapter = new OpenAIMessageAdapter()
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.requestTransportMemoryKey = createRequestTransportMemoryKey({
      providerType: provider.presetType,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
    })
    this.requestTransportMode = resolveRequestTransportMode({
      additionalSettings: provider.additionalSettings,
      hasCustomBaseUrl: !!provider.baseUrl,
      memoryKey: this.requestTransportMemoryKey,
    })
    const ClientCtor = provider.additionalSettings?.noStainless
      ? NoStainlessOpenAI
      : OpenAI
    // Prefer standard OpenAI SDK; allow opting into NoStainless to bypass headers/validation when needed
    const clientOptions = {
      apiKey: provider.apiKey ?? '',
      baseURL: resolveProviderBaseUrl(provider) ?? '',
      dangerouslyAllowBrowser: true,
      maxRetries: this.requestTransportMode === 'auto' ? 0 : undefined,
      defaultHeaders,
    }
    this.browserClient = new ClientCtor(clientOptions)
    this.obsidianClient = new ClientCtor({
      ...clientOptions,
      fetch: createObsidianFetch(),
    })
    this.nodeClient = new ClientCtor({
      ...clientOptions,
      fetch: createDesktopNodeFetch(),
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
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
        formattedRequest.tools = [
          ...(formattedRequest.tools ?? []),
          ...openaiTools,
        ]
      }
    }

    const hostedTools = getHostedToolsForModel(model)
    if (hostedTools.length > 0) {
      formattedRequest.extra_body = {
        ...(formattedRequest.extra_body ?? {}),
        tools: hostedTools,
      }
    }

    applyOpenAICompatibleCapabilities({
      request: formattedRequest,
      model,
      baseUrl: this.provider.baseUrl,
    })

    // Keep explicit ReasoningEffort typing fallback for strongly OpenAI-like gateways.
    if (model.reasoning?.enabled && !formattedRequest.reasoning_effort) {
      const effort = model.reasoning.reasoning_effort as
        | ReasoningEffort
        | undefined
      if (effort) {
        formattedRequest.reasoning_effort = effort
      }
    }
    formattedRequest = this.applyCustomModelParameters(model, formattedRequest)
    return runWithRequestTransport({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      runBrowser: () =>
        this.adapter.generateResponse(
          this.browserClient,
          formattedRequest,
          options,
        ),
      runObsidian: () =>
        this.adapter.generateResponse(
          this.obsidianClient,
          formattedRequest,
          options,
        ),
      runNode: () =>
        this.adapter.generateResponse(this.nodeClient, formattedRequest, options),
    })
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
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
        formattedRequest.tools = [
          ...(formattedRequest.tools ?? []),
          ...openaiTools,
        ]
      }
    }

    const hostedTools = getHostedToolsForModel(model)
    if (hostedTools.length > 0) {
      formattedRequest.extra_body = {
        ...(formattedRequest.extra_body ?? {}),
        tools: hostedTools,
      }
    }

    applyOpenAICompatibleCapabilities({
      request: formattedRequest,
      model,
      baseUrl: this.provider.baseUrl,
    })

    if (model.reasoning?.enabled && !formattedRequest.reasoning_effort) {
      const effort = model.reasoning.reasoning_effort as
        | ReasoningEffort
        | undefined
      if (effort) {
        formattedRequest.reasoning_effort = effort
      }
    }
    formattedRequest = this.applyCustomModelParameters(model, formattedRequest)
    return runWithRequestTransportForStream({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      signal: options?.signal,
      createBrowserStream: (signal) =>
        this.adapter.streamResponse(
          this.browserClient,
          formattedRequest,
          { ...options, signal: signal ?? options?.signal },
        ),
      createObsidianStream: (signal) =>
        this.adapter.streamResponse(
          this.obsidianClient,
          formattedRequest,
          { ...options, signal: signal ?? options?.signal },
        ),
      createNodeStream: (signal) =>
        this.adapter.streamResponse(this.nodeClient, formattedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
    })
  }

  async getEmbedding(model: string, text: string): Promise<number[]> {
    const embedding = await runWithRequestTransport({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      runBrowser: () =>
        this.browserClient.embeddings.create({
          model: model,
          input: text,
          encoding_format: 'float',
        }),
      runObsidian: () =>
        this.obsidianClient.embeddings.create({
          model: model,
          input: text,
          encoding_format: 'float',
        }),
    })
    return extractEmbeddingVector(embedding)
  }
}
