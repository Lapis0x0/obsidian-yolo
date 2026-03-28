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
import { NoStainlessOpenAI } from './NoStainlessOpenAI'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createDesktopNodeFetch } from './sdkFetch'

export class MorphProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: OpenAIMessageAdapter
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
    },
  ) {
    super(provider)
    this.adapter = new OpenAIMessageAdapter()
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
      baseURL: `${provider.baseUrl ? provider.baseUrl.replace(/\/+$/, '') : 'https://api.morphllm.com'}/v1`,
      apiKey: provider.apiKey ?? '',
      dangerouslyAllowBrowser: true,
      defaultHeaders,
      maxRetries: this.requestTransportMode === 'auto' ? 0 : undefined,
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
    let formattedRequest = {
      ...request,
      prediction: undefined, // morph doesn't support prediction
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
    let formattedRequest = {
      ...request,
      prediction: undefined, // morph doesn't support prediction
    }

    formattedRequest = this.applyCustomModelParameters(model, formattedRequest)

    return runWithRequestTransportForStream({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      signal: options?.signal,
      createBrowserStream: (signal) =>
        this.adapter.streamResponse(this.browserClient, formattedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
      createObsidianStream: (signal) =>
        this.adapter.streamResponse(this.obsidianClient, formattedRequest, {
          ...options,
          signal: signal ?? options?.signal,
        }),
      createNodeStream: (signal) =>
        this.adapter.streamResponse(this.nodeClient, formattedRequest, {
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
