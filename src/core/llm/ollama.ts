/**
 * This provider is nearly identical to OpenAICompatibleProvider, but uses a custom OpenAI client
 * (NoStainlessOpenAI) to work around CORS issues specific to Ollama.
 */

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

export class OllamaProvider extends BaseLLMProvider<LLMProvider> {
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
      baseURL: `${provider.baseUrl ? provider.baseUrl.replace(/\/+$/, '') : 'http://127.0.0.1:11434'}/v1`,
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
      runNode: () =>
        this.nodeClient.embeddings.create({
          model: model,
          input: text,
          encoding_format: 'float',
        }),
    })
    return embedding.data[0].embedding
  }
}
