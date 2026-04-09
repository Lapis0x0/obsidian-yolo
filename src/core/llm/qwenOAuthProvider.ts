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
import { getHostedToolsForModel } from '../../utils/llm/model-tools'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'
import { formatMessages } from '../../utils/llm/request'
import { getQwenOAuthService } from '../auth/qwenOAuthRuntime'

import { BaseLLMProvider } from './base'
import { LLMProviderNotConfiguredException } from './exception'
import { NoStainlessOpenAI } from './NoStainlessOpenAI'
import { applyOpenAICompatibleCapabilities } from './openaiCompatibleCapabilities'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import { QwenOAuthMessageAdapter } from './qwenOAuthMessageAdapter'
import { ModelRequestPolicy, resolveSdkMaxRetries } from './requestPolicy'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
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

type QwenOAuthRequest = LLMRequestNonStreaming &
  Record<string, unknown> &
  OpenAICompatibleExtras
type QwenOAuthStreamingRequest = LLMRequestStreaming &
  Record<string, unknown> &
  OpenAICompatibleExtras

const DEFAULT_QWEN_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1'
const OAUTH_PROVIDER_API_KEY = 'qwen-oauth'
const DEFAULT_QWEN_USER_AGENT = 'obsidian-yolo/qwen-oauth'
const DEFAULT_QWEN_DASHSCOPE_USER_AGENT = 'QwenCode/obsidian-yolo'

export class QwenOAuthProvider extends BaseLLMProvider<LLMProvider> {
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
      adapter?: OpenAIMessageAdapter
      onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
      requestPolicy?: ModelRequestPolicy
    },
  ) {
    super(provider)
    this.onAutoPromoteTransportMode = options?.onAutoPromoteTransportMode
    this.adapter = options?.adapter ?? new QwenOAuthMessageAdapter()
    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    this.requestTransportMemoryKey = createRequestTransportMemoryKey({
      providerType: provider.presetType,
      providerId: provider.id,
      baseUrl: DEFAULT_QWEN_BASE_URL,
    })
    this.requestTransportMode = resolveRequestTransportMode({
      additionalSettings: provider.additionalSettings,
      hasCustomBaseUrl: true,
      memoryKey: this.requestTransportMemoryKey,
    })
    const ClientCtor = provider.additionalSettings?.noStainless
      ? NoStainlessOpenAI
      : OpenAI
    const clientOptions = {
      apiKey: OAUTH_PROVIDER_API_KEY,
      baseURL: DEFAULT_QWEN_BASE_URL,
      dangerouslyAllowBrowser: true,
      maxRetries: resolveSdkMaxRetries({
        requestPolicy: options?.requestPolicy,
        requestTransportMode: this.requestTransportMode,
      }),
      timeout: options?.requestPolicy?.timeoutMs,
      defaultHeaders,
    }

    this.browserClient = new ClientCtor({
      ...clientOptions,
      fetch: this.createAuthorizedFetch(globalThis.fetch),
    })
    this.obsidianClient = new ClientCtor({
      ...clientOptions,
      fetch: this.createAuthorizedFetch(createObsidianFetch()),
    })
    this.nodeClient = new ClientCtor({
      ...clientOptions,
      fetch: this.createAuthorizedFetch(createDesktopNodeFetch()),
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    let formattedRequest: QwenOAuthRequest = {
      ...request,
      messages: formatMessages(request.messages),
    }

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
      baseUrl: DEFAULT_QWEN_BASE_URL,
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
        this.adapter.generateResponse(
          this.nodeClient,
          formattedRequest,
          options,
        ),
    })
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    let formattedRequest: QwenOAuthStreamingRequest = {
      ...request,
      messages: formatMessages(request.messages),
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
      baseUrl: DEFAULT_QWEN_BASE_URL,
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
      createBrowserStream: async (signal) =>
        this.adapter.streamResponse(this.browserClient, formattedRequest, {
          ...options,
          signal,
        }),
      createObsidianStream: async (signal) =>
        this.adapter.streamResponse(this.obsidianClient, formattedRequest, {
          ...options,
          signal,
        }),
      createNodeStream: async (signal) =>
        this.adapter.streamResponse(this.nodeClient, formattedRequest, {
          ...options,
          signal,
        }),
    })
  }

  async getEmbedding(_model: string, _text: string): Promise<number[]> {
    throw new LLMProviderNotConfiguredException(
      'Qwen OAuth provider does not support embeddings.',
    )
  }

  private createAuthorizedFetch(baseFetch: typeof fetch): typeof fetch {
    return async (input, init) => {
      const service = getQwenOAuthService(this.provider.id)
      if (!service) {
        throw new LLMProviderNotConfiguredException(
          'Qwen OAuth service is not initialized.',
        )
      }

      const credential = await service.getUsableCredential()
      if (!credential) {
        throw new LLMProviderNotConfiguredException(
          'Qwen OAuth is not logged in. Please connect your account in settings.',
        )
      }

      const target = this.rewriteUrl(input, credential.resourceUrl)
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      headers.set('Authorization', `Bearer ${credential.accessToken}`)
      headers.set('User-Agent', DEFAULT_QWEN_USER_AGENT)
      headers.set('X-DashScope-CacheControl', 'enable')
      // Qwen OAuth validates this header against the Qwen Code client format.
      headers.set('X-DashScope-UserAgent', DEFAULT_QWEN_DASHSCOPE_USER_AGENT)
      headers.set('X-DashScope-AuthType', 'qwen-oauth')

      const response = await baseFetch(target, {
        ...init,
        headers,
      })

      return response
    }
  }

  private rewriteUrl(input: RequestInfo | URL, resourceUrl: string): string {
    const incoming =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : input
    const source = new URL(incoming)
    const targetBase = this.normalizeEndpoint(resourceUrl)
    const defaultBasePath = new URL(DEFAULT_QWEN_BASE_URL).pathname.replace(
      /\/+$/,
      '',
    )
    const sourcePath = source.pathname.startsWith(defaultBasePath)
      ? source.pathname.slice(defaultBasePath.length) || '/'
      : source.pathname.replace(/^\/v1(?=\/|$)/, '')

    targetBase.pathname = `${targetBase.pathname.replace(/\/+$/, '')}${sourcePath}`
    targetBase.search = source.search
    return targetBase.toString()
  }

  private normalizeEndpoint(resourceUrl: string): URL {
    const normalizedUrl = resourceUrl.startsWith('http')
      ? resourceUrl
      : `https://${resourceUrl}`
    const endpoint = new URL(normalizedUrl)
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '')

    if (!endpoint.pathname.endsWith('/v1')) {
      endpoint.pathname = `${endpoint.pathname}/v1`.replace(/\/\//g, '/')
    }

    return endpoint
  }
}
