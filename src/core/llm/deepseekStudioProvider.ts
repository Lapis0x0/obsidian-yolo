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
import { resolveRequestReasoningLevel } from '../../types/reasoning'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { resolveProviderBaseUrl } from '../../utils/llm/provider-base-url'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'
import { formatMessages } from '../../utils/llm/request'

import { BaseLLMProvider } from './base'
import { applyDeepSeekCapabilities } from './deepseekCapabilities'
import { DeepSeekMessageAdapter } from './deepseekMessageAdapter'
import { LLMAPIKeyNotSetException } from './exception'
import { ModelRequestPolicy, resolveSdkMaxRetries } from './requestPolicy'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createDesktopNodeFetch } from './sdkFetch'

// deepseek doesn't support image
export class DeepSeekStudioProvider extends BaseLLMProvider<LLMProvider> {
  private adapter: DeepSeekMessageAdapter
  private browserClient: OpenAI
  private obsidianClient: OpenAI
  private nodeClient: OpenAI
  private requestTransportMode: RequestTransportMode
  private requestTransportMemoryKey: string
  private onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void

  private promoteTransportMode = (mode: AutoPromotedTransportMode) => {
    if (this.requestTransportMode === mode) return
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
    this.adapter = new DeepSeekMessageAdapter()
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
      baseURL: resolveProviderBaseUrl(provider),
      dangerouslyAllowBrowser: true,
      defaultHeaders,
      maxRetries: resolveSdkMaxRetries({
        requestPolicy: options?.requestPolicy,
        requestTransportMode: this.requestTransportMode,
      }),
      timeout: options?.requestPolicy?.timeoutMs,
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
    if (!this.browserClient.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    let formattedRequest: typeof request & Record<string, unknown> = {
      ...request,
      messages: formatMessages(request.messages),
    }

    applyDeepSeekCapabilities({
      request: formattedRequest,
      model,
      reasoningLevel: resolveRequestReasoningLevel(
        model,
        request.reasoningLevel,
      ),
    })

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
    if (!this.browserClient.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    let formattedRequest: typeof request & Record<string, unknown> = {
      ...request,
      messages: formatMessages(request.messages),
    }

    applyDeepSeekCapabilities({
      request: formattedRequest,
      model,
      reasoningLevel: resolveRequestReasoningLevel(
        model,
        request.reasoningLevel,
      ),
    })

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

  getEmbedding(
    _model: string,
    _text: string,
    _options?: { dimensions?: number },
  ): Promise<number[]> {
    return Promise.reject(
      new Error(
        `Provider ${this.provider.id} does not support embeddings. Please use a different provider.`,
      ),
    )
  }
}
