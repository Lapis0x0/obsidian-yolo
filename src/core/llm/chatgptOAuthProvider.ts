import OpenAI from 'openai'
import type {
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
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'
import { getChatGPTOAuthService } from '../auth/chatgptOAuthRuntime'

import { BaseLLMProvider } from './base'
import { ChatGPTOAuthResponsesAdapter } from './chatgptOAuthResponsesAdapter'
import { LLMProviderNotConfiguredException } from './exception'
import { NoStainlessOpenAI } from './NoStainlessOpenAI'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import { ModelRequestPolicy, resolveSdkMaxRetries } from './requestPolicy'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createDesktopNodeFetch } from './sdkFetch'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const OAUTH_PROVIDER_API_KEY = 'chatgpt-oauth'

export class ChatGPTOAuthProvider extends BaseLLMProvider<LLMProvider> {
  private readonly adapter = new ChatGPTOAuthResponsesAdapter()
  private readonly chatAdapter = new OpenAIMessageAdapter()
  private readonly browserClient: OpenAI
  private readonly obsidianClient: OpenAI
  private readonly nodeClient: OpenAI
  private readonly requestTransportMemoryKey: string
  private requestTransportMode: RequestTransportMode
  private readonly onAutoPromoteTransportMode?: (
    mode: AutoPromotedTransportMode,
  ) => void

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
      requestPolicy?: ModelRequestPolicy
    },
  ) {
    super(provider)
    this.onAutoPromoteTransportMode = options?.onAutoPromoteTransportMode
    this.requestTransportMemoryKey = createRequestTransportMemoryKey({
      providerType: provider.presetType,
      providerId: provider.id,
      baseUrl: CODEX_BASE_URL,
    })
    this.requestTransportMode =
      provider.additionalSettings?.requestTransportMode === undefined
        ? 'auto'
        : resolveRequestTransportMode({
            additionalSettings: provider.additionalSettings,
            hasCustomBaseUrl: true,
            memoryKey: this.requestTransportMemoryKey,
          })

    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    const createClient = (customFetch: typeof fetch) =>
      new NoStainlessOpenAI({
        apiKey: OAUTH_PROVIDER_API_KEY,
        baseURL: CODEX_BASE_URL,
        dangerouslyAllowBrowser: true,
        maxRetries: resolveSdkMaxRetries({
          requestPolicy: options?.requestPolicy,
          requestTransportMode: this.requestTransportMode,
        }),
        timeout: options?.requestPolicy?.timeoutMs,
        defaultHeaders,
        fetch: this.createAuthorizedFetch(customFetch),
      })

    this.browserClient = createClient(globalThis.fetch)
    this.obsidianClient = createClient(createObsidianFetch())
    this.nodeClient = createClient(createDesktopNodeFetch())
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    let formattedRequest = request
    if (model.reasoning?.enabled && !formattedRequest.reasoning_effort) {
      formattedRequest = {
        ...formattedRequest,
        reasoning_effort: model.reasoning.reasoning_effort as
          | LLMRequestNonStreaming['reasoning_effort']
          | undefined,
      }
    }

    const body = this.adapter.buildRequest(
      this.applyCustomModelParameters(model, {
        ...formattedRequest,
        stream: true,
      }),
    ) as ResponseCreateParamsStreaming

    return runWithRequestTransport({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      runBrowser: async () =>
        this.generateResponseWithFallback(
          this.browserClient,
          body,
          formattedRequest,
          options,
        ),
      runObsidian: async () =>
        this.generateResponseWithFallback(
          this.obsidianClient,
          body,
          formattedRequest,
          options,
        ),
      runNode: async () =>
        this.generateResponseWithFallback(
          this.nodeClient,
          body,
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
    let formattedRequest = request
    if (model.reasoning?.enabled && !formattedRequest.reasoning_effort) {
      formattedRequest = {
        ...formattedRequest,
        reasoning_effort: model.reasoning.reasoning_effort as
          | LLMRequestStreaming['reasoning_effort']
          | undefined,
      }
    }

    const body = this.adapter.buildRequest(
      this.applyCustomModelParameters(model, formattedRequest),
    ) as ResponseCreateParamsStreaming

    return runWithRequestTransportForStream({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      signal: options?.signal,
      createBrowserStream: async (signal) =>
        this.streamResponseWithFallback(
          this.browserClient,
          body,
          formattedRequest,
          { ...options, signal: signal ?? options?.signal },
        ),
      createObsidianStream: async (signal) =>
        this.streamResponseWithFallback(
          this.obsidianClient,
          body,
          formattedRequest,
          { ...options, signal: signal ?? options?.signal },
        ),
      createNodeStream: async (signal) =>
        this.streamResponseWithFallback(
          this.nodeClient,
          body,
          formattedRequest,
          { ...options, signal: signal ?? options?.signal },
        ),
    })
  }

  async getEmbedding(_model: string, _text: string): Promise<number[]> {
    throw new LLMProviderNotConfiguredException(
      'ChatGPT OAuth provider does not support embeddings.',
    )
  }

  private createAuthorizedFetch(baseFetch: typeof fetch): typeof fetch {
    return async (input, init) => {
      const service = getChatGPTOAuthService(this.provider.id)
      if (!service) {
        throw new LLMProviderNotConfiguredException(
          'ChatGPT OAuth service is not initialized.',
        )
      }

      const credential = await service.getUsableCredential()
      if (!credential) {
        throw new LLMProviderNotConfiguredException(
          'ChatGPT OAuth is not logged in. Please connect your account in settings.',
        )
      }

      const target = this.rewriteCodexUrl(input)
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      headers.set('Authorization', `Bearer ${credential.accessToken}`)
      headers.set('originator', 'opencode')

      if (credential.accountId) {
        headers.set('ChatGPT-Account-Id', credential.accountId)
      }

      return baseFetch(target, {
        ...init,
        headers,
      })
    }
  }

  private rewriteCodexUrl(input: RequestInfo | URL): string | Request {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : input
    const parsed = new URL(url)
    if (
      parsed.pathname.includes('/v1/responses') ||
      parsed.pathname.includes('/chat/completions') ||
      parsed.pathname.endsWith('/responses')
    ) {
      return CODEX_API_ENDPOINT
    }
    return input instanceof Request ? new Request(url, input) : url
  }

  private isBadRequest(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status?: unknown }).status === 400
    )
  }

  private async generateResponseWithFallback(
    client: OpenAI,
    body: ResponseCreateParamsStreaming,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    try {
      return await this.collectResponseFromStream(
        (await client.responses.create(body, {
          signal: options?.signal,
        })) as AsyncIterable<ResponseStreamEvent>,
      )
    } catch (error) {
      if (!this.isBadRequest(error)) {
        throw error
      }
      return this.chatAdapter.generateResponse(client, request, options)
    }
  }

  private async streamResponseWithFallback(
    client: OpenAI,
    body: ResponseCreateParamsStreaming,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    try {
      return await this.toStream(
        (await client.responses.create(body, {
          signal: options?.signal,
        })) as AsyncIterable<ResponseStreamEvent>,
      )
    } catch (error) {
      if (!this.isBadRequest(error)) {
        throw error
      }
      return this.chatAdapter.streamResponse(client, request, options)
    }
  }

  private async toStream(
    stream: AsyncIterable<ResponseStreamEvent>,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    if (!(Symbol.asyncIterator in Object(stream))) {
      throw new Error('Expected a streaming ChatGPT OAuth response')
    }

    const adapter = this.adapter
    const state = adapter.createStreamState()

    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of stream) {
          yield* adapter.parseStreamEvent(event, state)
        }
      },
    }
  }

  private async collectResponseFromStream(
    stream: AsyncIterable<ResponseStreamEvent>,
  ): Promise<LLMResponseNonStreaming> {
    for await (const event of stream) {
      if (event.type === 'response.completed') {
        return this.adapter.parseResponse(event.response)
      }

      if (event.type === 'response.incomplete') {
        return this.adapter.parseResponse(event.response)
      }

      if (event.type === 'response.failed') {
        throw new Error(
          event.response.error?.message ?? 'ChatGPT OAuth response failed',
        )
      }

      if (event.type === 'error') {
        throw new Error(event.message)
      }
    }

    throw new Error('ChatGPT OAuth stream ended without a completed response')
  }
}
