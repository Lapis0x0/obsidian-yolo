import OpenAI from 'openai'
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'

import { getChatGPTOAuthService } from '../auth/chatgptOAuthRuntime'
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
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'

import { BaseLLMProvider } from './base'
import { LLMProviderNotConfiguredException } from './exception'
import { NoStainlessOpenAI } from './NoStainlessOpenAI'
import {
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { ChatGPTOAuthResponsesAdapter } from './chatgptOAuthResponsesAdapter'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const OAUTH_PROVIDER_API_KEY = 'chatgpt-oauth'
const REQUEST_TRANSPORT_MODES = new Set(['auto', 'browser', 'obsidian'])

type RequestTransportMode = 'auto' | 'browser' | 'obsidian'

export class ChatGPTOAuthProvider extends BaseLLMProvider<
  Extract<LLMProvider, { type: 'chatgpt-oauth' }>
> {
  private readonly adapter = new ChatGPTOAuthResponsesAdapter()
  private readonly browserClient: OpenAI
  private readonly obsidianClient: OpenAI
  private readonly requestTransportMode: RequestTransportMode
  private readonly requestTransportMemoryKey: string

  constructor(provider: Extract<LLMProvider, { type: 'chatgpt-oauth' }>) {
    super(provider)
    this.requestTransportMemoryKey = createRequestTransportMemoryKey({
      providerType: provider.type,
      providerId: provider.id,
      baseUrl: CODEX_BASE_URL,
    })
    this.requestTransportMode = resolveRequestTransportMode({
      additionalSettings: {
        requestTransportMode: REQUEST_TRANSPORT_MODES.has(
          provider.additionalSettings?.requestTransportMode ?? '',
        )
          ? (provider.additionalSettings
              ?.requestTransportMode as RequestTransportMode)
          : 'auto',
      },
      hasCustomBaseUrl: true,
      memoryKey: this.requestTransportMemoryKey,
    })

    const defaultHeaders = toProviderHeadersRecord(provider.customHeaders)
    const createClient = (customFetch: typeof fetch) =>
      new NoStainlessOpenAI({
        apiKey: OAUTH_PROVIDER_API_KEY,
        baseURL: CODEX_BASE_URL,
        dangerouslyAllowBrowser: true,
        maxRetries: this.requestTransportMode === 'auto' ? 0 : undefined,
        defaultHeaders,
        fetch: this.createAuthorizedFetch(customFetch),
      })

    this.browserClient = createClient(fetch)
    this.obsidianClient = createClient(createObsidianFetch())
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    if (model.providerType !== 'chatgpt-oauth') {
      throw new Error('Model is not a ChatGPT OAuth model')
    }

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
      this.applyCustomModelParameters(model, formattedRequest),
    ) as ResponseCreateParamsNonStreaming

    return runWithRequestTransport({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      runBrowser: async () =>
        this.adapter.parseResponse(
          (await this.browserClient.responses.create(body, {
            signal: options?.signal,
          })) as Response,
        ),
      runObsidian: async () =>
        this.adapter.parseResponse(
          (await this.obsidianClient.responses.create(body, {
            signal: options?.signal,
          })) as Response,
        ),
    })
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    if (model.providerType !== 'chatgpt-oauth') {
      throw new Error('Model is not a ChatGPT OAuth model')
    }

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
      createBrowserStream: async () =>
        this.toStream(
          (await this.browserClient.responses.create(body, {
            signal: options?.signal,
          })) as AsyncIterable<ResponseStreamEvent>,
        ),
      createObsidianStream: async () =>
        this.toStream(
          (await this.obsidianClient.responses.create(body, {
            signal: options?.signal,
          })) as AsyncIterable<ResponseStreamEvent>,
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
      const service = getChatGPTOAuthService()
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

      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      headers.set('Authorization', `Bearer ${credential.accessToken}`)
      headers.set('originator', 'obsidian-yolo')

      if (credential.accountId) {
        headers.set('ChatGPT-Account-Id', credential.accountId)
      }

      return baseFetch(input, {
        ...init,
        headers,
      })
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
}
