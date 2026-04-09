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

import { BaseLLMProvider } from './base'
import { MistralMessageAdapter } from './mistralMessageAdapter'
import { NoStainlessOpenAI } from './NoStainlessOpenAI'
import { ModelRequestPolicy, resolveSdkMaxRetries } from './requestPolicy'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createDesktopNodeFetch } from './sdkFetch'

export class MistralProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: MistralMessageAdapter
  private browserClient: NoStainlessOpenAI
  private obsidianClient: NoStainlessOpenAI
  private nodeClient: NoStainlessOpenAI
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
      requestPolicy?: ModelRequestPolicy
    },
  ) {
    super(provider)
    this.adapter = new MistralMessageAdapter()
    this.onAutoPromoteTransportMode = options?.onAutoPromoteTransportMode
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
    const clientOptions = {
      apiKey: provider.apiKey ?? '',
      baseURL: provider.baseUrl
        ? provider.baseUrl.replace(/\/+$/, '')
        : 'https://api.mistral.ai/v1',
      dangerouslyAllowBrowser: true,
      defaultHeaders,
      maxRetries: resolveSdkMaxRetries({
        requestPolicy: options?.requestPolicy,
        requestTransportMode: this.requestTransportMode,
      }),
      timeout: options?.requestPolicy?.timeoutMs,
    }
    this.browserClient = new NoStainlessOpenAI(clientOptions)
    this.obsidianClient = new NoStainlessOpenAI({
      ...clientOptions,
      fetch: createObsidianFetch(),
    })
    this.nodeClient = new NoStainlessOpenAI({
      ...clientOptions,
      fetch: createDesktopNodeFetch(),
    })
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    const mergedRequest = this.applyCustomModelParameters(model, request)

    return runWithRequestTransport({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      runBrowser: () =>
        this.adapter.generateResponse(
          this.browserClient,
          mergedRequest,
          options,
        ),
      runObsidian: () =>
        this.adapter.generateResponse(
          this.obsidianClient,
          mergedRequest,
          options,
        ),
      runNode: () =>
        this.adapter.generateResponse(this.nodeClient, mergedRequest, options),
    })
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    const mergedRequest = this.applyCustomModelParameters(model, request)

    return runWithRequestTransportForStream({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      signal: options?.signal,
      createBrowserStream: (signal) =>
        this.adapter.streamResponse(this.browserClient, mergedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
      createObsidianStream: (signal) =>
        this.adapter.streamResponse(this.obsidianClient, mergedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
      createNodeStream: (signal) =>
        this.adapter.streamResponse(this.nodeClient, mergedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
    })
  }

  getEmbedding(_model: string, _text: string): Promise<number[]> {
    return Promise.reject(
      new Error(
        `Provider ${this.provider.id} does not support embeddings. Please use a different provider.`,
      ),
    )
  }
}
