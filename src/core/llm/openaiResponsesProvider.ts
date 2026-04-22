import OpenAI from 'openai'
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'

import { ChatModel } from '../../types/chat-model.types'
import { REASONING_META, resolveRequestReasoningLevel } from '../../types/reasoning'
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
import { getHostedToolsForModel } from '../../utils/llm/model-tools'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { resolveProviderBaseUrl } from '../../utils/llm/provider-base-url'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'

import { BaseLLMProvider } from './base'
import { ChatGPTOAuthResponsesAdapter } from './chatgptOAuthResponsesAdapter'
import { extractEmbeddingVector } from './embedding-utils'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMRateLimitExceededException,
} from './exception'
import { ModelRequestPolicy, resolveSdkMaxRetries } from './requestPolicy'
import {
  AutoPromotedTransportMode,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
} from './requestTransport'
import { createDesktopNodeFetch } from './sdkFetch'

export class OpenAIResponsesProvider extends BaseLLMProvider<LLMProvider> {
  private readonly adapter = new ChatGPTOAuthResponsesAdapter()
  private readonly browserClient: OpenAI
  private readonly obsidianClient: OpenAI
  private readonly nodeClient: OpenAI
  private requestTransportMode: RequestTransportMode
  private readonly requestTransportMemoryKey: string
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

  private applyReasoningEffort(
    model: ChatModel,
    request: LLMRequestNonStreaming,
  ): LLMRequestNonStreaming
  private applyReasoningEffort(
    model: ChatModel,
    request: LLMRequestStreaming,
  ): LLMRequestStreaming
  private applyReasoningEffort(
    model: ChatModel,
    request: LLMRequestNonStreaming | LLMRequestStreaming,
  ): LLMRequestNonStreaming | LLMRequestStreaming {
    const level = resolveRequestReasoningLevel(model, request.reasoningLevel)
    if (level === undefined || level === 'auto' || request.reasoning_effort) {
      return request
    }
    const reasoning_effort =
      level === 'off'
        ? 'low'
        : (REASONING_META[level].effort as LLMRequestNonStreaming['reasoning_effort'])
    return {
      ...request,
      reasoning_effort,
    }
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

  private mergeHostedTools(
    model: ChatModel,
    body: ResponseCreateParamsStreaming,
  ): ResponseCreateParamsStreaming {
    const hostedTools = getHostedToolsForModel(model)
    if (hostedTools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: [
        ...(body.tools ?? []),
        ...hostedTools.map(() => ({ type: 'web_search_preview' as const })),
      ],
    }
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

    try {
      const body = this.mergeHostedTools(
        model,
        this.adapter.buildRequest(
          this.applyCustomModelParameters(model, {
            ...this.applyReasoningEffort(model, request),
            stream: false,
          }),
        ) as ResponseCreateParamsStreaming,
      )

      const response = await runWithRequestTransport({
        mode: this.requestTransportMode,
        memoryKey: this.requestTransportMemoryKey,
        onAutoPromoteTransportMode: this.promoteTransportMode,
        runBrowser: () =>
          this.browserClient.responses.create(body as never, {
            signal: options?.signal,
          }) as Promise<Response>,
        runObsidian: () =>
          this.obsidianClient.responses.create(body as never, {
            signal: options?.signal,
          }) as Promise<Response>,
        runNode: () =>
          this.nodeClient.responses.create(body as never, {
            signal: options?.signal,
          }) as Promise<Response>,
      })
      return this.adapter.parseResponse(response)
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) {
        throw new LLMAPIKeyInvalidException(
          'OpenAI API key is invalid. Please update it in settings menu.',
          error,
        )
      }
      throw error
    }
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

    const body = this.mergeHostedTools(
      model,
      this.adapter.buildRequest(
        this.applyCustomModelParameters(
          model,
          this.applyReasoningEffort(model, request),
        ),
      ) as ResponseCreateParamsStreaming,
    )

    const stream = await runWithRequestTransportForStream({
      mode: this.requestTransportMode,
      memoryKey: this.requestTransportMemoryKey,
      onAutoPromoteTransportMode: this.promoteTransportMode,
      signal: options?.signal,
      createBrowserStream: (signal) =>
        this.browserClient.responses.create(body, {
          signal: signal ?? options?.signal,
        }) as Promise<AsyncIterable<ResponseStreamEvent>>,
      createObsidianStream: (signal) =>
        this.obsidianClient.responses.create(body, {
          signal: signal ?? options?.signal,
        }) as Promise<AsyncIterable<ResponseStreamEvent>>,
      createNodeStream: (signal) =>
        this.nodeClient.responses.create(body, {
          signal: signal ?? options?.signal,
        }) as Promise<AsyncIterable<ResponseStreamEvent>>,
    })
    const adapter = this.adapter

    return {
      async *[Symbol.asyncIterator]() {
        const state = adapter.createStreamState()
        for await (const event of stream) {
          yield* adapter.parseStreamEvent(event, state)
        }
      },
    }
  }

  async getEmbedding(
    model: string,
    text: string,
    options?: { dimensions?: number },
  ): Promise<number[]> {
    if (!this.browserClient.apiKey) {
      throw new LLMAPIKeyNotSetException(
        `Provider ${this.provider.id} API key is missing. Please set it in settings menu.`,
      )
    }

    const dimensionsParam = options?.dimensions
      ? { dimensions: options.dimensions }
      : {}
    try {
      const embedding = await runWithRequestTransport({
        mode: this.requestTransportMode,
        memoryKey: this.requestTransportMemoryKey,
        onAutoPromoteTransportMode: this.promoteTransportMode,
        runBrowser: () =>
          this.browserClient.embeddings.create({
            model,
            input: text,
            ...dimensionsParam,
          }),
        runObsidian: () =>
          this.obsidianClient.embeddings.create({
            model,
            input: text,
            ...dimensionsParam,
          }),
        runNode: () =>
          this.nodeClient.embeddings.create({
            model,
            input: text,
            ...dimensionsParam,
          }),
      })
      return extractEmbeddingVector(embedding)
    } catch (error) {
      if ((error as { status?: number }).status === 429) {
        throw new LLMRateLimitExceededException(
          'OpenAI API rate limit exceeded. Please try again later.',
        )
      }
      throw error
    }
  }
}
