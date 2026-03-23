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
import { LLMProvider, RequestTransportMode } from '../../types/provider.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'

import { BaseLLMProvider } from './base'
import { extractEmbeddingVector } from './embedding-utils'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createDesktopNodeFetch } from './sdkFetch'

export class LmStudioProvider extends BaseLLMProvider<LLMProvider> {
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
      apiKey: provider.apiKey ?? '',
      baseURL: `${provider.baseUrl ? provider.baseUrl.replace(/\/+$/, '') : 'http://127.0.0.1:1234'}/v1`,
      dangerouslyAllowBrowser: true,
      defaultHeaders,
      maxRetries: this.requestTransportMode === 'auto' ? 0 : undefined,
    }
    this.browserClient = new OpenAI(clientOptions)
    this.obsidianClient = new OpenAI({
      ...clientOptions,
      fetch: createObsidianFetch(),
    })
    this.nodeClient = new OpenAI({
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
        this.adapter.generateResponse(this.browserClient, mergedRequest, options),
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
      createBrowserStream: () =>
        this.adapter.streamResponse(this.browserClient, mergedRequest, options),
      createObsidianStream: () =>
        this.adapter.streamResponse(this.obsidianClient, mergedRequest, options),
      createNodeStream: () =>
        this.adapter.streamResponse(this.nodeClient, mergedRequest, options),
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
    return extractEmbeddingVector(embedding)
  }
}
